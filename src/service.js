import { randomUUID, createHash } from 'node:crypto';
import { realpath, stat, lstat, mkdir, chmod, open, readdir, unlink, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { isCodexTui, readPresence, originPort } from './presence.js';
import { UpstreamError } from './rpc.js';
import { codexInputState, claudeInputState, codexUsage } from './codex-input.js';
import { ClaudeReader, isClaudeProcess, claudeMatch, claudeThread } from './claude.js';

export class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 64_000_000;
const PNG_END = Buffer.from('0000000049454e44ae426082', 'hex');
const IMAGE_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const IMAGE_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg|webp|gif)$/;

function pngChunksComplete(bytes) {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const end = offset + length + 12;
        if (end > bytes.length) return false;
        if (bytes.toString('latin1', offset + 4, offset + 8) === 'IEND') {
            return length === 0 && end === bytes.length && bytes.subarray(offset, end).equals(PNG_END);
        }
        offset = end;
    }
    return false;
}

function gifBlocksComplete(bytes) {
    if (bytes.length < 13) return false;
    const colorTableSize = packed => packed & 0x80 ? 3 * (2 << (packed & 7)) : 0;
    let offset = 13 + colorTableSize(bytes[10]);
    while (offset < bytes.length) {
        const block = bytes[offset++];
        if (block === 0x3b) return offset === bytes.length;
        if (block === 0x21) {
            if (offset >= bytes.length) return false;
            offset++; // Extension label; the following size byte starts its sub-blocks.
        } else if (block === 0x2c) {
            if (offset + 9 > bytes.length) return false;
            const packed = bytes[offset + 8];
            offset += 9 + colorTableSize(packed);
            if (offset >= bytes.length) return false;
            offset++; // LZW minimum code size precedes the image data sub-blocks.
        } else return false;
        while (true) {
            if (offset >= bytes.length) return false;
            const length = bytes[offset++];
            offset += length;
            if (offset > bytes.length) return false;
            if (length === 0) break;
        }
    }
    return false;
}

async function imageExtension(bytes, contentType) {
    const type = contentType?.split(';')[0].trim();
    let extension;
    if (type === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
    if (type === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) extension = 'jpg';
    if (type === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
    if (type === 'image/gif' && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) extension = 'gif';
    if (extension) {
        try {
            const image = sharp(bytes, { animated: true, failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS });
            const metadata = await image.metadata();
            if (metadata.mediaType !== type) throw new Error('Image MIME mismatch');
            if (extension === 'png' && !pngChunksComplete(bytes)) throw new Error('Incomplete PNG chunks');
            if (extension === 'gif' && !gifBlocksComplete(bytes)) throw new Error('Incomplete GIF blocks');
            await image.raw().toBuffer();
            return extension;
        } catch {
            throw new HttpError(415, '画像の破損と、6,400万画素以下かを確認してください。GIFとWebPは全フレームの合計です。');
        }
    }
    throw new HttpError(415, 'PNG、JPEG、WebP、GIFの画像を選んでください。画像の形式も確認してください。');
}

export function requireString(value, max = 200) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
        throw new HttpError(400, '入力の形式または長さを確認してください。');
    }
    return value;
}

function requireOperationId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw new HttpError(400, '操作IDが不正です。');
}

function samePane(expected, pane) {
    return ['pane_id', 'terminal_id', 'tab_id', 'workspace_id'].every(key => expected[key] && expected[key] === pane?.[key]);
}

function processFingerprint(pane, process, owner) {
    return JSON.stringify({
        owner, pane: pane.pane_id, terminal: pane.terminal_id, tab: pane.tab_id, workspace: pane.workspace_id,
        shell: process.shell_pid, group: process.foreground_process_group_id,
        processes: (process.foreground_processes || []).map(p => [p.pid, p.name, p.argv0, p.argv, p.cwd]).sort((a, b) => a[0] - b[0]),
    });
}

function uncertain(message) {
    return Object.assign(new Error(message), { uncertain: true });
}

async function directoryPath(value) {
    requireString(value, 4096);
    if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) throw new HttpError(400, 'パスに制御文字を使用できません。');
    const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
    if (!isAbsolute(expanded)) throw new HttpError(400, 'PCの絶対パスか~/で始まるパスを入力してください。');
    try {
        const path = await realpath(expanded);
        if (!(await stat(path)).isDirectory()) throw new Error();
        return path;
    } catch { throw new HttpError(400, 'PCにあるディレクトリのパスを入力してください。'); }
}

function isInternal(thread) {
    return thread.parentThreadId || thread.threadSource === 'subagent'
        || (typeof thread.source === 'object' && thread.source !== null && 'subAgent' in thread.source)
        || (typeof thread.source === 'string' && thread.source.toLowerCase().startsWith('subagent'));
}

async function boundedMap(values, action) {
    const results = [];
    for (let offset = 0; offset < values.length; offset += 8) {
        results.push(...await Promise.all(values.slice(offset, offset + 8).map(action)));
    }
    return results;
}

function currentStatus(thread, loaded, panes) {
    const daemon = loaded ? thread.status : null;
    const statuses = panes.filter(pane => pane.threadId === thread.id).map(pane => pane.agent_status || 'unknown');
    const flags = new Set(daemon?.type === 'active' ? daemon.activeFlags : []);
    if (statuses.includes('blocked')) flags.add('waitingOnApprovalOrInput');
    if (flags.size || daemon?.type === 'active' || statuses.includes('working')) return { type: 'active', activeFlags: [...flags] };
    if (statuses.some(status => !['idle', 'done'].includes(status))) return { type: 'unknown' };
    if (loaded) return daemon || { type: 'unknown' };
    return { type: statuses.length ? 'idle' : 'unknown' };
}

function summary(thread, sources) {
    return {
        id: thread.id, provider: thread.provider || 'codex', title: thread.name || thread.preview?.slice(0, 70) || '名前のない会話',
        preview: thread.preview || '', cwd: thread.cwd || '', updatedAt: thread.updatedAt,
        status: currentStatus(thread, sources.loaded.has(thread.id), sources.panes),
    };
}

function textContent(input = []) {
    return input.map(part => part.type === 'text' ? part.text : ['image', 'localImage'].includes(part.type) ? '[画像]' : `[${part.type}]`).join('\n');
}

const QUESTION_REPLY_OPEN = '<send_user_message_question_reply>';
const QUESTION_REPLY_CLOSE = '</send_user_message_question_reply>';

