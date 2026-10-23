import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fakes.js';

async function waitFor(read, check) {
    const deadline = Date.now() + 6000;
    while (true) {
        const value = await read();
        if (check(value)) return value;
        if (Date.now() > deadline) throw new Error('Launch condition timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function launchFixture(t) {
    const f = await fixture();
    t.after(() => f.close());
    const path = await realpath(await mkdtemp(join(tmpdir(), 'am-launch-')));
    t.after(() => rm(path, { recursive: true, force: true }));
    const status = id => f.request(`/api/launches/${id}`).then(result => result.body);
    const settled = id => waitFor(() => status(id), result => result.operation.state !== 'processing');
    return { ...f, path, status, settled };
}

test('directory browsing authenticates, resolves paths and lists only immediate real directories', async t => {
    const f = await launchFixture(t);
    const endpoint = path => `/api/directories?path=${encodeURIComponent(path)}`;
    assert.equal((await f.request('/api/directories', undefined, { Authorization: '' })).status, 401);
    assert.equal((await f.request('/api/directories', undefined, { Origin: 'https://evil.example' })).status, 403);
    for (const path of ['', 'relative', '~someone', '/bad\npath', '/'.repeat(4097), join(f.path, 'missing')]) {
        assert.equal((await f.request(endpoint(path))).status, 400);
    }
    await mkdir(join(f.path, 'zeta'));
    await mkdir(join(f.path, '.hidden'));
    await mkdir(join(f.path, 'alpha'));
    await mkdir(join(f.path, 'alpha', 'nested'));
    await writeFile(join(f.path, 'file'), 'file');
    await symlink(join(f.path, 'alpha'), join(f.path, 'alias'));
    const result = await f.request(endpoint(f.path));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { path: f.path, parent: join(f.path, '..'), truncated: false,
        directories: ['.hidden', 'alpha', 'zeta'].map(name => ({ name, path: join(f.path, name) })) });
    const alias = (await f.request(endpoint(join(f.path, 'alias')))).body;
    assert.equal(alias.path, join(f.path, 'alpha'));
    assert.equal(alias.parent, f.path);
    assert.equal((await f.request(endpoint('/'))).body.parent, null);
    assert.equal((await f.request('/api/directories')).body.path, await realpath(homedir()));
    assert.equal((await f.request(endpoint(join(f.path, 'file')))).status, 400);
    const empty = await f.request(endpoint(join(f.path, 'zeta')));
    assert.deepEqual(empty.body.directories, []);
    assert.equal(empty.body.truncated, false);
    await chmod(join(f.path, 'zeta'), 0);
    try {
        if (process.getuid?.() !== 0) {
            const denied = await f.request(endpoint(join(f.path, 'zeta')));
            assert.equal(denied.status, 403);
            assert.match(denied.body.error, /アクセス権/);
        }
    } finally { await chmod(join(f.path, 'zeta'), 0o700); }
    assert.equal(f.state.creates.length, 0);
    assert.equal(f.state.writes.length, 0);
});

test('directory browsing bounds returned directories and scanned files with an incomplete flag', async t => {
    const f = await launchFixture(t);
    const many = join(f.path, 'many'), files = join(f.path, 'files');
    await mkdir(many); await mkdir(files);
    await Promise.all(Array.from({ length: 205 }, (_, i) => mkdir(join(many, `folder-${String(i).padStart(3, '0')}`))));
    await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(join(files, `file-${i}`), '')));
    const listing = (await f.request(`/api/directories?path=${encodeURIComponent(many)}`)).body;
    assert.equal(listing.directories.length, 200);
    assert.equal(listing.truncated, true);
    const names = listing.directories.map(entry => entry.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ja')));
    const scanned = (await f.request(`/api/directories?path=${encodeURIComponent(files)}`)).body;
    assert.deepEqual(scanned.directories, []);
    assert.equal(scanned.truncated, true);
});

