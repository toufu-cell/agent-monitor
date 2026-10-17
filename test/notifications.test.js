import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fakes.js';
import { Notifications } from '../src/notifications.js';
import { createMonitorServer } from '../src/server.js';

export function pushSubscription(suffix = 'device') {
    const ecdh = createECDH('prime256v1');
    return { endpoint: `https://web.push.apple.com/${suffix}`, keys: {
        p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url'),
    } };
}

async function setup(t, fixtureOptions) {
    const f = await fixture(fixtureOptions); t.after(() => f.close());
    const directory = await mkdtemp(join(tmpdir(), 'am-notifications-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sent = [];
    let failure = null;
    const options = { service: f.service, origin: 'https://monitor.example.ts.net', file: join(directory, 'push/notifications.json'), intervalMs: 60000,
        send: async (subscription, payload, options) => {
            sent.push({ subscription, payload: JSON.parse(payload), options });
            if (failure) throw failure;
        } };
    const notifications = await new Notifications(options).open();
    t.after(() => notifications.close());
    return { ...f, directory, options, notifications, sent, fail: value => { failure = value; } };
}

test('push monitoring uses loaded questions without list, shares sources and detects only valid changes', async t => {
    let now = 0;
    const f = await setup(t, { now: () => now });
    const { notifications: push, state, service, sent } = f;
    const c = await f.addClaude();
    c.session.status = 'busy'; c.pane.agent_status = 'working';
    const baseline = state.ask();
    let presenceReads = 0;
    const presence = service.presence;
    service.presence = async pids => { presenceReads++; return presence(pids); };
    state.failHistory = true;
    await push.subscribe(pushSubscription());
    assert.equal(presenceReads, 1);
    assert.equal(sent.length, 0);
    assert.ok(service.known.has('a'));
    assert.ok(service.known.has(c.id));
    state.failHistory = false;
    await push.poll(); assert.equal(sent.length, 0);
    assert.equal((await service.questionState('a')).questions.length, 2);
    baseline.items[0].questions[0].options = ['更新した選択肢'];
    await push.poll(); assert.equal(sent.length, 0);
    const question = { id: 'later-question', type: 'agentMessage', text: '本文は通知へ含めない', questions: [{ title: '質問の内容は通知へ含めない' }] };
    baseline.items.push(question);
    await push.poll();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].payload, { title: 'モバイル表示を整える', body: '回答待ちの質問があります', url: '/?thread=a' });
    assert.equal(sent[0].options.timeout, 10000);
    await push.poll(); assert.equal(sent.length, 1);
    state.queue.push({ id: 'answered', input: [{ type: 'text', text: '<send_user_message_question_reply>' + JSON.stringify({ questionItemId: JSON.stringify(['request_user_input_async', question.id, 0]), question: '質問', answer: '回答' }) + '</send_user_message_question_reply>' }] });
    await push.poll(); assert.equal(sent.length, 1);
    state.queue = [];
    await push.poll(); assert.equal(sent.length, 1);
    const beforeIdle = state.calls.length;
    state.threads.get('a').status = { type: 'idle' }; state.panes[0].agent_status = 'idle'; baseline.status = 'completed';
    c.session.status = 'idle'; c.pane.agent_status = 'idle';
    now += 1000;
    await push.poll();
    assert.equal(state.calls.slice(beforeIdle).some(call => call.method === 'thread/turns/list' && call.params.threadId === 'a'), false);
    assert.deepEqual(sent.slice(1).map(value => value.payload.body), ['作業が完了しました', '作業が完了しました']);
    await push.poll(); assert.equal(sent.length, 3);
    for (const failure of ['unknown', 'sources', 'questions', 'queue', 'closed']) {
        state.threads.get('a').status = { type: 'active', activeFlags: [] }; state.panes[0].agent_status = 'working';
        await push.poll();
        if (failure === 'unknown') { state.threads.get('a').status = { type: 'unknown' }; state.panes[0].agent_status = 'unknown'; }
        if (failure === 'sources') state.failPresence = true;
        if (failure === 'questions') state.failHistory = true;
        if (failure === 'queue') state.failState = true;
        const panes = state.panes;
        if (failure === 'closed') state.panes = state.panes.filter(pane => pane.pane_id !== 'w1:p1');
        await push.poll();
        state.failPresence = false; state.failHistory = false; state.failState = false; state.panes = panes;
        state.threads.get('a').status = { type: 'idle' }; state.panes[0].agent_status = 'idle';
        await push.poll();
        assert.equal(sent.length, 3, failure);
    }
    state.threads.set('new', { ...state.threads.get('a'), id: 'new', name: '新しい会話 /private/secret' });
    state.turns.set('new', []); state.loadedIds.push('new'); state.origins.set('new', 'http://127.0.0.1:41001');
    state.origins.set('a', null);
    state.resources.get(200).threadIds = new Set(['new']);
    const added = state.ask('new', [{ title: '新しい質問' }]);
    const before = presenceReads;
    await push.poll();
    assert.equal(presenceReads - before, 1);
    assert.ok(service.known.has('new')); assert.ok(service.known.has('a'));
    assert.equal(sent.at(-1).payload.body, '回答待ちの質問があります');
    assert.equal(sent.at(-1).payload.url, '/?thread=new');
    assert.equal(sent.at(-1).payload.title.includes('/private'), false);
    added.items[0].questions[0].options = ['A'];
    await push.poll(); assert.equal(sent.length, 4);
    state.threads.get('new').name = null;
    state.threads.get('new').preview = '通知へ含めない会話本文';
    added.items.push({ ...question, id: 'unnamed-question' });
    await push.poll();
    const unnamedTitle = sent.at(-1).payload.title;
    const beforeMissing = sent.length, panes = state.panes;
    state.panes = panes.filter(pane => pane.pane_id !== 'w1:p1');
    await push.poll();
    state.panes = panes;
    await push.poll();
    const repeatedQuestions = sent.length - beforeMissing;
    const beforeNewQuestion = sent.length;
    added.items.push({ ...question, id: 'question-after-return' });
    await push.poll();
    const newQuestions = sent.length - beforeNewQuestion;
    const beforeEnd = sent.length;
    state.panes = panes.filter(pane => pane.pane_id !== 'w1:p1');
    await push.poll();
    state.panes = panes;
    state.threads.get('new').status = { type: 'idle' }; state.panes[0].agent_status = 'idle'; added.status = 'completed';
    await push.poll();
    assert.deepEqual({ unnamedTitle, repeatedQuestions, newQuestions, endedNotifications: sent.length - beforeEnd },
        { unnamedTitle: '名前のない会話', repeatedQuestions: 0, newQuestions: 1, endedNotifications: 0 });
    assert.equal(service.known.get('new').title, state.threads.get('new').preview);
    now += 1000;
    const listed = await service.list(), claudeCalls = state.claudeCalls;
    assert.equal(listed.threads.find(thread => thread.id === 'new').title, state.threads.get('new').preview);
    await push.poll();
    assert.equal(state.claudeCalls, claudeCalls);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    service.presence = async pids => { presenceReads++; entered.resolve(); await gate.promise; return presence(pids); };
    const beforeConcurrent = presenceReads;
    const first = push.poll(); await entered.promise;
    const second = push.poll(); gate.resolve();
    await Promise.all([first, second]);
    assert.equal(presenceReads - beforeConcurrent, 1);
    assert.equal(state.calls.some(call => ['thread/resume', 'thread/load', 'thread/subscribe', 'turn/steer'].includes(call.method)), false);
    assert.equal(state.writes.length, 0);
});

