import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexClient, HerdrClient } from '../src/rpc.js';
import { MonitorService } from '../src/service.js';
import { createMonitorServer } from '../src/server.js';
import { ClaudeReader } from '../src/claude.js';

export function codexScreen(text = 'Ask Codex to do anything', dim = true) {
    const background = '\x1b[48;2;51;49;49m';
    const padding = background + ' '.repeat(80) + '\x1b[0m';
    return '› 会話履歴のユーザー発言\n\n• 処理中の出力\n\n' + padding + '\n'
        + '\x1b[1m' + background + '›\x1b[0m' + background + ' ' + (dim ? '\x1b[2m' : '') + text + '\x1b[0m' + background + ' \x1b[0m\n'
        + padding + '\n  GPT-6.1-Sol · Context 5% used';
}

export function claudeScreen(text = '\x1b[2mTry "how do I log an error?"\x1b[0m') {
    const rule = '\x1b[0m\x1b[38;2;136;136;136m' + '─'.repeat(80) + '\x1b[0m';
    return ['Claude Code', '', rule, '❯\u00a0' + text, rule,
        '  Opus 5.5 │ ctx 1%', '  $0.10 │ 2m23s', '  ⏵⏵ auto mode on'].join('\r\n');
}

export async function fixture({ now = Date.now } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'am-'));
    const codexPath = join(dir, 'c.sock'), herdrPath = join(dir, 'h.sock');
    const state = {
        calls: [], herdrCalls: [], writes: [], queue: [], steers: [], steerConfirm: true, ignoreSteer: false, ignoreAdd: false, failHistory: false, historyDelay: 0,
        creates: [], launchThread: true, ignoreCreate: false, malformedCreate: false, busyShell: false, initialShellPending: false,
        loadedIds: ['a', 'b', 'sub'], historyError: null, failState: false, failUnsubscribe: false, ignoreCodexMethod: null, mcpError: null,
        failHerdr: false, ignoreHerdrMethod: null, failPresence: false, changeProcessOnInput: false, ignoreInput: false,
        processInfoSteps: new Map(), claudeSessions: [], claudeCalls: 0, failClaude: false,
        processes: new Map([['w2:p2', { shell_pid: 101, foreground_process_group_id: 201, foreground_processes: [{ pid: 201, name: 'codex', argv: ['codex'] }] }]]),
        resources: new Map([[200, { ports: new Set([41001]), threadIds: new Set() }], [201, { ports: new Set([41002]), threadIds: new Set() }]]),
        origins: new Map([['a', 'http://127.0.0.1:41001'], ['b', 'http://127.0.0.1:41002'], ['sub', 'http://127.0.0.1:41001']]),
        threads: new Map([
            ['a', { id: 'a', name: 'モバイル表示を整える', cwd: '/projects/agent-monitor', preview: '読んでいた位置を保って、続きを確認する', source: 'cli', status: { type: 'idle' }, updatedAt: 1792080000 }],
            ['b', { id: 'b', name: 'APIのレスポンスを確認', cwd: '/projects/sample-api', preview: 'データの取得と入力の検証', source: 'vscode', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, updatedAt: 1792081000 }],
            ['sub', { id: 'sub', name: 'Internal Agent', source: { subAgent: { threadSpawn: {} } }, status: { type: 'idle' } }],
        ]),
        turns: new Map(),
        panes: [
            { pane_id: 'w1:p1', terminal_id: 'term1', tab_id: 'tab1', workspace_id: 'w1', terminal_title_stripped: 'Codex · agent-monitor', cwd: '/projects/agent-monitor', agent_status: 'idle', agent_session: null },
            { pane_id: 'w2:p2', terminal_id: 'term2', tab_id: 'tab2', workspace_id: 'w2', terminal_title: 'API', cwd: '/projects/sample-api', agent_status: 'blocked', agent_session: { value: 'b', source: 'codex', agent: 'codex' } },
        ],
        process: { shell_pid: 100, foreground_process_group_id: 200, foreground_processes: [{ pid: 200, name: 'codex', argv: ['codex'], cwd: '/projects/agent-monitor' }] },
        screen: 'Codex\n/project/agent-monitor\n指示を待っています >',
        ansiScreen: codexScreen().replaceAll('\n', '\r\n'),
    };
    const makeTurn = (n, text) => ({ id: `turn-${n}`, status: 'completed', startedAt: n, items: [
        { id: `user-${n}`, type: 'userMessage', content: [{ type: 'text', text: `確認 ${n}` }] },
        { id: `agent-${n}`, type: 'agentMessage', text: text || `出力 ${n}\n\n履歴の読みやすさと、表示位置の保持を確認します。\n\n- 結果を読む\n- 続きの指示を書く` },
        { id: `tool-${n}`, type: 'commandExecution', command: 'pnpm check', status: 'completed', aggregatedOutput: 'チェック完了' },
        { id: `reason-${n}`, type: 'reasoning', summary: ['SECRET SUMMARY'], content: ['SECRET REASONING'] },
    ] });
    state.turns.set('a', Array.from({ length: 26 }, (_, n) => makeTurn(n + 1)));
    state.turns.set('b', [makeTurn(100, '別の会話の出力です。')]);
    state.makeTurn = makeTurn;
    state.ask = (id = 'a', questions = [{ title: '**環境**を選んでください', options: ['開発', '本番'] }, { title: '補足はありますか？' }]) => {
        const turn = { id: `question-turn-${id}`, status: 'inProgress', startedAt: 300, items: [
            { id: `question-item-${id}`, type: 'agentMessage', text: '確認があります。', questions },
        ] };
        state.turns.get(id).push(turn);
        state.threads.get(id).status = { type: 'active', activeFlags: [] };
        state.panes.find(pane => pane.pane_id === 'w1:p1').agent_status = 'blocked';
        return turn;
    };
    state.resolveLaunch = pane => {
        const process = state.processes.get(pane.pane_id);
        const pid = process.foreground_processes[0].pid;
        const id = `launched-${pid}`;
        state.resources.set(pid, { ports: new Set(), threadIds: new Set([id]) });
        state.threads.set(id, { id, name: '新しく起動した会話', cwd: pane.cwd, source: 'cli', status: { type: 'notLoaded' }, updatedAt: 1792082000 });
        return id;
    };
    const codexServer = http.createServer();
    const wss = new WebSocketServer({ server: codexServer });
    wss.on('connection', socket => socket.on('message', async data => {
        const request = JSON.parse(data);
        state.calls.push(request);
        if (!request.id) return;
        if (state.ignoreCodexMethod === request.method) return;
        let result;
        switch (request.method) {
            case 'initialize': result = { userAgent: 'fake' }; break;
            case 'thread/unsubscribe':
                if (state.failUnsubscribe) { socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Method not found' } })); return; }
                result = { status: 'unsubscribed' }; break;
            case 'thread/loaded/list':
                result = request.params.cursor ? { data: state.loadedIds.slice(1), nextCursor: null } : { data: state.loadedIds.slice(0, 1), nextCursor: state.loadedIds.length > 1 ? 'loaded2' : null }; break;
            case 'thread/read':
                if (!state.threads.has(request.params.threadId)) {
                    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Thread not found' } })); return;
                }
                result = { thread: state.threads.get(request.params.threadId) }; break;
            case 'mcpServerStatus/list':
                if (state.mcpError) { socket.send(JSON.stringify({ id: request.id, error: state.mcpError })); return; }
                result = { data: [{ name: 'codex_tui', runtimeStatus: 'connected', httpOrigin: state.origins.get(request.params.threadId) || null }], nextCursor: null }; break;
            case 'thread/turns/list': {
                if (state.historyError) { socket.send(JSON.stringify({ id: request.id, error: state.historyError })); return; }
                if (state.failHistory) { socket.send(JSON.stringify({ id: request.id, error: { code: -1, message: 'history failed' } })); return; }
                const turns = [...(state.turns.get(request.params.threadId) || [])].reverse();
                const offset = request.params.cursor ? Number(request.params.cursor) : 0;
                const limit = request.params.limit ?? 20;
                result = { data: turns.slice(offset, offset + limit), nextCursor: offset + limit < turns.length ? String(offset + limit) : null };
                if (state.historyDelay) await new Promise(resolve => setTimeout(resolve, state.historyDelay));
                break;
            }
            case 'thread/queue/list':
                if (state.failState) { socket.send(JSON.stringify({ id: request.id, error: { code: -1, message: 'queue failed' } })); return; }
                result = request.params.cursor ? { data: state.queue.slice(1), nextCursor: null } : { data: state.queue.slice(0, 1), nextCursor: state.queue.length > 1 ? 'q2' : null }; break;
            case 'thread/queue/add':
                state.queue.push({ id: 'queued-1', input: request.params.input, clientUserMessageId: request.params.clientUserMessageId });
                if (state.ignoreAdd) return;
                result = { queuedSubmission: state.queue.at(-1) }; break;
            case 'turn/steer': {
                if (state.steerError) { socket.send(JSON.stringify({ id: request.id, error: state.steerError })); return; }
                const turn = state.turns.get(request.params.threadId)?.at(-1);
                if (turn?.status !== 'inProgress' || turn.id !== request.params.expectedTurnId) {
                    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Active turn mismatch' } })); return;
                }
                state.steers.push(request.params);
                if (state.steerConfirm) state.queue.push({ id: `answer-${state.steers.length}`, input: request.params.input, clientUserMessageId: request.params.clientUserMessageId });
                if (state.steerGate) {
                    const gate = state.steerGate; state.steerGate = null;
                    gate.entered.resolve(); await gate.promise;
                }
                if (state.ignoreSteer) return;
                result = { turnId: turn.id }; break;
            }
            default: socket.send(JSON.stringify({ id: request.id, error: { code: -32601 } })); return;
        }
        if (socket.readyState === 1) socket.send(JSON.stringify({ id: request.id, result }));
    }));
    await new Promise(resolve => codexServer.listen(codexPath, resolve));
    const herdrServer = net.createServer(socket => {
        let data = '';
        socket.on('data', async chunk => {
            data += chunk.toString();
            if (!data.includes('\n')) return;
            const request = JSON.parse(data.slice(0, data.indexOf('\n')));
            state.herdrCalls.push(request);
            if (state.failHerdr) { socket.end(`${JSON.stringify({ id: request.id, error: { code: 'unavailable' } })}\n`); return; }
            if (state.ignoreHerdrMethod === request.method) return;
            let result;
            switch (request.method) {
                case 'pane.list': result = { type: 'pane_list', panes: state.panes }; break;
                case 'workspace.create': case 'tab.create': {
                    const n = state.creates.length + 10;
                    const workspace = request.params.workspace_id || `launch-w${n}`;
                    const pane = { pane_id: `launch-p${n}`, terminal_id: `launch-term${n}`, tab_id: `launch-tab${n}`,
                        workspace_id: workspace, cwd: request.params.cwd, agent_status: 'idle' };
                    state.creates.push(request); state.panes.push(pane);
                    const shellPid = 1000 + n;
                    state.processes.set(pane.pane_id, { shell_pid: state.initialShellPending ? null : shellPid, foreground_process_group_id: state.initialShellPending ? null : state.busyShell ? shellPid + 1 : shellPid,
                        foreground_processes: state.initialShellPending ? [] : [{ pid: state.busyShell ? shellPid + 1 : shellPid, name: state.busyShell ? 'sleep' : 'zsh', argv0: state.busyShell ? 'sleep' : 'zsh', argv: [state.busyShell ? 'sleep' : '-zsh'] }] });
                    if (state.createGate) await state.createGate.promise;
                    if (state.ignoreCreate) return;
                    result = state.malformedCreate ? {} : { root_pane: pane, tab: { tab_id: pane.tab_id } };
                    break;
                }
                case 'pane.get': {
                    const pane = state.panes.find(pane => pane.pane_id === request.params.pane_id);
                    if (!pane) {
                        socket.end(`${JSON.stringify({ id: request.id, error: { code: 'pane_not_found', message: `pane ${request.params.pane_id} not found` } })}\n`);
                        return;
                    }
                    result = { pane }; break;
                }
                case 'pane.process_info': {
                    const process = state.processInfoSteps.get(request.params.pane_id)?.shift() || state.processes.get(request.params.pane_id) || state.process;
                    result = { type: 'pane_process_info', process_info: { pane_id: request.params.pane_id, ...process } }; break;
                }
                case 'pane.read': {
                    result = { type: 'pane_read', read: { text: request.params.format === 'ansi' ? state.ansiScreen : state.screen, pane_id: state.readPaneId ?? request.params.pane_id } };
                    const gate = state.readGate;
                    if (gate?.paneId === request.params.pane_id) {
                        state.readGate = null;
                        gate.entered.resolve();
                        await gate.promise;
                    }
                    break;
                }
                case 'pane.send_input':
                    state.writes.push(request.params);
                    if (request.params.pane_id.startsWith('launch-p') && request.params.text === 'env -u CODEX_THREAD_ID codex' && request.params.keys?.[0] === 'Enter') {
                        const pane = state.panes.find(pane => pane.pane_id === request.params.pane_id);
                        const process = state.processes.get(pane.pane_id);
                        if (process.foreground_processes[0].name === 'zsh') {
                            const pid = process.shell_pid + 100;
                            process.foreground_process_group_id = pid;
                            process.foreground_processes = [{ pid, name: 'codex', argv: ['codex'], cwd: pane.cwd }];
                            if (state.launchThread) state.resolveLaunch(pane);
                        }
                    }
                    if (state.changeProcessOnInput) state.process.foreground_process_group_id++;
                    if (state.ignoreInput) return;
                    result = { type: 'ok' }; break;
                default: socket.end(`${JSON.stringify({ id: request.id, error: { code: 'unknown' } })}\n`); return;
            }
            socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        });
        socket.on('error', () => {});
    });
    await new Promise(resolve => herdrServer.listen(herdrPath, resolve));
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`, token = 'fake-secret-token';
    const codex = new CodexClient(codexPath, 150);
    const claude = new ClaudeReader({ configDir: join(dir, 'claude'), now, run: async () => {
        state.claudeCalls++;
        if (state.failClaude) throw new Error('Session listing failed');
        const stdout = JSON.stringify(state.claudeSessions);
        const gate = state.claudeGate;
        if (gate) {
            state.claudeGate = null;
            gate.entered.resolve();
            await gate.promise;
        }
        return { stdout };
    } });
    const service = new MonitorService(codex, new HerdrClient(herdrPath, 1000), async pids => {
        if (state.failPresence) throw new Error('OS resource read failed');
        return new Map(pids.filter(pid => state.resources.has(pid)).map(pid => [pid, state.resources.get(pid)]));
    }, claude);
    const server = createMonitorServer({ service, token, origin });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    const request = async (path, body, overrides = {}) => {
        const response = await fetch(`${origin}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${token}`, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...overrides },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json(), headers: response.headers };
    };
    return { state, service, server, origin, token, request, codexPath, herdrPath,
        async addClaude(only = false) {
            const session = { kind: 'interactive', pid: 501, sessionId: '4f55aea2-d010-4e32-8e4b-16d2a83acb74', cwd: '/projects/agent-monitor', startedAt: 1792122240000, name: 'Claudeで表示を確認', status: 'idle' };
            const pane = { pane_id: 'w5:p5', terminal_id: 'term5', tab_id: 'tab5', workspace_id: 'w5', cwd: session.cwd,
                agent_status: 'idle', agent_session: { value: session.sessionId, agent: 'claude' }, terminal_title: 'Claude Code' };
            state.claudeSessions.push(session);
            state.panes = only ? [pane] : [...state.panes, pane];
            const process = { shell_pid: 500, foreground_process_group_id: 501, foreground_processes: [{ pid: 501, name: '2.1.301', argv0: 'claude', cwd: session.cwd }] };
            state.processes.set(pane.pane_id, process);
            state.ansiScreen = claudeScreen(); state.screen = 'Claude Code\n❯ 次の指示';
            const projectDir = join(claude.configDir, 'projects', 'arbitrary-project-encoding');
            await mkdir(projectDir, { recursive: true });
            const path = join(projectDir, `${session.sessionId}.jsonl`);
            let sequence = 0;
            const row = (type, content, extra = {}) => ({ type, uuid: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
                sessionId: session.sessionId, cwd: session.cwd, timestamp: new Date(session.startedAt + sequence * 1000).toISOString(),
                message: { role: type, content }, ...extra });
            return { id: `claude:${session.sessionId}`, session, pane, process, path, row,
                async write(rows) { await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); },
                async append(rows) { await appendFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); } };
        },
        async close() {
            codex.close();
            for (const socket of wss.clients) socket.terminate();
            server.closeAllConnections();
            await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => codexServer.close(resolve)), new Promise(resolve => herdrServer.close(resolve))]);
            await rm(dir, { recursive: true, force: true });
        },
    };
}