test('launch authentication and path validation keep paths out of shell commands', async t => {
    const f = await launchFixture(t);
    const { request, state } = f;
    const body = { path: f.path, requestId: 'launch_path_1234567890' };
    assert.equal((await request('/api/launches', body, { Authorization: '' })).status, 401);
    assert.equal((await request('/api/launches', body, { Origin: '' })).status, 403);
    for (const path of ['', 'relative', '~someone', '/bad\npath', '/bad\u0085path', '/'.repeat(4097), join(f.path, 'missing'), new URL('../package.json', import.meta.url).pathname]) {
        assert.equal((await request('/api/launches', { ...body, path })).status, 400);
    }
    assert.equal(state.creates.length, 0);
    const path = join(f.path, 'project;$(touch injected) `id`');
    await mkdir(path);
    assert.equal((await request('/api/launches', { ...body, path })).status, 200);
    const result = await f.settled(body.requestId);
    assert.equal(result.phase, 'codex');
    assert.deepEqual(state.creates[0].params, { label: 'project;$(touch injected) `id`', cwd: path, focus: false });
    assert.deepEqual(state.writes, [
        { pane_id: result.pane.id, text: 'env -u CODEX_THREAD_ID codex', keys: ['Enter'] },
    ]);
    const home = { path: '~', requestId: 'launch_home_1234567890' };
    await request('/api/launches', home);
    assert.equal((await f.settled(home.requestId)).path, homedir());
});

test('launch creation is serialized and normalized workspaces and request IDs are reused', async t => {
    const f = await launchFixture(t);
    const alias = join(f.path, 'alias');
    const directory = join(f.path, 'project');
    await mkdir(directory); await symlink(directory, alias);
    f.state.panes[0].cwd = alias; f.state.panes[1].cwd = directory;
    const existing = { path: directory, requestId: 'launch_existing_12345678' };
    await f.request('/api/launches', existing);
    await f.settled(existing.requestId);
    assert.deepEqual(f.state.creates[0].params, { workspace_id: 'w1', cwd: directory, focus: false });
    const path = join(f.path, 'new'); await mkdir(path);
    f.state.createGate = Promise.withResolvers();
    const first = { path, requestId: 'launch_serial_one_123456' };
    const second = { path, requestId: 'launch_serial_two_123456' };
    await f.request('/api/launches', first);
    await waitFor(async () => f.state.creates.length, length => length === 2);
    await f.request('/api/launches', second);
    await f.request('/api/launches', first);
    assert.equal(f.state.creates.length, 2);
    assert.equal((await f.request('/api/launches', { ...first, path: directory })).status, 409);
    f.state.createGate.resolve();
    const results = await Promise.all([f.settled(first.requestId), f.settled(second.requestId)]);
    assert.equal(f.state.creates.length, 3);
    assert.deepEqual(f.state.creates.slice(1).map(call => call.method), ['workspace.create', 'tab.create']);
    assert.equal(f.state.creates[2].params.workspace_id, results[0].pane.workspace);
    assert.notEqual(results[0].pane.id, results[1].pane.id);
    await f.request('/api/launches', first);
    assert.equal(f.state.writes.filter(write => write.text === 'env -u CODEX_THREAD_ID codex').length, 3);
});