test('push HTTP preserves authentication, validates recipients and persists registration across restart', async t => {
    const f = await setup(t);
    let push = f.notifications;
    const origin = f.options.origin;
    let server = createMonitorServer({ service: f.service, notifications: push, origin, tailscaleLogin: 'owner@example.com' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const request = (path, body, overrides = {}) => new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path,
            method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(origin).host, Origin: origin,
                'Tailscale-User-Login': 'owner@example.com', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...overrides } }, response => {
            let text = ''; response.setEncoding('utf8'); response.on('data', value => { text += value; });
            response.on('end', () => { resolve({ status: response.statusCode, body: JSON.parse(text) }); });
        });
        request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const subscription = pushSubscription();
    for (const headers of [{ 'Tailscale-User-Login': '' }, { 'Tailscale-User-Login': 'other@example.com' }, { Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Origin: '' }]) {
        const denied = await request('/api/notifications/subscribe', { subscription }, headers);
        assert.ok([401, 403].includes(denied.status));
    }
    for (const endpoint of ['http://web.push.apple.com/test', 'https://127.0.0.1/internal', 'https://fcm.googleapis.com.evil.example/test', 'https://web.push.apple.com:444/test', 'https://user@web.push.apple.com/test', 'https://updates.push.services.mozilla.com/test#fragment']) {
        assert.equal((await request('/api/notifications/subscribe', { subscription: { ...subscription, endpoint } })).status, 400);
    }
    for (const keys of [{ ...subscription.keys, auth: 'bad' }, { ...subscription.keys, p256dh: Buffer.alloc(65).toString('base64url') }]) {
        assert.equal((await request('/api/notifications/subscribe', { subscription: { ...subscription, keys } })).status, 400);
    }
    const config = (await request('/api/notifications')).body;
    assert.equal(config.available, true); assert.equal(config.publicKey.length, 87);
    await Promise.all([request('/api/notifications/subscribe', { subscription }), request('/api/notifications/subscribe', { subscription: pushSubscription('second') })]);
    assert.deepEqual((await request('/api/notifications/status', { endpoint: subscription.endpoint })).body, { registered: true });
    assert.equal((await stat(f.options.file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.directory, 'push'))).mode & 0o777, 0o700);
    const saved = JSON.parse(await readFile(f.options.file, 'utf8'));
    assert.equal(saved.subscriptions.length, 2);
    assert.equal(JSON.stringify(config).includes(saved.vapid.privateKey), false);
    assert.equal((await request('/api/notifications/test', { endpoint: subscription.endpoint })).body.sent, true);
    assert.equal(f.sent.at(-1).payload.body, 'テスト通知です。');
    await push.close();
    push = await new Notifications(f.options).open(); t.after(() => push.close());
    assert.equal(push.status().publicKey, config.publicKey);
    assert.deepEqual(push.registered(subscription.endpoint), { registered: true });
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    server = createMonitorServer({ service: f.service, notifications: push, origin, tailscaleLogin: 'owner@example.com' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.equal((await request('/api/notifications/status', { endpoint: subscription.endpoint })).body.registered, true);
    assert.equal((await request('/api/notifications/test', { endpoint: subscription.endpoint })).body.sent, true);
    assert.deepEqual((await request('/api/notifications/unsubscribe', { endpoint: subscription.endpoint })).body, { registered: false });
    await request('/api/notifications/unsubscribe', { endpoint: 'https://web.push.apple.com/second' });
    const calls = f.state.calls.length;
    await push.poll(); assert.equal(f.state.calls.length, calls);
    assert.deepEqual(JSON.parse(await readFile(f.options.file, 'utf8')).subscriptions, []);
    assert.equal((await f.request('/api/notifications')).body.available, false);
    assert.equal((await f.request('/api/notifications/subscribe', { subscription })).status, 503);
    for (const [path, expected] of [['/?thread=a', 200], ['/?thread=a&thread=b', 404], ['/?token=secret', 404], ['/sw.js', 200], ['/sw.js?thread=a', 404], ['/manifest.webmanifest', 200], ['/icon.svg', 200]]) {
        assert.equal((await fetch(`${f.origin}${path}`)).status, expected, path);
    }
});