function parseQuestionReplies(input = []) {
    const content = input.filter(item => !['skill', 'mention'].includes(item.type));
    if (content.length !== 1 || content[0].type !== 'text') return null;
    let text = content[0].text.trim();
    if (text.startsWith('# Context from my IDE setup:\n')) {
        const delimiter = '\n## My request for Codex:\n';
        const offset = text.lastIndexOf(delimiter);
        if (offset < 0) return null;
        text = text.slice(offset + delimiter.length).trim();
    }
    if (!text.startsWith(QUESTION_REPLY_OPEN) || !text.endsWith(QUESTION_REPLY_CLOSE)) return null;
    try {
        const parsed = JSON.parse(text.slice(QUESTION_REPLY_OPEN.length, -QUESTION_REPLY_CLOSE.length));
        const replies = Array.isArray(parsed) ? parsed : [parsed];
        return replies.length && replies.every(reply => reply && ['questionItemId', 'question', 'answer'].every(key => typeof reply[key] === 'string' && reply[key].isWellFormed())) ? replies : null;
    } catch { return null; }
}

function questionId(itemId, index) {
    return JSON.stringify(['request_user_input_async', itemId, index]);
}

function questionReply(question, answer) {
    let title = '', length = 0;
    for (const char of question.title) {
        length += Buffer.byteLength(char);
        if (length > 512) break;
        title += char;
    }
    return `${QUESTION_REPLY_OPEN}\n${JSON.stringify([{ answer, question: title.replace(/[\r\n]/g, ' '), questionItemId: question.questionItemId }])}\n${QUESTION_REPLY_CLOSE}`;
}

function itemQuestions(item) {
    return item.type === 'agentMessage' && Array.isArray(item.questions) ? item.questions : [];
}

function pendingQuestions(turns, queue, activeTurnId) {
    const answered = new Set();
    for (const input of [...turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage').map(item => item.content)), ...queue.map(item => item.input)]) {
        for (const reply of parseQuestionReplies(input) || []) answered.add(reply.questionItemId);
    }
    const turn = turns.find(turn => turn.id === activeTurnId);
    const questions = turn ? turn.items.flatMap(item => itemQuestions(item).map((question, index) => ({
        ...question, turnId: turn.id, itemId: item.id, index, questionItemId: questionId(item.id, index),
    }))).filter(question => !answered.has(question.questionItemId) && !answered.has(question.itemId)) : [];
    return { questions, answered };
}

function projectQueue(queue) {
    return queue.map(item => ({ id: item.id, clientUserMessageId: item.clientUserMessageId,
        text: parseQuestionReplies(item.input)?.map(reply => `質問: ${reply.question}\n\n回答: ${reply.answer}`).join('\n\n') ?? textContent(item.input) }));
}

function projectItem(item) {
    const base = { id: item.id, type: item.type };
    switch (item.type) {
        case 'reasoning': return null;
        case 'userMessage': {
            const replies = parseQuestionReplies(item.content);
            return { ...base, text: replies ? replies.map(reply => `質問: ${reply.question}\n\n回答: ${reply.answer}`).join('\n\n') : textContent(item.content) };
        }
        case 'agentMessage': return { ...base, text: item.text || '', questions: itemQuestions(item) };
        case 'plan': return { ...base, text: item.text || '' };
        case 'commandExecution': return { ...base, label: item.command, status: item.status, text: item.aggregatedOutput || '' };
        case 'fileChange': return { ...base, label: 'ファイルの変更', status: item.status, text: JSON.stringify(item.changes, null, 2) };
        case 'mcpToolCall': return { ...base, label: `${item.server} / ${item.tool}`, status: item.status, text: JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error }, null, 2) };
        case 'dynamicToolCall': return { ...base, label: item.tool, status: item.status, text: JSON.stringify(item.contentItems || item.arguments, null, 2) };
        case 'functionCallOutput': return { ...base, label: item.name, text: JSON.stringify(item.output, null, 2) };
        case 'webSearch': return { ...base, label: 'Web検索', text: item.query || JSON.stringify(item.action || {}) };
        default: return { ...base, label: item.type, text: 'この項目の詳細はPCで確認できます。' };
    }
}

export class MonitorService {
    constructor(codex, herdr, presence = readPresence, claude = new ClaudeReader(), { imageDir = join(homedir(), '.local/share/agent-monitor/images'), now = Date.now } = {}) {
        this.codex = codex;
        this.herdr = herdr;
        this.presence = presence;
        this.claude = claude;
        this.known = new Map();
        this.operations = new Map();
        this.bindings = new Map();
        this.launches = new Map();
        this.creationQueue = Promise.resolve();
        this.inputPanes = new Set();
        this.questionReservations = new Map();
        this.imageDir = imageDir;
        this.now = now;
        this.images = new Map();
    }