test('launch trust terminal is restricted to the original Codex and hands off by PID resources', async t => {
    const f = await launchFixture(t);
    f.state.launchThread = false; f.state.busyShell = true;
    const body = { path: f.path, requestId: 'launch_trust_1234567890' };
    await f.request('/api/launches', body);
    const creating = await waitFor(() => f.status(body.requestId), result => result.pane);
    const endpoint = `/api/launches/${body.requestId}`;
    assert.equal((await f.request(`${endpoint}/bind`, { paneId: creating.pane.id })).status, 409);
    f.state.busyShell = false;
    const sibling = { path: f.path, requestId: 'launch_while_shell_waits_123456' };
    await f.request('/api/launches', sibling);
    assert.notEqual((await f.settled(sibling.requestId)).pane.id, creating.pane.id);
    assert.equal((await f.status(body.requestId)).phase, 'shell');
    const process = f.state.processes.get(creating.pane.id);
    process.foreground_process_group_id = process.shell_pid;
    process.foreground_processes = [{ pid: process.shell_pid, name: 'zsh', argv0: 'zsh', argv: ['-zsh'] }];
    const launched = await f.settled(body.requestId);
    assert.equal(launched.state, 'waiting');
    assert.equal(launched.terminalAvailable, true);
    const pane = f.state.panes.find(pane => pane.pane_id === launched.pane.id);
    pane.agent_session = { value: 'a', agent: 'codex' };
    assert.equal((await f.status(body.requestId)).state, 'waiting');
    assert.equal((await f.request(`${endpoint}/bind`, { paneId: 'w1:p1' })).status, 409);
    const binding = (await f.request(`${endpoint}/bind`, { paneId: pane.pane_id })).body;
    const view = (await f.request(`${endpoint}/terminal?bindingId=${binding.bindingId}`)).body;
    const input = { requestId: 'launch_trust_input_123456', bindingId: binding.bindingId, viewId: view.viewId, key: 'Enter' };
    assert.equal((await f.request('/api/threads/a/terminal-input', input)).body.state, 'failed');
    input.requestId = 'launch_trust_valid_123456';
    assert.equal((await f.request(`${endpoint}/terminal-input`, input)).body.state, 'succeeded');
    assert.equal(f.state.writes.at(-1).pane_id, pane.pane_id);
    const id = f.state.resolveLaunch(pane);
    const ready = await f.status(body.requestId);
    assert.equal(ready.state, 'ready'); assert.equal(ready.thread.id, id);
    assert.equal(ready.terminalAvailable, false);
    assert.equal((await f.request(`${endpoint}/terminal?bindingId=${binding.bindingId}`)).status, 409);
    assert.equal((await f.request(`/api/threads/${id}/state`)).status, 200);
    const sent = await f.request(`/api/threads/${id}/send`, { requestId: 'launch_first_message_123456', text: '最初の指示' });
    assert.equal(sent.body.state, 'succeeded');
    assert.equal(f.state.calls.find(call => call.method === 'thread/queue/add').params.threadId, id);
    process.foreground_process_group_id = process.shell_pid;
    process.foreground_processes = [{ pid: process.shell_pid, name: 'zsh', argv0: 'zsh', argv: ['-zsh'] }];
    assert.equal((await f.status(body.requestId)).state, 'ended');
});