test('push scheduler monitors without a browser and stops after the last unsubscribe', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await setup(t);
    f.state.threads.get('a').status = { type: 'active', activeFlags: [] };
    f.state.panes[0].agent_status = 'working';
    const subscription = pushSubscription();
    await f.notifications.subscribe(subscription);
    const delivered = Promise.withResolvers();
    f.notifications.send = async (...args) => { await f.options.send(...args); delivered.resolve(); };
    f.state.threads.get('a').status = { type: 'idle' }; f.state.panes[0].agent_status = 'idle';
    t.mock.timers.tick(60000);
    await delivered.promise;
    await f.notifications.running;
    assert.equal(f.sent.at(-1).payload.body, '作業が完了しました');
    await f.notifications.unsubscribe(subscription.endpoint);
    const calls = f.state.calls.length;
    t.mock.timers.tick(120000);
    assert.equal(f.state.calls.length, calls);
});

test('push store failures preserve original bytes and expired subscriptions are removed safely', async t => {
    const f = await setup(t);
    const subscription = pushSubscription();
    await f.notifications.subscribe(subscription);
    f.fail({ statusCode: 410, message: subscription.endpoint });
    await assert.rejects(f.notifications.test(subscription.endpoint), /テスト通知を送信できません/);
    assert.equal(f.notifications.registered(subscription.endpoint).registered, false);
    assert.equal(JSON.parse(await readFile(f.options.file, 'utf8')).subscriptions.length, 0);
    f.fail({ statusCode: 500 });
    await f.notifications.subscribe(subscription);
    await assert.rejects(f.notifications.test(subscription.endpoint));
    assert.equal(f.notifications.registered(subscription.endpoint).registered, true);
    await f.notifications.close();
    const corrupt = 'invalid-json';
    await writeFile(f.options.file, corrupt);
    const broken = await new Notifications(f.options).open(); t.after(() => broken.close());
    assert.equal(broken.status().available, false);
    await assert.rejects(broken.subscribe(subscription), /保存ファイル/);
    assert.equal(await readFile(f.options.file, 'utf8'), corrupt);
    assert.equal(broken.status().error.includes(subscription.endpoint), false);
});
