import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { UpstreamError } from './rpc.js';

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_ROW_BYTES = 2 * 1024 * 1024;

export function isClaudeProcess(process) {
    const command = process.argv0 || process.argv?.[0] || process.name;
    return Number.isSafeInteger(process.pid) && process.pid > 0
        && typeof command === 'string' && basename(command) === 'claude';
}

export function claudeMatch(pane, sessions) {
    const processes = (pane.process?.foreground_processes || []).filter(isClaudeProcess);
    if (processes.length !== 1) return null;
    const process = processes[0];
    const cwd = process.cwd || pane.foreground_cwd || pane.cwd;
    const matches = sessions.filter(session => session.pid === process.pid && session.cwd === cwd);
    if (matches.length !== 1) return null;
    const session = matches[0];
    if (sessions.filter(other => other.sessionId === session.sessionId).length !== 1) return null;
    if (pane.agent_session?.value && pane.agent_session.value !== session.sessionId) return null;
    return session;
}

export function claudeThread(session) {
    const waiting = session.status === 'waiting' || Boolean(session.waitingFor);
    const status = waiting ? { type: 'active', activeFlags: ['waitingOnApprovalOrInput'] }
        : session.status === 'busy' ? { type: 'active', activeFlags: [] }
        : { type: session.status === 'idle' ? 'idle' : 'unknown' };
    return { id: `claude:${session.sessionId}`, provider: 'claude', name: session.name,
        preview: '', cwd: session.cwd, updatedAt: session.startedAt / 1000, status, sessionId: session.sessionId };
}

function permitted(row) {
    return ['user', 'assistant'].includes(row?.type) && !row.isMeta && !row.isSidechain;
}

function visibleText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.flatMap(part => {
        if (part?.type === 'text' && typeof part.text === 'string') return [part.text];
        if (part?.type === 'image') return ['[画像]'];
        if (part?.type === 'document') return ['[添付ファイル]'];
        return [];
    }).join('\n');
}

export class ClaudeReader {
    constructor({ configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), executable = 'claude', run = execute, now = Date.now } = {}) {
        this.configDir = configDir;
        this.executable = executable;
        this.run = run;
        this.now = now;
        this.cachedSessions = null;
        this.pendingSessions = null;
    }

    async sessions({ fresh = false } = {}) {
        if (fresh) return this.readSessions();
        if (this.cachedSessions?.expires > this.now()) return this.cachedSessions.rows;
        if (!this.pendingSessions) {
            this.pendingSessions = this.readSessions().then(rows => {
                this.cachedSessions = { rows, expires: this.now() + 1000 };
                return rows;
            }).finally(() => { this.pendingSessions = null; });
        }
        return this.pendingSessions;
    }

    async readSessions() {
        try {
            const { stdout } = await this.run(this.executable, ['agents', '--json'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
            const rows = JSON.parse(stdout);
            if (!Array.isArray(rows)) throw new Error();
            return rows.filter(row => row?.kind === 'interactive' && UUID.test(row.sessionId)
                && Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.cwd === 'string' && isAbsolute(row.cwd)
                && Number.isFinite(row.startedAt));
        } catch { throw new UpstreamError('Claudeの現在のセッションを確認できません。'); }
    }

    async logPath(sessionId) {
        if (!UUID.test(sessionId)) throw new UpstreamError('Claudeの会話IDを確認できません。');
        const projects = join(this.configDir, 'projects');
        let directories;
        try { directories = await readdir(projects, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        const paths = [];
        for (const directory of directories) {
            if (!directory.isDirectory()) continue;
            const path = join(projects, directory.name, `${sessionId}.jsonl`);
            try { if ((await lstat(path)).isFile()) paths.push(path); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (paths.length > 1) throw new UpstreamError('Claudeの履歴ファイルを1つに特定できません。');
        return paths[0] || null;
    }

    async history(thread, cursor, until) {
        const path = await this.logPath(thread.sessionId);
        if (!path) return { turns: [], nextCursor: null };
        const turns = [];
        const tools = new Map();
        const seen = new Set();
        let current, pending = Buffer.alloc(0), total = 0;
        const consume = line => {
            if (line.length > MAX_ROW_BYTES) throw new UpstreamError('Claudeの履歴の1行が2MiBを超えています。PCで確認してください。');
            if (!line.length) return;
            let row;
            try { row = JSON.parse(line.toString('utf8')); }
            catch { throw new UpstreamError('Claudeの履歴を解析できません。PCで確認してください。'); }
            if (!permitted(row)) return;
            if (row.sessionId !== thread.sessionId || row.cwd !== thread.cwd) throw new UpstreamError('Claudeの履歴と現在の会話の対応を確認できません。');
            if (!UUID.test(row.uuid) || seen.has(row.uuid)) return;
            seen.add(row.uuid);
            const content = row.message?.content;
            const text = visibleText(content);
            if (row.type === 'user' && text.trim()) {
                current = { id: row.uuid, status: 'completed', startedAt: Date.parse(row.timestamp) / 1000,
                    items: [{ id: `${row.uuid}:user`, type: 'userMessage', text }] };
                turns.push(current);
            }
            if (!current) return;
            if (row.type === 'assistant' && Array.isArray(content)) {
                for (const [index, part] of content.entries()) {
                    const id = `${row.uuid}:${index}`;
                    if (part?.type === 'text' && typeof part.text === 'string') current.items.push({ id, type: 'agentMessage', text: part.text });
                    if (part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
                        const item = { id, type: 'dynamicToolCall', label: part.name, status: 'inProgress', text: JSON.stringify(part.input ?? {}, null, 2) };
                        current.items.push(item); tools.set(part.id, item);
                    }
                }
            }
            if (row.type === 'user' && Array.isArray(content)) {
                for (const part of content) {
                    if (part?.type !== 'tool_result') continue;
                    const item = tools.get(part.tool_use_id);
                    if (!item) continue;
                    item.status = part.is_error ? 'failed' : 'completed';
                    item.text += '\n\n' + visibleText(part.content);
                }
            }
        };
        for await (const chunk of createReadStream(path)) {
            total += chunk.length;
            if (total > MAX_LOG_BYTES) throw new UpstreamError('Claudeの履歴が64MiBを超えています。PCで確認してください。');
            pending = Buffer.concat([pending, chunk]);
            let start = 0, end;
            while ((end = pending.indexOf(10, start)) >= 0) { consume(pending.subarray(start, end)); start = end + 1; }
            pending = pending.subarray(start);
            if (pending.length > MAX_ROW_BYTES) throw new UpstreamError('Claudeの履歴の1行が2MiBを超えています。PCで確認してください。');
        }
        // 改行まで書き終わったレコードだけを公開し、追記途中の末尾は次回読む。
        let end = turns.length;
        if (cursor) {
            end = turns.findIndex(turn => turn.id === cursor);
            if (end < 0) throw new UpstreamError('Claudeの過去履歴の位置を確認できません。会話を開き直してください。');
        }
        let start = Math.max(0, end - 20);
        if (until && !cursor) {
            const anchor = turns.findIndex(turn => turn.id === until);
            if (anchor >= 0) start = Math.min(start, anchor);
        }
        return { turns: turns.slice(start, end), nextCursor: start > 0 ? turns[start].id : null };
    }
}