test('shell preparation and read recovery preserve the launch and allow handoff', async t => {
    const f = await launchFixture(t);
    f.state.initialShellPending = true; f.state.launchThread = false;
    const body = { path: f.path, requestId: 'launch_initial_shell_123456' };
    await f.request('/api/launches', body);
    const initial = await waitFor(() => f.status(body.requestId), result => result.phase === 'shell');
    await waitFor(async () => f.state.herdrCalls.some(call => call.method === 'pane.process_info' && call.params.pane_id === initial.pane.id), Boolean);
    const waiting = await f.status(body.requestId);
    assert.equal(waiting.state, 'waiting'); assert.equal(waiting.operation.state, 'processing');
    assert.equal(f.state.writes.length, 0);
    const shellPid = 1010;
    const shell = { shell_pid: shellPid, foreground_process_group_id: shellPid,
        foreground_processes: [{ pid: shellPid, name: 'zsh', argv0: 'zsh', argv: ['-zsh'], cwd: f.path }] };
    const hook = { ...shell, foreground_processes: [...shell.foreground_processes,
        { pid: shellPid + 1, name: 'direnv', argv: ['direnv', 'hook', 'zsh'], cwd: f.path }] };
    const steps = [shell, hook];
    f.state.processInfoSteps.set(initial.pane.id, steps);
    f.state.processes.set(initial.pane.id, hook);
    await waitFor(async () => steps.length, length => length === 0);
    assert.equal((await f.status(body.requestId)).phase, 'shell');
    assert.equal(f.state.writes.length, 0);
    f.state.processes.set(initial.pane.id, shell);
    assert.equal((await f.settled(body.requestId)).terminalAvailable, true);
    assert.deepEqual(f.state.writes, [{ pane_id: initial.pane.id, text: 'env -u CODEX_THREAD_ID codex', keys: ['Enter'] }]);
    const initialEndpoint = `/api/launches/${body.requestId}`;
    for (const [path, payload] of [[initialEndpoint], [`${initialEndpoint}/bind`, { paneId: initial.pane.id }]]) {
        f.state.ignoreHerdrMethod = 'pane.get';
        assert.equal((await f.request(path, payload)).status, 502, path);
        f.state.ignoreHerdrMethod = null;
        const recovered = await f.request(initialEndpoint);
        assert.equal(recovered.status, 200);
        assert.equal(recovered.body.state, 'waiting'); assert.equal(recovered.body.pane.id, initial.pane.id);
    }
    const initialBinding = await f.request(`${initialEndpoint}/bind`, { paneId: initial.pane.id });
    assert.equal(initialBinding.status, 200);
    const initialView = await f.request(`${initialEndpoint}/terminal?bindingId=${initialBinding.body.bindingId}`);
    assert.equal(initialView.status, 200);
    const resumedInput = await f.request(`${initialEndpoint}/terminal-input`, { requestId: 'launch_read_recovered_input_123456',
        bindingId: initialBinding.body.bindingId, viewId: initialView.body.viewId, key: 'Enter' });
    assert.equal(resumedInput.body.state, 'succeeded');
    const pane = f.state.panes.find(pane => pane.pane_id === initial.pane.id);
    const threadId = f.state.resolveLaunch(pane);
    f.state.loadedIds.push(threadId, 'missing-thread');
    const ready = await f.status(body.requestId);
    assert.equal(ready.state, 'ready'); assert.equal(ready.thread.id, threadId);
    const list = await f.request('/api/threads');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.threads.map(thread => thread.id), ['a', 'b', threadId]);
    for (const method of ['thread/read', 'mcpServerStatus/list']) {
        f.state.ignoreCodexMethod = method;
        assert.equal((await f.request(initialEndpoint)).status, 502, method);
        f.state.ignoreCodexMethod = null;
        const recovered = await f.request(initialEndpoint);
        assert.equal(recovered.status, 200);
        assert.equal(recovered.body.state, 'ready'); assert.equal(recovered.body.thread.id, threadId);
    }
    f.state.mcpError = { code: -32601, message: 'Method not found' };
    assert.equal((await f.status(body.requestId)).state, 'ready');
    f.state.mcpError = null;
    assert.equal(f.state.writes.filter(write => write.text === 'env -u CODEX_THREAD_ID codex').length, 1);
    f.state.failHerdr = true;
    assert.equal((await f.request(`/api/launches/${body.requestId}`)).status, 502);
    f.state.failHerdr = false;
    assert.equal((await f.status(body.requestId)).state, 'ready');
    f.state.panes = f.state.panes.filter(pane => pane.pane_id !== initial.pane.id);
    const closed = await f.request(`/api/launches/${body.requestId}`);
    assert.equal(closed.status, 200); assert.equal(closed.body.state, 'ended');
    assert.equal(closed.body.terminalAvailable, false);
    f.state.initialShellPending = false;
    const next = { path: f.path, requestId: 'launch_after_closed_pane_123456' };
    await f.request('/api/launches', next);
    const nextState = await f.settled(next.requestId);
    assert.equal(nextState.state, 'waiting');
    const endpoint = `/api/launches/${next.requestId}`;
    const binding = (await f.request(`${endpoint}/bind`, { paneId: nextState.pane.id })).body;
    const view = (await f.request(`${endpoint}/terminal?bindingId=${binding.bindingId}`)).body;
    f.state.panes = f.state.panes.filter(pane => pane.pane_id !== nextState.pane.id);
    const input = await f.request(`${endpoint}/terminal-input`, { requestId: 'launch_closed_terminal_123456', bindingId: binding.bindingId, viewId: view.viewId, key: 'Enter' });
    assert.equal(input.body.state, 'failed');
    assert.equal((await f.status(next.requestId)).state, 'ended');
    assert.equal(f.state.creates.length, 2);
});

test('closing a pane during shell preparation ends the launch without sending a command', async t => {
    const f = await launchFixture(t); f.state.initialShellPending = true;
    const body = { path: f.path, requestId: 'launch_closed_shell_123456' };
    await f.request('/api/launches', body);
    const waiting = await waitFor(() => f.status(body.requestId), result => result.phase === 'shell');
    f.state.panes = f.state.panes.filter(pane => pane.pane_id !== waiting.pane.id);
    const ended = await f.settled(body.requestId);
    assert.equal(ended.state, 'ended'); assert.equal(f.state.writes.length, 0);
});