    async imageDirectory() {
        await mkdir(this.imageDir, { recursive: true, mode: 0o700 });
        if (!(await lstat(this.imageDir)).isDirectory()) throw new HttpError(500, '画像の保存先を確認してください。');
        await chmod(this.imageDir, 0o700);
        const path = await realpath(this.imageDir);
        if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(path)) throw new HttpError(500, '画像の保存先に制御文字を使用できません。');
        return path;
    }

    async cleanImages(directory) {
        const names = await readdir(directory);
        for (const name of names) {
            if (!IMAGE_FILE.test(name)) continue;
            const path = join(directory, name);
            const image = this.images.get(name.slice(0, 36));
            let info;
            try { info = await lstat(path); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!info.isFile() || info.mtimeMs + IMAGE_LIFETIME > this.now() || image?.holds.size || image?.deleting) continue;
            if (image) image.deleting = true;
            try {
                await unlink(path);
                this.images.delete(name.slice(0, 36));
            } catch (error) {
                if (image) image.deleting = false;
                if (error.code !== 'ENOENT') throw error;
            }
        }
    }

    async uploadImage(id, bytes, contentType) {
        await this.thread(id);
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, '画像は10MiB以下のファイルを選んでください。');
        const extension = await imageExtension(bytes, contentType);
        const directory = await this.imageDirectory();
        await this.cleanImages(directory);
        const imageId = randomUUID();
        const path = join(directory, `${imageId}.${extension}`);
        const file = await open(path, 'wx', 0o600);
        try {
            await file.chmod(0o600);
            await file.writeFile(bytes);
            await file.utimes(new Date(this.now()), new Date(this.now()));
        } catch (error) {
            await unlink(path).catch(() => {});
            throw error;
        } finally { await file.close(); }
        const expiresAt = this.now() + IMAGE_LIFETIME;
        this.images.set(imageId, { threadId: id, path, expiresAt, holds: new Set() });
        return { imageId };
    }

    async prepareImage(id, imageId, requestId) {
        const image = this.images.get(imageId);
        if (!image || image.threadId !== id || image.deleting || image.expiresAt <= this.now()) {
            throw new HttpError(410, '画像の有効期限または会話を確認できません。画像を選び直してください。');
        }
        image.holds.add(requestId);
        try {
            const info = await lstat(image.path);
            if (!info.isFile() || !info.size || info.size > MAX_IMAGE_BYTES) throw new Error('Invalid image file');
            const now = this.now();
            await utimes(image.path, new Date(now), new Date(now));
            image.expiresAt = now + IMAGE_LIFETIME;
            return image;
        } catch {
            image.holds.delete(requestId);
            throw new HttpError(410, '保存した画像を確認できません。画像を選び直してください。');
        }
    }

    async pages(method, params = {}) {
        const data = [];
        const cursors = new Set();
        let cursor;
        do {
            const page = await this.codex.call(method, { ...params, cursor, limit: 100 });
            if (!Array.isArray(page.data)) throw new HttpError(502, 'Codexの一覧を読み取れません。');
            data.push(...page.data);
            cursor = page.nextCursor;
            if (cursor && (cursors.has(cursor) || cursors.size >= 1000)) throw new HttpError(502, '一覧のページを取得できません。');
            cursors.add(cursor);
        } while (cursor);
        return data;
    }

    async list() {
        const sources = await this.sources(true);
        const ids = [...new Set(sources.panes.map(pane => pane.threadId))];
        const threads = ids.map(id => summary(sources.threads.get(id), sources));
        this.known = new Map(threads.map(thread => [thread.id, thread]));
        return { threads, unresolvedCount: sources.unresolvedCount };
    }

    async notificationStates() {
        const sources = await this.sources(true);
        const ids = [...new Set(sources.panes.map(pane => pane.threadId))];
        const states = [];
        for (const id of ids) {
            const thread = summary(sources.threads.get(id), sources);
            this.known.set(id, thread);
            let state = { questions: [] };
            if (thread.provider !== 'claude' && sources.loaded.has(id) && thread.status.type === 'active') {
                try { state = await this.questionState(id, sources); }
                catch { state.questionsReady = false; }
            }
            states.push({ ...state, thread: { ...thread, title: sources.threads.get(id).name || '名前のない会話' } });
        }
        return states;
    }

    async sources(unsubscribe = false, { fresh = false } = {}) {
        const { panes } = await this.herdr.call('pane.list');
        if (!Array.isArray(panes)) throw new HttpError(502, 'Herdrの端末一覧を読み取れません。');
        const inspected = await boundedMap(panes, async pane => {
            const { process_info: process } = await this.herdr.call('pane.process_info', { pane_id: pane.pane_id });
            return { ...pane, process, tuis: (process?.foreground_processes || []).filter(isCodexTui) };
        });
        const currentPanes = inspected.filter(pane => pane.tuis.length);
        const claudePanes = inspected.filter(pane => (pane.process?.foreground_processes || []).some(isClaudeProcess));
        const sessions = claudePanes.length ? await this.claude.sessions({ fresh }) : [];
        const candidateClaude = claudePanes.map(pane => {
            const session = claudeMatch(pane, sessions);
            return session ? { ...pane, threadId: `claude:${session.sessionId}`, claudeSession: session } : null;
        }).filter(Boolean);
        const matchedClaude = candidateClaude.filter(pane => candidateClaude.filter(other => other.threadId === pane.threadId).length === 1);
        const ids = currentPanes.length ? await this.pages('thread/loaded/list') : [];
        if (unsubscribe) await boundedMap(ids, async threadId => {
            let result;
            try { result = await this.codex.call('thread/unsubscribe', { threadId }); }
            catch (error) {
                if (error.code === -32601) throw new HttpError(502, 'Codexがthread/unsubscribeに対応していないため、監視接続の購読を解除できません。');
                throw error;
            }
            if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result?.status)) {
                throw new HttpError(502, '監視接続の購読解除を確認できません。');
            }
        });
        const loaded = new Set(ids);
        const claudeThreads = matchedClaude.map(pane => claudeThread(pane.claudeSession));
        claudeThreads.forEach(thread => loaded.add(thread.id));
        let resources;
        try { resources = currentPanes.length ? await this.presence([...new Set(currentPanes.flatMap(pane => pane.tuis.map(process => process.pid)))]) : new Map(); }
        catch { throw new HttpError(502, 'Codexの現在のOS資源を確認できません。'); }
        if (!currentPanes.length) return { loaded, panes: matchedClaude, threads: new Map(claudeThreads.map(thread => [thread.id, thread])), claudeSessions: sessions, unresolvedCount: claudePanes.length - matchedClaude.length };
        const candidateIds = [...new Set([...ids, ...[...resources.values()].flatMap(resource => [...resource.threadIds])])];
        const candidates = await boundedMap(candidateIds, async id => {
            try {
                const { thread } = await this.codex.call('thread/read', { threadId: id, includeTurns: false });
                if (!thread || thread.id !== id || isInternal(thread)) return null;
                const ports = new Set();
                if (loaded.has(id)) {
                    const servers = await this.pages('mcpServerStatus/list', { threadId: id, serverName: 'codex_tui', detail: 'toolsAndAuthOnly' }).catch(error => {
                        if (!(error instanceof UpstreamError) || error.code === undefined) throw error;
                        return [];
                    });
                    for (const server of servers) {
                        const port = originPort(server.httpOrigin);
                        if (server.name === 'codex_tui' && port) ports.add(port);
                    }
                }
                return { thread, ports };
            } catch (error) {
                if (!(error instanceof UpstreamError) || error.code === undefined) throw error;
                return null;
            }
        });
        const threads = new Map([...candidates.filter(Boolean).map(candidate => [candidate.thread.id, candidate.thread]), ...claudeThreads.map(thread => [thread.id, thread])]);
        const matched = currentPanes.map(pane => {
            const matches = candidates.filter(Boolean).filter(({ thread, ports }) => pane.tuis.some(process => {
                const resource = resources.get(process.pid);
                return resource?.threadIds.has(thread.id) || [...ports].some(port => resource?.ports.has(port));
            }));
            return matches.length === 1 ? { ...pane, threadId: matches[0].thread.id } : null;
        }).filter(Boolean);
        return { loaded, panes: [...matched, ...matchedClaude], threads, claudeSessions: sessions, unresolvedCount: currentPanes.length - matched.length + claudePanes.length - matchedClaude.length };
    }

    async thread(id, sources) {
        requireString(id);
        if (!this.known.has(id)) {
            const launch = [...this.launches.values()].find(launch => launch.state === 'ready' && launch.thread?.id === id);
            if (launch) this.known.set(id, launch.thread);
        }
        if (!this.known.has(id)) throw new HttpError(404, '一覧から会話を選び直してください。');
        sources ??= await this.sources();
        if (!sources.panes.some(pane => pane.threadId === id)) {
            this.known.delete(id);
            throw new HttpError(409, 'PCで開いている会話を確認できません。一覧から選び直してください。');
        }
        const thread = sources.threads.get(id);
        if (isInternal(thread)) throw new HttpError(403, '内部Agentの会話は操作できません。');
        const current = summary(thread, sources);
        this.known.set(id, current);
        return current;
    }

    async usage(id) {
        const unknown = { contextUsedPercent: null, weeklyLeftPercent: null };
        const sources = await this.sources();
        const thread = await this.thread(id, sources);
        const panes = sources.panes.filter(pane => pane.threadId === id);
        if (thread.provider !== 'codex' || panes.length !== 1 || panes[0].tuis.length !== 1) return unknown;
        const pane = panes[0];
        try {
            const { read } = await this.herdr.call('pane.read', { pane_id: pane.pane_id, source: 'visible', format: 'ansi', strip_ansi: false });
            if (read?.pane_id !== pane.pane_id) return unknown;
            const current = await this.sources();
            await this.thread(id, current);
            const matches = current.panes.filter(candidate => candidate.threadId === id);
            if (matches.length !== 1 || !samePane(pane, matches[0])
                || processFingerprint(pane, pane.process, id) !== processFingerprint(matches[0], matches[0].process, id)) return unknown;
            return codexUsage(read.text);
        } catch { return unknown; }
    }

    async history(id, cursor, until) {
        const sources = await this.sources();
        const thread = await this.thread(id, sources);
        if (cursor) requireString(cursor, 4096);
        if (until) requireString(until);
        if (thread.provider === 'claude') return this.claude.history(sources.threads.get(id), cursor, until);
        let page;
        let turns = [];
        const cursors = new Set();
        do {
            try {
                page = await this.codex.call('thread/turns/list', {
                    threadId: id, cursor, limit: 20, sortDirection: 'desc', itemsView: 'full',
                });
            } catch (error) {
                if (!cursor && !turns.length && error.code === -32600 && error.rpcMessage?.includes('is not materialized yet; thread/turns/list is unavailable before first user message')) {
                    return { turns: [], nextCursor: null };
                }
                throw error;
            }
            turns.push(...page.data);
            cursor = page.nextCursor;
            if (!until || page.data.some(turn => turn.id === until)) break;
            if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new HttpError(502, '新しい履歴を取得できません。');
            cursors.add(cursor);
        } while (cursor);
        turns = turns.reverse().map(turn => ({
            id: turn.id, status: turn.status, startedAt: turn.startedAt,
            items: turn.items.map(projectItem).filter(Boolean),
        }));
        return { turns, nextCursor: page.nextCursor };
    }

    async queue(id) {
        if (id.startsWith('claude:')) return [];
        return projectQueue(await this.pages('thread/queue/list', { threadId: id }));
    }

    async questionState(id, sources) {
        sources ??= await this.sources();
        const thread = await this.thread(id, sources);
        if (thread.provider === 'claude') return { thread, questions: [], queue: [] };
        const reservations = [...this.questionReservations].filter(([, reservation]) => reservation.threadId === id);
        const [page, queue] = await Promise.all([
            this.codex.call('thread/turns/list', { threadId: id, limit: reservations.length ? 20 : 1, sortDirection: 'desc', itemsView: 'full' }).catch(error => {
                if (error.code === -32600 && error.rpcMessage?.includes('is not materialized yet; thread/turns/list is unavailable before first user message')) return { data: [] };
                return { data: null };
            }),
            this.pages('thread/queue/list', { threadId: id }),
        ]);
        if (!page.data) return { thread, questions: [], questionsReady: false, queue: projectQueue(queue) };
        const loaded = sources.loaded.has(id);
        const activeTurnId = loaded ? page.data.find(turn => turn.status === 'inProgress')?.id ?? null : null;
        const { questions, answered } = pendingQuestions(page.data, queue, activeTurnId);
        const panes = sources.panes.filter(pane => pane.threadId === id);
        const daemonStatus = sources.threads.get(id).status;
        const running = loaded && daemonStatus?.type === 'active' && !daemonStatus.activeFlags?.length;
        const answerable = running && panes.length === 1 && ['idle', 'done', 'working', 'blocked'].includes(panes[0].agent_status);
        for (const [key, reservation] of reservations) {
            if (this.questionReservations.get(key)?.requestId !== reservation.requestId) continue;
            const confirmed = answered.has(reservation.questionItemId) || answered.has(reservation.itemId);
            const record = this.operations.get(reservation.requestId);
            if (record?.result.state === 'processing') continue;
            if (!confirmed && !(record?.result.state === 'succeeded' && reservation.turnId !== activeTurnId)) continue;
            if (record) record.result = { requestId: reservation.requestId, state: 'succeeded', value: confirmed ? { confirmed: true } : { turnEnded: true } };
            this.questionReservations.delete(key);
        }
        return { thread, questionsReady: true, activeTurnId, answerable, questions: questions.map(question => ({ ...question,
            operation: this.questionReservations.get(this.questionKey(id, question))?.requestId,
        })), queue: projectQueue(queue) };
    }

    questionKey(id, question) { return JSON.stringify([id, question.turnId, question.itemId, question.index]); }

    async answerTarget(id, body) {
        const sources = await this.sources(false, { fresh: true });
        const state = await this.questionState(id, sources);
        const question = state.questions.find(question => question.turnId === body.turnId && question.itemId === body.itemId && question.index === body.index);
        if (state.thread.provider !== 'codex' || !state.answerable || !question) {
            throw new HttpError(409, '質問や会話の状態が変わりました。表示を更新して確認してください。');
        }
        if (Buffer.byteLength(question.questionItemId) > 512) throw new HttpError(409, '質問の識別情報が上限を超えています。PCで回答してください。');
        return question;
    }

    answer(id, body) {
        requireString(body.turnId); requireString(body.itemId, 512);
        const answer = requireString(body.answer, 32000);
        if (!Number.isSafeInteger(body.index) || body.index < 0 || !answer.isWellFormed() || Buffer.byteLength(answer) > 32000
            || /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(answer)) throw new HttpError(400, '回答の長さや制御文字を確認してください。');
        const key = this.questionKey(id, body);
        return this.once(body.requestId, JSON.stringify(['answer', id, body.turnId, body.itemId, body.index, answer]), async () => {
            if (this.questionReservations.has(key)) throw new HttpError(409, 'この質問の回答は送信済みか結果を確認中です。PCで確認してください。');
            this.questionReservations.set(key, { threadId: id, turnId: body.turnId, itemId: body.itemId,
                questionItemId: questionId(body.itemId, body.index), requestId: body.requestId });
            try {
                const question = await this.answerTarget(id, body);
                const text = questionReply(question, answer);
                return await this.codex.call('turn/steer', { threadId: id, expectedTurnId: body.turnId,
                    clientUserMessageId: body.requestId, input: [{ type: 'text', text, text_elements: [] }] });
            } catch (error) {
                if (!error.uncertain) this.questionReservations.delete(key);
                throw error;
            }
        });
    }

    recoverAnswer(id, body) {
        requireOperationId(body.requestId);
        requireString(body.turnId); requireString(body.itemId, 512);
        if (!Number.isSafeInteger(body.index) || body.index < 0) throw new HttpError(400, '質問の番号を確認してください。');
        const key = this.questionKey(id, body), reservation = this.questionReservations.get(key);
        const record = this.operations.get(body.requestId);
        if (body.confirmed === true && !record && !reservation) {
            return { released: true };
        }
        if (body.confirmed !== true || !reservation || reservation.threadId !== id || reservation.requestId !== body.requestId || record?.result.state !== 'unknown') {
            throw new HttpError(409, '結果が不明な回答の操作と会話を確認してください。');
        }
        this.questionReservations.delete(key);
        record.result = { requestId: body.requestId, state: 'failed', message: 'PCで回答結果を確認して解除しました。' };
        return { released: true };
    }

    operation(id) {
        requireString(id);
        const operation = this.operations.get(id);
        if (!operation) throw new HttpError(404, '操作の記録がありません。PCで結果を確認してください。');
        return operation.result;
    }

    async once(id, fingerprint, action, wait = true) {
        requireOperationId(id);
        const existing = this.operations.get(id);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new HttpError(409, '操作IDが別の内容に使用されています。');
            return existing.result;
        }
        if (this.operations.size >= 10000) throw new HttpError(503, '操作記録が上限に達しました。サーバーを再起動してください。');
        const record = { fingerprint, result: { requestId: id, state: 'processing' } };
        this.operations.set(id, record);
        const work = (async () => {
            try {
                const value = await action();
                record.result = { requestId: id, state: 'succeeded', value };
            } catch (error) {
                record.result = { requestId: id, state: error.uncertain ? 'unknown' : 'failed', message: error.message };
            }
        })();
        if (wait) await work;
        return record.result;
    }

    async launch(body) {
        requireOperationId(body.requestId);
        const input = requireString(body.path, 4096);
        const provider = body.provider === undefined ? 'codex' : body.provider;
        if (!['codex', 'claude'].includes(provider)) throw new HttpError(400, '起動するCLIを選んでください。');
        const fingerprint = JSON.stringify(['launch', input, provider]);
        const existing = this.operations.get(body.requestId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new HttpError(409, '操作IDが別の内容に使用されています。');
            return this.launchStatus(body.requestId);
        }
        const path = await directoryPath(input);
        if (this.launches.size >= 1000) throw new HttpError(503, '起動記録が上限に達しました。サーバーを再起動してください。');
        await this.once(body.requestId, fingerprint, async () => {
            const launch = { requestId: body.requestId, path, provider, state: 'waiting', phase: 'creating', confirmed: false };
            this.launches.set(body.requestId, launch);
            const creation = this.creationQueue.then(() => this.createLaunchPane(launch));
            this.creationQueue = creation.catch(() => {});
            try {
                await creation;
                if (launch.state !== 'ended') await this.startLaunch(launch);
                return { launchId: launch.requestId };
            } catch (error) {
                if (error.code === 'pane_not_found') {
                    launch.state = 'ended';
                    return { launchId: launch.requestId };
                }
                launch.state = error.uncertain ? 'unknown' : 'failed';
                launch.message = error.message;
                launch.blockedBy = error.blockedBy;
                throw error;
            }
        }, false);
        return this.launchSnapshot(this.launches.get(body.requestId));
    }

    assertLaunchAllowed() {
        const blocked = [...this.launches.values()].find(launch => launch.state === 'unknown' && !launch.confirmed);
        if (blocked) {
            throw Object.assign(new HttpError(409, '起動結果を確認できません。PCで結果を確認して解除してください。'), { blockedBy: blocked.requestId });
        }
    }

    async createLaunchPane(launch) {
        this.assertLaunchAllowed();
        const { panes } = await this.herdr.call('pane.list');
        if (!Array.isArray(panes)) throw new HttpError(502, 'Herdrの端末一覧を読み取れません。');
        const candidates = await boundedMap(panes, async pane => {
            try {
                return await directoryPath(pane.cwd) === launch.path ? pane.workspace_id : null;
            } catch { return null; }
        });
        const workspace = [...new Set(candidates.filter(id => typeof id === 'string' && id))].sort()[0];
        let result;
        try {
            result = await this.herdr.call(workspace ? 'tab.create' : 'workspace.create', workspace
                ? { workspace_id: workspace, cwd: launch.path, focus: false }
                : { label: basename(launch.path) || launch.path, cwd: launch.path, focus: false });
        } catch (error) {
            if (error.uncertain) { launch.state = 'unknown'; launch.message = error.message; }
            throw error;
        }
        try {
            const root = result?.root_pane;
            const paneId = typeof root === 'string' ? root : root?.pane_id;
            const tabId = typeof result?.tab === 'string' ? result.tab : result?.tab?.tab_id;
            if (!paneId || !tabId) throw new Error();
            const { pane } = await this.herdr.call('pane.get', { pane_id: paneId });
            if (!pane || pane.pane_id !== paneId || pane.tab_id !== tabId || !pane.terminal_id || !pane.workspace_id
                || (workspace && pane.workspace_id !== workspace)
                || (typeof root === 'object' && ['terminal_id', 'workspace_id', 'tab_id'].some(key => root[key] && root[key] !== pane[key]))) throw new Error();
            launch.pane = Object.fromEntries(['pane_id', 'terminal_id', 'tab_id', 'workspace_id'].map(key => [key, pane[key]]));
            launch.phase = 'shell';
        } catch (error) {
            if (error.code === 'pane_not_found') { launch.state = 'ended'; return; }
            launch.state = 'unknown';
            launch.message = '作成した端末の識別情報を確認できません。PCで結果を確認してください。';
            throw uncertain(launch.message);
        }
    }

    async inspectLaunch(launch, preparing = false) {
        let pane, process;
        try {
            ({ pane } = await this.herdr.call('pane.get', { pane_id: launch.pane.pane_id }));
            if (!pane) return null;
            if (!samePane(launch.pane, pane)) throw uncertain('起動した端末の対象が変わりました。PCで確認してください。');
            ({ process_info: process } = await this.herdr.call('pane.process_info', { pane_id: launch.pane.pane_id }));
        }
        catch (error) {
            if (error.code === 'pane_not_found') return null;
            throw error;
        }
        if (!process?.shell_pid) {
            if (preparing && !launch.shellPid) return { pane, process: process || {} };
            throw new HttpError(502, '端末のプロセスを確認できません。');
        }
        if (launch.shellPid && launch.shellPid !== process.shell_pid) throw uncertain('起動した端末のプロセスが変わりました。PCで確認してください。');
        return { pane, process };
    }

    async startLaunch(launch) {
        const deadline = Date.now() + 10000;
        let previousFingerprint = null;
        while (Date.now() < deadline) {
            const identity = await this.inspectLaunch(launch, true);
            if (!identity) { launch.state = 'ended'; return; }
            const { process } = identity;
            launch.shellPid ??= process.shell_pid;
            const foreground = process.foreground_processes || [];
            const ready = process.shell_pid && process.foreground_process_group_id === process.shell_pid && foreground.length === 1
                && foreground.every(p => p.pid === process.shell_pid && ['zsh', 'bash', 'fish', 'sh'].includes(basename(p.argv?.[0] || p.argv0 || p.name || '').replace(/^-/, '')));
            const fingerprint = ready ? processFingerprint(identity.pane, process, launch.requestId) : null;
            if (Date.now() >= deadline) break;
            if (fingerprint && fingerprint === previousFingerprint) {
                this.assertLaunchAllowed();
                // Fixed executable and environment flags; cwd is supplied when creating the pane.
                const command = launch.provider === 'claude'
                    ? 'env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID claude'
                    : 'env -u CODEX_THREAD_ID codex';
                await this.herdr.call('pane.send_input', { pane_id: launch.pane.pane_id, text: command, keys: ['Enter'] });
                launch.commandSent = true;
                launch.phase = launch.provider;
                launch.deadline = Date.now() + 30000;
                return;
            }
            previousFingerprint = fingerprint;
            await delay(200);
        }
        throw new HttpError(409, 'shellの準備完了を確認できません。PCで端末を確認してください。');
    }

    launchSnapshot(launch) {
        return { requestId: launch.requestId, provider: launch.provider, state: launch.state, phase: launch.phase, path: launch.path,
            message: launch.message, confirmed: launch.confirmed, blockedBy: launch.blockedBy, operation: this.operation(launch.requestId),
            pane: launch.pane ? { id: launch.pane.pane_id, terminalId: launch.pane.terminal_id, tabId: launch.pane.tab_id,
                workspace: launch.pane.workspace_id, title: launch.provider === 'claude' ? '起動したClaude' : '起動したCodex', cwd: launch.path } : null,
            terminalAvailable: launch.state === 'waiting' && Boolean(launch.cliFingerprint), thread: launch.thread };
    }

    getLaunch(id) {
        requireString(id);
        const launch = this.launches.get(id);
        if (!launch) throw new HttpError(404, '起動の記録がありません。新しく起動する前にPCで結果を確認してください。');
        return launch;
    }

    async launchStatus(id) {
        const launch = this.getLaunch(id);
        if (!launch.commandSent || !['waiting', 'ready'].includes(launch.state)) return this.launchSnapshot(launch);
        launch.refresh ??= this.updateLaunch(launch).finally(() => { launch.refresh = null; });
        return launch.refresh;
    }

    async updateLaunch(launch) {
        const id = launch.requestId;
        try {
            const identity = await this.inspectLaunch(launch);
            if (!['waiting', 'ready'].includes(launch.state)) return this.launchSnapshot(launch);
            if (!identity) { launch.state = 'ended'; return this.launchSnapshot(launch); }
            const { pane, process } = identity;
            const tuis = (process.foreground_processes || []).filter(launch.provider === 'claude' ? isClaudeProcess : isCodexTui);
            if (!tuis.length) {
                if (launch.cliFingerprint || Date.now() > launch.deadline) {
                    if ((process.foreground_processes || []).some(p => p.pid !== process.shell_pid)) throw uncertain('起動した端末のプロセスを確認できません。PCで確認してください。');
                    launch.state = 'ended';
                }
                return this.launchSnapshot(launch);
            }
            const fingerprint = processFingerprint(pane, process, id);
            if (tuis.length !== 1 || (launch.cliFingerprint && launch.cliFingerprint !== fingerprint)) throw uncertain('起動したCLIのプロセスが変わりました。PCで確認してください。');
            launch.cliFingerprint = fingerprint;
            const sources = await this.sources(false, { fresh: launch.provider === 'claude' });
            if (!['waiting', 'ready'].includes(launch.state)) return this.launchSnapshot(launch);
            const matched = sources.panes.find(candidate => samePane(launch.pane, candidate)
                && processFingerprint(candidate, candidate.process, id) === launch.cliFingerprint
                && (sources.threads.get(candidate.threadId)?.provider || 'codex') === launch.provider);
            if (!matched && launch.provider === 'claude' && sources.claudeSessions.some(session => session.pid === tuis[0].pid)) {
                throw uncertain('起動したClaudeの会話との対応を確認できません。PCで確認してください。');
            }
            if (!matched && launch.thread) throw uncertain('起動した会話との対応を確認できません。PCで確認してください。');
            if (matched) {
                if (launch.thread && launch.thread.id !== matched.threadId) throw uncertain('起動した会話の対象が変わりました。PCで確認してください。');
                launch.thread = summary(sources.threads.get(matched.threadId), sources);
                this.known.set(launch.thread.id, launch.thread);
                launch.state = 'ready';
                for (const [bindingId, binding] of this.bindings) {
                    if (binding.owner === 'launch' && binding.id === id) this.bindings.delete(bindingId);
                }
            }
        } catch (error) {
            if (!error.uncertain || error instanceof UpstreamError) throw error;
            launch.state = 'unknown'; launch.message = error.message;
        }
        return this.launchSnapshot(launch);
    }

    confirmLaunch(id, body) {
        const launch = this.getLaunch(id);
        if (body.confirmed !== true || launch.state !== 'unknown') throw new HttpError(409, '結果が不明な起動だけをPCで確認して解除できます。');
        launch.confirmed = true;
        return this.launchSnapshot(launch);
    }

    send(id, body) {
        const imageId = body.imageId === undefined ? null : requireString(body.imageId, 36);
        const text = imageId && typeof body.text === 'string' && !body.text.trim() && body.text.length <= 32000 ? body.text : requireString(body.text, 32000);
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) throw new HttpError(400, '指示に制御文字が含まれています。');
        return this.once(body.requestId, JSON.stringify(['message', id, text, imageId]), async () => {
            const image = imageId ? await this.prepareImage(id, imageId, body.requestId) : null;
            try {
                const sources = await this.sources();
                const thread = await this.thread(id, sources);
                const panes = sources.panes.filter(pane => pane.threadId === id);
                this.assertMessageState(thread, panes);
                if (thread.provider === 'claude' || thread.status.type === 'active') {
                    if (panes.length !== 1) throw new HttpError(409, '会話に対応する端末を1つに特定できません。端末で確認してください。');
                    if (/^[\/!]/.test(text.trimStart())) throw new HttpError(409, 'CLIコマンドは端末画面から入力してください。');
                    const identity = await this.identity(id, panes[0].pane_id, 'thread', sources);
                    return await this.paneInput(identity.pane.pane_id, async () => {
                        const { read } = await this.herdr.call('pane.read', { pane_id: identity.pane.pane_id, source: 'visible', format: 'ansi', strip_ansi: false });
                        const input = (thread.provider === 'claude' ? claudeInputState : codexInputState)(read?.text);
                        if (input !== 'empty') throw new HttpError(409, input === 'draft'
                            ? 'PCの入力欄に下書きがあります。端末で確認してください。'
                            : 'PCの入力欄を確認できません。端末で状態を確認してください。');
                        await this.recheckMessageTarget(id, identity);
                        const message = image ? `${text}${text ? '\n\n' : ''}添付画像を次の絶対パスから読み取ってください。\n画像: ${JSON.stringify(image.path)}` : text;
                        return this.herdr.call('pane.send_input', { pane_id: identity.pane.pane_id, text: '\x1b[200~' + message + '\x1b[201~', keys: ['Enter'] });
                    });
                }
                const queue = await this.pages('thread/queue/list', { threadId: id });
                if (queue.length) throw new HttpError(409, '待機中の指示があります。処理が終わるまでお待ちください。');
                const result = await this.codex.call('thread/queue/add', {
                    threadId: id, clientUserMessageId: body.requestId,
                    input: [{ type: 'text', text, textElements: [] }, ...(image ? [{ type: 'localImage', path: image.path }] : [])],
                });
                return image ? { submitted: true } : result;
            } finally {
                if (image) image.holds.delete(body.requestId);
            }
        });
    }

    assertMessageState(thread, panes) {
        if (thread.status.activeFlags?.length || panes.some(pane => pane.agent_status === 'blocked')) {
            throw new HttpError(409, '承認や回答を待っています。端末画面で操作してください。');
        }
        if (!['idle', 'active'].includes(thread.status.type) || !panes.length || panes.some(pane => !['idle', 'done', 'working'].includes(pane.agent_status))) {
            throw new HttpError(409, '会話の状態を確認できません。端末で状態を確認してください。');
        }
    }

    async recheckMessageTarget(id, expected) {
        if (id.startsWith('claude:')) {
            const [{ pane }, { process_info: process }, sessions] = await Promise.all([
                this.herdr.call('pane.get', { pane_id: expected.pane.pane_id }),
                this.herdr.call('pane.process_info', { pane_id: expected.pane.pane_id }),
                this.claude.sessions({ fresh: true }),
            ]);
            const session = claudeMatch({ ...pane, process }, sessions);
            if (!samePane(expected.pane, pane) || !process?.shell_pid
                || processFingerprint(pane, process, ['thread', id]) !== expected.fingerprint
                || !session || `claude:${session.sessionId}` !== id) {
                throw new HttpError(409, '会話やClaudeの対象が変わりました。端末で確認してください。');
            }
            const status = currentStatus(claudeThread(session), true, [{ ...pane, threadId: id }]);
            this.assertMessageState({ status }, [pane]);
            return;
        }
        const [{ pane }, { process_info: process }, { thread }] = await Promise.all([
            this.herdr.call('pane.get', { pane_id: expected.pane.pane_id }),
            this.herdr.call('pane.process_info', { pane_id: expected.pane.pane_id }),
            this.codex.call('thread/read', { threadId: id, includeTurns: false }),
        ]);
        if (!samePane(expected.pane, pane) || !process?.shell_pid
            || processFingerprint(pane, process, ['thread', id]) !== expected.fingerprint || thread?.id !== id || isInternal(thread)) {
            throw new HttpError(409, '会話やCodexの対象が変わりました。端末で確認してください。');
        }
        const tuis = (process.foreground_processes || []).filter(isCodexTui);
        let resources;
        try { resources = await this.presence(tuis.map(process => process.pid)); }
        catch { throw new HttpError(502, 'Codexの現在のOS資源を確認できません。'); }
        const resource = tuis.length === 1 ? resources.get(tuis[0].pid) : null;
        if (!resource || (resource.threadIds.size && (resource.threadIds.size !== 1 || !resource.threadIds.has(id)))) {
            throw new HttpError(409, 'PCで開いている会話との対応を確認できません。端末で確認してください。');
        }
        let matched = resource.threadIds.has(id);
        if (!matched) {
            const servers = await this.pages('mcpServerStatus/list', { threadId: id, serverName: 'codex_tui', detail: 'toolsAndAuthOnly' });
            matched = servers.some(server => server.name === 'codex_tui' && resource.ports.has(originPort(server.httpOrigin)));
        }
        if (!matched) throw new HttpError(409, 'PCで開いている会話との対応を確認できません。端末で確認してください。');
        const status = currentStatus(thread, thread.status?.type !== 'notLoaded', [{ ...pane, threadId: id }]);
        this.assertMessageState({ status }, [pane]);
    }

    async paneInput(paneId, action) {
        if (this.inputPanes.has(paneId)) throw new HttpError(409, 'この端末への入力を処理中です。完了後に送信してください。');
        this.inputPanes.add(paneId);
        try { return await action(); }
        finally { this.inputPanes.delete(paneId); }
    }

    async panes(id) {
        await this.thread(id);
        const sources = await this.sources();
        return sources.panes.filter(pane => pane.threadId === id).map(pane => ({
            id: pane.pane_id, terminalId: pane.terminal_id, workspace: pane.workspace_id,
            title: pane.terminal_title_stripped || pane.terminal_title || pane.title || pane.label || pane.pane_id,
            cwd: pane.foreground_cwd || pane.cwd || '',
            session: pane.threadId,
        }));
    }

    async identity(id, paneId, owner = 'thread', sources) {
        let pane, process;
        if (owner === 'launch') {
            const launch = this.getLaunch(id);
            if (launch.state !== 'waiting' || !launch.commandSent || paneId !== launch.pane?.pane_id || !launch.cliFingerprint) {
                throw new HttpError(409, '起動状態を更新して端末を選び直してください。');
            }
            let identity;
            try { identity = await this.inspectLaunch(launch); }
            catch (error) {
                if (error.uncertain && !(error instanceof UpstreamError)) { launch.state = 'unknown'; launch.message = error.message; }
                throw new HttpError(error.status || 409, error.message);
            }
            if (launch.state !== 'waiting') throw new HttpError(409, '会話画面から端末を選び直してください。');
            if (!identity) {
                launch.state = 'ended';
                throw new HttpError(409, '起動した端末が終了しました。起動状態を確認してください。');
            }
            if ((identity.process.foreground_processes || []).filter(launch.provider === 'claude' ? isClaudeProcess : isCodexTui).length !== 1
                || processFingerprint(identity.pane, identity.process, id) !== launch.cliFingerprint) {
                launch.state = 'unknown'; launch.message = '起動したCLIの対象が変わりました。PCで確認してください。';
                throw new HttpError(409, launch.message);
            }
            ({ pane, process } = identity);
        } else {
            if (!this.known.has(id)) throw new HttpError(404, '一覧から会話を選び直してください。');
            const { panes } = sources ?? await this.sources(false, { fresh: true });
            pane = panes.find(pane => pane.pane_id === paneId && pane.threadId === id);
            process = pane?.process;
        }
        if (!pane?.terminal_id) throw new HttpError(409, '端末が見つかりません。選び直してください。');
        if (!process?.shell_pid) throw new HttpError(409, '端末のプロセスを確認できません。');
        return { pane, fingerprint: processFingerprint(pane, process, [owner, id]) };
    }

    async bind(id, paneId, owner = 'thread') {
        requireString(paneId);
        const identity = await this.identity(id, paneId, owner);
        const bindingId = randomUUID();
        this.bindings.set(bindingId, { owner, id, paneId, fingerprint: identity.fingerprint, expires: Date.now() + 30 * 60 * 1000 });
        return { bindingId, paneId };
    }

    unbind(id, bindingId, owner = 'thread') {
        const binding = this.bindings.get(bindingId);
        if (binding?.owner === owner && binding.id === id) this.bindings.delete(bindingId);
        return { released: true };
    }

    async binding(id, bindingId, owner = 'thread') {
        const binding = this.bindings.get(bindingId);
        if (!binding || binding.owner !== owner || binding.id !== id || binding.expires < Date.now()) throw new HttpError(409, '端末を選び直してください。');
        try {
            const identity = await this.identity(id, binding.paneId, owner);
            if (identity.fingerprint !== binding.fingerprint) throw new HttpError(409, '端末の対象が変わりました。選び直してください。');
            return binding;
        } catch (error) {
            this.bindings.delete(bindingId);
            throw error;
        }
    }

    async terminal(id, bindingId, owner = 'thread') {
        const binding = await this.binding(id, bindingId, owner);
        const { read } = await this.herdr.call('pane.read', { pane_id: binding.paneId, source: 'visible', format: 'text', strip_ansi: true });
        const viewId = randomUUID();
        binding.view = { id: viewId, hash: createHash('sha256').update(read.text).digest('hex'), at: Date.now() };
        return { text: read.text, paneId: binding.paneId, viewId };
    }

    terminalInput(id, body, owner = 'thread') {
        const hasText = typeof body.text === 'string';
        if (hasText) {
            requireString(body.text, 4000);
            if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(body.text)) throw new HttpError(400, '端末の文字入力には改行や制御文字を使用できません。');
            if (body.key !== undefined) throw new HttpError(400, '文字とキーは別々に送信してください。');
        } else if (!['Enter', 'Escape', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Backspace', 'Ctrl-C'].includes(body.key)) {
            throw new HttpError(400, 'このキーは使用できません。');
        }
        if (body.key === 'Ctrl-C' && body.confirmInterrupt !== true) throw new HttpError(400, 'Ctrl-Cの送信を確認してください。');
        return this.once(body.requestId, JSON.stringify(['terminal', owner, id, body.bindingId, body.text, body.key]), async () => {
            const binding = await this.binding(id, body.bindingId, owner);
            return this.paneInput(binding.paneId, async () => {
                if (!binding.view || binding.view.id !== body.viewId || Date.now() - binding.view.at > 30000) throw new HttpError(409, '端末表示を更新してから操作してください。');
                const { read } = await this.herdr.call('pane.read', { pane_id: binding.paneId, source: 'visible', format: 'text', strip_ansi: true });
                if (createHash('sha256').update(read.text).digest('hex') !== binding.view.hash) throw new HttpError(409, '端末表示が変わりました。更新して確認してください。');
                await this.binding(id, body.bindingId, owner);
                binding.view = null;
                const key = body.key === 'Ctrl-C' ? 'ctrl+c' : body.key;
                return this.herdr.call('pane.send_input', { pane_id: binding.paneId, ...(hasText ? { text: body.text } : { keys: [key] }) });
            });
        });
    }
}