test('replacement processes and changed pane resources never receive launch terminal input', async t => {
    for (const change of ['process', 'terminal', 'tab', 'workspace']) {
        await t.test(change, async t => {
            const f = await launchFixture(t); f.state.launchThread = false;
            const body = { path: f.path, requestId: `launch_replace_${change}_123456` };
            await f.request('/api/launches', body);
            const launched = await f.settled(body.requestId);
            const endpoint = `/api/launches/${body.requestId}`;
            const binding = (await f.request(`${endpoint}/bind`, { paneId: launched.pane.id })).body;
            const view = (await f.request(`${endpoint}/terminal?bindingId=${binding.bindingId}`)).body;
            if (change === 'process') f.state.processes.get(launched.pane.id).foreground_processes[0].pid++;
            else f.state.panes.find(pane => pane.pane_id === launched.pane.id)[`${change}_id`] += '-replaced';
            const result = await f.request(`${endpoint}/terminal-input`, { requestId: 'launch_replaced_input_123456', bindingId: binding.bindingId, viewId: view.viewId, key: 'Enter' });
            assert.equal(result.body.state, 'failed');
            assert.equal(f.state.writes.length, 1);
            assert.equal((await f.status(body.requestId)).state, 'unknown');
            assert.equal((await f.request(`${endpoint}/bind`, { paneId: launched.pane.id })).status, 409);
        });
    }
});

test('unknown creation blocks queued launches until an authenticated confirmation for that request', async t => {
    const f = await launchFixture(t); f.state.ignoreCreate = true;
    const first = { path: f.path, requestId: 'launch_unknown_create_123456' };
    const second = { path: f.path, requestId: 'launch_blocked_create_123456' };
    await f.request('/api/launches', first);
    await f.request('/api/launches', second);
    assert.equal((await f.settled(first.requestId)).state, 'unknown');
    const blocked = await f.settled(second.requestId);
    assert.equal(blocked.state, 'failed'); assert.equal(blocked.blockedBy, first.requestId);
    assert.equal(f.state.creates.length, 1);
    await f.request('/api/launches', first);
    assert.equal(f.state.creates.length, 1);
    const confirm = `/api/launches/${first.requestId}/confirm`;
    assert.equal((await f.request(confirm, { confirmed: true }, { Authorization: '' })).status, 401);
    assert.equal((await f.request(confirm, { confirmed: true }, { Origin: '' })).status, 403);
    assert.equal((await f.request(`/api/launches/${second.requestId}/confirm`, { confirmed: true })).status, 409);
    assert.equal((await f.request(confirm, {})).status, 409);
    const third = { path: f.path, requestId: 'launch_still_blocked_123456' };
    await f.request('/api/launches', third);
    assert.equal((await f.settled(third.requestId)).state, 'failed');
    assert.equal((await f.request(confirm, { confirmed: true })).body.confirmed, true);
    assert.equal((await f.status(first.requestId)).state, 'unknown');
    f.state.ignoreCreate = false;
    const next = { path: f.path, requestId: 'launch_after_confirm_123456' };
    await f.request('/api/launches', next);
    assert.equal((await f.settled(next.requestId)).state, 'ready');
    assert.equal(f.state.creates.length, 2);
    assert.equal(f.state.herdrCalls.some(call => /delete|close/.test(call.method)), false);
});

test('unknown command delivery is retained and prevents another launch', async t => {
    const f = await launchFixture(t); f.state.ignoreInput = true;
    const body = { path: f.path, requestId: 'launch_unknown_input_123456' };
    await f.request('/api/launches', body);
    const result = await f.settled(body.requestId);
    assert.equal(result.state, 'unknown'); assert.equal(result.operation.state, 'unknown');
    await f.request('/api/launches', body);
    await f.request('/api/launches', { ...body, requestId: 'launch_after_unknown_123456' });
    await f.settled('launch_after_unknown_123456');
    assert.equal(f.state.creates.length, 1);
    assert.equal(f.state.writes.length, 1);
    assert.deepEqual(f.state.writes[0], { pane_id: result.pane.id, text: 'env -u CODEX_THREAD_ID codex', keys: ['Enter'] });
});
