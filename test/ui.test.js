import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { JSDOM } from 'jsdom';
import { fixture, codexScreen } from './fakes.js';
import { notificationFixture } from './notification-fixture.js';
import { createECDH, randomBytes } from 'node:crypto';

test('notification controls require permission and PC persistence, and survive page reload', async t => {
    const f = await notificationFixture(t);
    const ecdh = createECDH('prime256v1');
    const subscription = { endpoint: 'https://web.push.apple.com/ui-device', keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    let browserSubscription = null;
    let permission = 'default', permissionCalls = 0, inClick = false;
    const platformSubscription = { ...subscription, toJSON: () => subscription, unsubscribe: async () => { browserSubscription = null; return true; } };
    const registration = { pushManager: { getSubscription: async () => browserSubscription, subscribe: async () => { browserSubscription = platformSubscription; return browserSubscription; } } };
    async function load(url = f.origin) {
        const dom = new JSDOM(await readFile('dist/index.html', 'utf8'), { url, runScripts: 'outside-only', pretendToBeVisual: true });
        t.after(() => dom.window.close());
        const window = dom.window, $ = id => window.document.getElementById(id);
        window.AbortSignal = AbortSignal;
        window.isSecureContext = true; window.PushManager = function () {};
        window.Notification = { get permission() { return permission; }, requestPermission: async () => { assert.equal(inClick, true); permissionCalls++; return permission; } };
        Object.defineProperty(window.navigator, 'serviceWorker', { value: { register: async () => registration, ready: Promise.resolve(registration), addEventListener() {} } });
        window.fetch = (path, options) => f.request(path, options);
        window.setInterval = () => 0;
        window.eval(await readFile('dist/app.js', 'utf8'));
        await waitFor(() => $('notification-state').textContent !== '通知を確認中…');
        return { window, $ };
    }
    let ui = await load();
    assert.equal(ui.$('notification-toggle').hidden, false);
    assert.equal(permissionCalls, 0); assert.equal(ui.$('notification-test').hidden, true);
    inClick = true; ui.$('notification-toggle').click(); inClick = false;
    await waitFor(() => ui.$('notification-state').textContent.includes('通知を許可して'));
    assert.equal(ui.$('notification-test').hidden, true);
    permission = 'granted';
    const fetch = ui.window.fetch;
    ui.window.fetch = (path, options) => path.endsWith('/subscribe')
        ? f.request(path, { ...options, headers: { ...options.headers, Origin: 'https://evil.example' } }) : fetch(path, options);
    inClick = true; ui.$('notification-toggle').click(); inClick = false;
    await waitFor(() => ui.$('notification-state').textContent.includes('Origin'));
    assert.equal(ui.$('notification-test').hidden, true);
    assert.equal(f.notifications.registered(subscription.endpoint).registered, false);
    ui.window.fetch = fetch;
    inClick = true; ui.$('notification-toggle').click(); inClick = false;
    await waitFor(() => ui.$('notification-toggle').textContent === '通知を解除する');
    assert.equal(f.notifications.registered(subscription.endpoint).registered, true);
    ui.window.close(); ui = await load();
    assert.equal(ui.$('notification-toggle').textContent, '通知を解除する');
    assert.equal(ui.$('notification-test').hidden, false);
    ui.$('notification-test').click();
    await waitFor(() => ui.$('notification-state').textContent.includes('送信しました'));
    assert.equal(f.sent.at(-1).body, 'テスト通知です。');
    ui.$('notification-toggle').click();
    await waitFor(() => ui.$('notification-state').textContent === '通知を解除しました。');
    assert.equal(f.notifications.registered(subscription.endpoint).registered, false);
    assert.equal(browserSubscription, null);
    assert.equal(ui.$('notification-test').hidden, true);
    ui.window.close(); await f.notifications.close();
    ui = await load(`${f.origin}/?thread=ended#${f.token}`);
    const endedNotice = ' · 通知の会話は終了しているか、PCで開かれていません。';
    await waitFor(() => ui.$('connection').textContent === '2件の会話 · 接続済み' + endedNotice);
    assert.equal(ui.window.location.search, '?thread=ended'); assert.equal(ui.window.location.hash, '');
    assert.equal(ui.window.document.body.classList.contains('reading'), false);
    assert.equal(ui.$('notification-state').textContent, '通知を利用できません。');
    assert.equal(ui.$('notification-toggle').hidden, true);
    assert.equal(ui.$('notification-test').hidden, true);
    f.state.panes.pop();
    ui.window.document.dispatchEvent(new ui.window.Event('visibilitychange'));
    await waitFor(() => ui.$('connection').textContent === '1件の会話 · 接続済み' + endedNotice);
});

async function waitFor(check) {
    const deadline = Date.now() + 6000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('UI condition timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

async function mount(t, f, manualPolling = false, stored = {}, count = 2) {
    const dom = new JSDOM(await readFile('dist/index.html', 'utf8'), { url: `${f.origin}/#${f.token}`, runScripts: 'outside-only', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const window = dom.window;
    const $ = id => window.document.getElementById(id);
    window.fetch = (path, options) => fetch(`${f.origin}${path}`, { ...options, headers: { ...options.headers, Origin: f.origin } });
    window.AbortSignal = AbortSignal;
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    window.confirm = () => true;
    for (const [key, value] of Object.entries(stored)) window.sessionStorage.setItem(key, value);
    if (manualPolling) window.setInterval = () => 0;
    window.eval(await readFile('dist/app.js', 'utf8'));
    await waitFor(() => $('connection').textContent.includes(`${count}件`));
    return { window, $ };
}

test('image upload deadlines allow slow transfers while ordinary API deadlines stay short', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { window, $ } = await mount(t, f, true);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVQImWM4ZmdxzM6CAUIBACTWBPHkwkg6AAAAAElFTkSuQmCC', 'base64');
    const deadlines = new WeakMap(), requests = [];
    window.AbortSignal = { timeout(milliseconds) {
        const signal = AbortSignal.timeout(milliseconds);
        deadlines.set(signal, milliseconds);
        return signal;
    } };
    window.URL.createObjectURL = () => 'blob:upload-deadline';
    window.URL.revokeObjectURL = () => {};
    const fetch = window.fetch;
    window.fetch = (path, options) => {
        requests.push({ path, timeout: deadlines.get(options.signal) });
        return fetch(path, options.body instanceof window.File ? { ...options, body: png } : options);
    };
    window.document.querySelector('.thread-button[data-thread-id="a"]').click();
    await waitFor(() => $('send-state').textContent.includes('待機中のPC'));
    Object.defineProperty($('image-file'), 'files', { value: [new window.File([png], 'slow.png', { type: 'image/png' })] });
    $('image-file').dispatchEvent(new window.Event('change'));
    $('send').click();
    await waitFor(() => $('queue').textContent.includes('[画像]'));
    assert.deepEqual({
        upload: requests.filter(request => request.path.endsWith('/images')).map(request => request.timeout),
        ordinary: [...new Set(requests.filter(request => !request.path.endsWith('/images')).map(request => request.timeout))],
        bodyReception: f.server.requestTimeout, headers: f.server.headersTimeout, idle: f.server.timeout,
    }, { upload: [180000], ordinary: [12000], bodyReception: 180000, headers: 10000, idle: 30000 });
});

test('image drafts survive selection, conversation switches, failures and unknown delivery', async t => {
    const f = await fixture(); t.after(() => f.close());
    f.state.threads.get('a').status = { type: 'active', activeFlags: [] }; f.state.panes[0].agent_status = 'working';
    const { window, $ } = await mount(t, f, true);
    const revoked = []; let urls = 0, uploads = 0, lookups = 0, stateRefreshes = 0;
    window.URL.createObjectURL = () => `blob:preview-${++urls}`;
    window.URL.revokeObjectURL = url => revoked.push(url);
    const fetch = window.fetch;
    let uploadGate = null, failUpload = false;
    window.fetch = async (path, options) => {
        if (path.includes('/operations/')) lookups++;
        if (path.endsWith('/state')) stateRefreshes++;
        if (path.endsWith('/images')) {
            uploads++;
            if (uploadGate) await uploadGate.promise;
            if (failUpload) throw new Error('Upload disconnected');
            const bytes = await new Promise((resolve, reject) => {
                const reader = new window.FileReader(); reader.onload = () => resolve(Buffer.from(reader.result)); reader.onerror = reject; reader.readAsArrayBuffer(options.body);
            });
            return fetch(path, { ...options, body: bytes });
        }
        return fetch(path, options);
    };
    const select = id => window.document.querySelector(`.thread-button[data-thread-id="${id}"]`).click();
    const file = (name = 'photo.png', type = 'image/png', bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVQImWM4ZmdxzM6CAUIBACTWBPHkwkg6AAAAAElFTkSuQmCC', 'base64')) => new window.File([bytes], name, { type });
    const attach = image => {
        Object.defineProperty($('image-file'), 'files', { value: image ? [image] : [], configurable: true });
        $('image-file').dispatchEvent(new window.Event('change'));
    };
    select('a'); await waitFor(() => $('send-state').textContent.includes('処理中のCodex'));
    for (const [invalid, error] of [
        [file('bad.svg', 'image/svg+xml'), /PNG/],
        [file('large.png', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 1)), /10MiB/],
    ]) {
        attach(file());
        const previousURL = $('image-thumbnail').src;
        attach();
        assert.equal($('image-preview').hidden, false);
        assert.equal($('image-thumbnail').src, previousURL);
        assert.equal($('send').disabled, false);
        assert.equal(revoked.includes(previousURL), false);
        $('draft').value = '画像を確認'; $('draft').dispatchEvent(new window.Event('input'));
        attach(invalid);
        assert.match($('send-state').textContent, error);
        assert.equal($('image-preview').hidden, true);
        assert.equal($('image-thumbnail').hasAttribute('src'), false);
        assert.equal($('image-name').textContent, '');
        assert.ok(revoked.includes(previousURL));
        assert.equal($('draft').value, '画像を確認');
        assert.equal($('send').disabled, false);
        $('draft').value = ''; $('draft').dispatchEvent(new window.Event('input'));
        assert.equal($('send').disabled, true);
    }
    attach(file()); assert.equal($('send').disabled, false); assert.equal(uploads, 0);
    const originalURL = $('image-thumbnail').src;
    attach(file('replacement.png')); assert.ok(revoked.includes(originalURL));
    const replacementURL = $('image-thumbnail').src;
    $('draft').value = '画像を確認'; $('draft').dispatchEvent(new window.Event('input'));
    select('b'); assert.equal($('image-preview').hidden, true);
    attach(file('other.png')); const otherURL = $('image-thumbnail').src;
    select('a'); await waitFor(() => !$('send').disabled);
    assert.equal($('image-name').textContent, 'replacement.png'); assert.equal($('draft').value, '画像を確認');
    failUpload = true; $('send').click();
    await waitFor(() => $('send-state').textContent.includes('Upload disconnected'));
    assert.equal($('draft').value, '画像を確認'); assert.equal($('image-preview').hidden, false); assert.equal($('send').disabled, false);
    failUpload = false; f.state.ansiScreen = codexScreen('PCの下書き', false); $('send').click();
    await waitFor(() => $('send-state').textContent.includes('下書きがあります'));
    assert.equal($('draft').value, '画像を確認'); assert.equal($('image-name').textContent, 'replacement.png');
    f.state.ansiScreen = codexScreen(); uploadGate = Promise.withResolvers(); $('send').click();
    assert.equal($('image-file').disabled, true); assert.equal($('image-remove').disabled, true); assert.equal($('image-select').disabled, true);
    const oldLookups = lookups;
    const oldRefreshes = stateRefreshes;
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(() => stateRefreshes > oldRefreshes);
    select('b'); assert.equal($('image-thumbnail').src, otherURL);
    uploadGate.resolve(); uploadGate = null;
    await waitFor(() => f.state.writes.length === 1);
    await waitFor(() => !JSON.parse(window.sessionStorage.getItem('pending')).a);
    assert.equal(lookups, oldLookups);
    assert.equal($('image-thumbnail').src, otherURL);
    select('a'); await waitFor(() => $('image-preview').hidden);
    assert.equal($('draft').value, ''); assert.ok(revoked.includes(replacementURL));
    attach(file('unknown.png')); await waitFor(() => !$('send').disabled);
    f.state.ignoreInput = true; $('send').click();
    await waitFor(() => !$('resolve').hidden);
    assert.equal($('send').disabled, true); assert.equal($('image-remove').disabled, true);
    assert.equal($('image-name').textContent, 'unknown.png');
    const writes = f.state.writes.length; $('send').click(); assert.equal(f.state.writes.length, writes);
    $('resolve').click(); assert.equal($('image-remove').disabled, false);
    $('image-remove').click(); assert.equal($('image-preview').hidden, true); assert.equal($('send').disabled, true);
});

test('reloading an image submission permits reselection during upload and preserves uncertainty after send', async t => {
    for (const stage of ['uploading', 'sending']) await t.test(stage, async t => {
        const f = await fixture(); t.after(() => f.close());
        assert.equal(dirname(f.service.imageDir), dirname(f.codexPath));
        const ui = await mount(t, f, true);
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVQImWM4ZmdxzM6CAUIBACTWBPHkwkg6AAAAAElFTkSuQmCC', 'base64');
        ui.window.URL.createObjectURL = () => 'blob:reload-preview';
        ui.window.URL.revokeObjectURL = () => {};
        const fetch = ui.window.fetch;
        const gate = Promise.withResolvers();
        let paused = false;
        ui.window.fetch = async (path, options) => {
            if (path.endsWith(stage === 'uploading' ? '/images' : '/send')) {
                paused = true;
                await gate.promise;
            }
            return fetch(path, options?.body instanceof ui.window.File ? { ...options, body: png } : options);
        };
        ui.window.document.querySelector('.thread-button[data-thread-id="a"]').click();
        await waitFor(() => ui.$('send-state').textContent.includes('待機中のPC'));
        ui.$('draft').value = '再読込み後も保持する指示'; ui.$('draft').dispatchEvent(new ui.window.Event('input'));
        Object.defineProperty(ui.$('image-file'), 'files', { value: [new ui.window.File([png], 'reload.png', { type: 'image/png' })] });
        ui.$('image-file').dispatchEvent(new ui.window.Event('change'));
        ui.$('send').click(); await waitFor(() => paused);
        const stored = Object.fromEntries(['drafts', 'pending', 'imageDrafts'].map(key => [key, ui.window.sessionStorage.getItem(key)]));
        const operation = JSON.parse(stored.pending).a;
        assert.equal(f.service.operations.has(operation.requestId), false);
        const reloaded = await mount(t, f, true, stored);
        reloaded.window.document.querySelector('.thread-button[data-thread-id="a"]').click();
        await waitFor(() => reloaded.$('send-state').textContent.includes(stage === 'uploading' ? '待機中のPC' : '送信結果が不明'));
        assert.equal(reloaded.$('draft').value, '再読込み後も保持する指示');
        assert.match(reloaded.$('image-name').textContent, /選び直して/);
        assert.equal(reloaded.$('send').disabled, true);
        assert.equal(reloaded.$('resolve').hidden, stage === 'uploading');
        assert.equal(reloaded.$('image-select').disabled, stage === 'sending');
        if (stage === 'uploading') {
            assert.equal(JSON.parse(reloaded.window.sessionStorage.getItem('pending')).a, undefined);
            reloaded.$('image-remove').click();
            assert.equal(reloaded.$('send').disabled, false);
        } else {
            assert.equal(JSON.parse(reloaded.window.sessionStorage.getItem('pending')).a.requestId, operation.requestId);
            reloaded.$('resolve').click();
            assert.equal(reloaded.$('image-select').disabled, false);
        }
        gate.reject(new Error('Page reloaded'));
        await waitFor(() => !JSON.parse(ui.window.sessionStorage.getItem('pending')).a || !ui.$('resolve').hidden);
    });
});

test('usage polling stays independent of sending and rejects stale selections and failed connections', async t => {
    const f = await fixture(); t.after(() => f.close());
    const c = await f.addClaude();
    f.state.ansiScreen = codexScreen().replace('Context 5% used', 'Context 64% used · weekly 85% left');
    const { window, $ } = await mount(t, f, false, {}, 3);
    const fetch = window.fetch;
    let gate = { ...Promise.withResolvers(), entered: Promise.withResolvers() };
    t.after(() => gate.resolve());
    let hold = true, fail = false, reads = 0;
    window.fetch = async (path, options) => {
        if (path.endsWith('/usage')) {
            reads++;
            if (fail) throw new Error('Usage unavailable');
            const response = await fetch(path, options);
            if (hold && path.includes('/a/')) { gate.entered.resolve(); await gate.promise; }
            return response;
        }
        return fetch(path, options);
    };
    const select = id => window.document.querySelector(`.thread-button[data-thread-id="${id}"]`).click();
    const poll = () => window.document.dispatchEvent(new window.Event('visibilitychange'));
    select('a'); await gate.entered.promise;
    await waitFor(() => $('status').textContent === '待機中');
    $('draft').value = '取得中の指示'; $('draft').dispatchEvent(new window.Event('input')); $('draft').focus();
    assert.equal($('send').disabled, false);
    assert.equal($('usage').textContent, 'コンテキスト不明 · 週残り不明');
    poll();
    await waitFor(() => f.state.calls.filter(call => call.method === 'thread/queue/list').length >= 2);
    assert.equal(reads, 1);
    $('send').click(); await waitFor(() => $('draft').value === '');
    assert.equal(f.state.queue.length, 1);
    f.state.ansiScreen = codexScreen().replace('Context 5% used', 'Context 12% used · weekly 34% left');
    select('b'); await waitFor(() => $('usage').textContent === 'コンテキスト12%使用 · 週残り34%');
    select('a'); await waitFor(() => $('send-state').textContent.startsWith('待機中の指示'));
    hold = false; gate.resolve();
    await new Promise(setImmediate);
    assert.equal($('usage').textContent, 'コンテキスト不明 · 週残り不明');
    select(c.id); await waitFor(() => $('title').textContent === c.session.name);
    await waitFor(() => $('status').textContent === '待機中');
    assert.equal($('usage').hidden, true);
    f.state.ansiScreen = codexScreen().replace('Context 5% used', 'Context 64% used · weekly 85% left');
    select('a'); await waitFor(() => $('usage').textContent.includes('64%使用'));
    $('draft').value = '保持する下書き'; $('draft').dispatchEvent(new window.Event('input')); $('draft').focus();
    for (const failure of ['failState', 'failHerdr']) {
        gate = { ...Promise.withResolvers(), entered: Promise.withResolvers() };
        hold = true; poll(); await gate.entered.promise;
        f.state[failure] = true;
        await waitFor(() => $('send-state').textContent.startsWith('接続と会話の状態'));
        f.state[failure] = false;
        await waitFor(() => $('send-state').textContent.startsWith('待機中の指示'));
        hold = false; gate.resolve(); await new Promise(setImmediate);
        assert.equal($('usage').textContent, 'コンテキスト不明 · 週残り不明');
        await waitFor(() => $('usage').textContent.includes('64%使用'));
    }
    fail = true; poll();
    await waitFor(() => $('usage').textContent === 'コンテキスト不明 · 週残り不明');
    assert.equal($('draft').value, '保持する下書き');
    assert.equal(window.document.activeElement, $('draft'));
    fail = false; poll(); await waitFor(() => $('usage').textContent.includes('64%使用'));
    f.state.failHerdr = true; poll();
    await waitFor(() => $('connection').classList.contains('error'));
    assert.equal($('usage').textContent, 'コンテキスト不明 · 週残り不明');
    f.state.failHerdr = false; poll();
    await waitFor(() => $('usage').textContent.includes('64%使用'));
    f.state.panes.shift(); poll();
    await waitFor(() => $('status').textContent === '終了');
    assert.equal($('usage').textContent, 'コンテキスト不明 · 週残り不明');
});

test('async questions arrive without focus changes and keep separate drafts through polling and recovery', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { window, $ } = await mount(t, f);
    const select = id => window.document.querySelector(`.thread-button[data-thread-id="${id}"]`).click();
    select('a'); await waitFor(() => window.document.querySelectorAll('.turn').length === 20);
    $('draft').value = '通常の指示の下書き'; $('draft').dispatchEvent(new window.Event('input')); $('draft').focus();
    const turn = f.state.ask('a', [{ title: '**環境**を選んでください<script>window.bad = true</script>', options: ['開発', '本番'] }, { title: '補足はありますか？' }]);
    await waitFor(() => !$('questions').hidden);
    assert.equal(window.document.activeElement, $('draft'));
    assert.equal($('draft').value, '通常の指示の下書き');
    assert.equal($('questions').querySelector('script'), null);
    assert.equal($('questions').querySelector('strong').textContent, '環境');
    assert.equal($('questions').querySelector('[aria-pressed="true"]'), null);
    let form = $('questions').querySelector('.question'), input = form.querySelector('textarea');
    form.querySelector('.question-option').click();
    assert.equal(input.value, '開発'); assert.equal(f.state.steers.length, 0);
    input.value = '自由な回答\n補足'; input.dispatchEvent(new window.Event('input')); input.focus(); input.setSelectionRange(2, 4);
    f.state.threads.get('a').preview = 'ポーリング後の表示';
    await waitFor(() => $('thread-list').textContent.includes('ポーリング後の表示'));
    assert.equal($('questions').querySelector('textarea'), input);
    assert.equal(window.document.activeElement, input); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 4);
    select('b'); await waitFor(() => $('turns').textContent.includes('別の会話の出力'));
    select('a'); await waitFor(() => !$('questions').querySelector('.question-submit').disabled);
    form = $('questions').querySelector('.question'); input = form.querySelector('textarea');
    assert.equal(input.value, '自由な回答\n補足'); assert.equal($('draft').value, '通常の指示の下書き');
    f.state.failHistory = true;
    await waitFor(() => $('history-notice').classList.contains('error'));
    assert.equal(form.querySelector('.question-submit').disabled, true); assert.equal(input.value, '自由な回答\n補足');
    f.state.failHistory = false;
    await waitFor(() => !form.querySelector('.question-submit').disabled);
    f.state.panes[0].agent_status = 'unknown';
    await waitFor(() => form.querySelector('.question-submit').disabled);
    assert.equal(input.value, '自由な回答\n補足');
    f.state.panes[0].agent_status = 'working';
    await waitFor(() => !form.querySelector('.question-submit').disabled);
    f.state.steerError = { code: -32600, message: 'Refused answer' };
    form.querySelector('.question-submit').click();
    await waitFor(() => form.querySelector('.question-state').textContent.includes('拒否'));
    assert.equal(input.value, '自由な回答\n補足');
    assert.equal($('draft').value, '通常の指示の下書き');
    f.state.steerError = null;
    const fetch = window.fetch;
    window.fetch = async (path, options) => {
        if (path.endsWith('/answer')) { window.fetch = fetch; throw new Error('Request did not reach the server'); }
        return fetch(path, options);
    };
    form.querySelector('.question-submit').click();
    await waitFor(() => !form.querySelector('.question-recover').hidden);
    form.querySelector('.question-recover').click();
    await waitFor(() => !form.querySelector('.question-submit').disabled);
    assert.equal(input.value, '自由な回答\n補足'); assert.equal(f.state.steers.length, 0);
    f.state.ignoreSteer = true; f.state.steerConfirm = false;
    form.querySelector('.question-submit').click();
    await waitFor(() => !form.querySelector('.question-recover').hidden);
    const unknown = JSON.parse(window.sessionStorage.getItem('questionPending'));
    const previousId = Object.values(unknown)[0].requestId;
    assert.equal(form.querySelector('.question-submit').disabled, true);
    assert.equal(input.value, '自由な回答\n補足');
    const delayedRecovery = holdResponse(window, path => path.endsWith('/answer-recover'));
    form.querySelector('.question-recover').click();
    await waitFor(() => delayedRecovery.seen);
    await waitFor(() => !form.querySelector('.question-submit').disabled);
    form.querySelector('.question-submit').click();
    await waitFor(() => !form.querySelector('.question-recover').hidden);
    const newerId = Object.values(JSON.parse(window.sessionStorage.getItem('questionPending')))[0].requestId;
    assert.notEqual(newerId, previousId);
    delayedRecovery.release();
    await waitFor(() => delayedRecovery.consumed);
    assert.equal(Object.values(JSON.parse(window.sessionStorage.getItem('questionPending')))[0].requestId, newerId);
    assert.equal(form.querySelector('.question-submit').disabled, true);
    f.state.ignoreSteer = false; f.state.steerConfirm = true;
    form.querySelector('.question-recover').click();
    await waitFor(() => !form.querySelector('.question-submit').disabled);
    form.querySelector('.question-submit').click();
    await waitFor(() => $('questions').querySelectorAll('.question').length === 1);
    assert.notEqual(f.state.steers.at(-1).clientUserMessageId, previousId);
    assert.equal($('draft').value, '通常の指示の下書き');
    assert.equal(JSON.parse(window.sessionStorage.getItem('drafts')).a, '通常の指示の下書き');
    assert.match($('queue').textContent, /回答: 自由な回答/);
    turn.status = 'completed'; f.state.threads.get('a').status = { type: 'idle' }; f.state.panes[0].agent_status = 'done';
    await waitFor(() => $('questions').hidden);
    assert.match($('turns').textContent, /補足はありますか/);
    assert.equal(f.state.writes.length, 0);
});

test('question drafts and recovery survive turn end, unavailable history and CLI closure', async t => {
    for (const [uncertain, ending] of [[false, 'turn'], [false, 'cli'], [true, 'turn'], [true, 'history'], [true, 'cli']]) {
        await t.test(`${uncertain ? 'uncertain' : 'accepted'} answer with ${ending}`, async t => {
            const f = await fixture(); t.after(() => f.close());
            const turn = f.state.ask('a', [{ title: '回答を確認してください' }]);
            f.state.steerConfirm = false; f.state.ignoreSteer = uncertain;
            const { window, $ } = await mount(t, f, true);
            window.document.querySelector('.thread-button[data-thread-id="a"]').click();
            await waitFor(() => !$('questions').hidden);
            $('draft').value = '通常の会話の下書き'; $('draft').dispatchEvent(new window.Event('input'));
            const input = $('questions').querySelector('textarea');
            input.value = '確認まで保持する回答'; input.dispatchEvent(new window.Event('input'));
            const [key] = Object.keys(JSON.parse(window.sessionStorage.getItem('questionDrafts')));
            const pending = () => JSON.parse(window.sessionStorage.getItem('questionPending'))[key];
            $('questions').querySelector('.question-submit').click();
            await waitFor(() => pending()?.state === (uncertain ? 'unknown' : 'succeeded'));
            const requestId = pending().requestId;
            const tick = () => window.document.dispatchEvent(new window.Event('visibilitychange'));
            if (ending === 'cli') {
                f.state.panes = f.state.panes.filter(pane => pane.pane_id !== 'w1:p1');
                if (uncertain) { f.service.operations.clear(); f.service.questionReservations.clear(); }
            } else if (ending === 'history') f.state.failHistory = true;
            else {
                turn.status = 'completed'; f.state.threads.get('a').status = { type: 'idle' }; f.state.panes[0].agent_status = 'done';
            }
            if (uncertain) {
                await waitFor(() => {
                    tick();
                    return ending === 'cli' ? $('connection').textContent.includes('1件')
                        : ending === 'history' ? $('history-notice').classList.contains('error')
                        : $('status').textContent === '待機中';
                });
                const recovery = $('questions').querySelector('.question-recover');
                assert.equal(pending().state, 'unknown');
                assert.equal($('questions').querySelector('.question-submit').disabled, true);
                assert.equal(recovery.hidden, false); assert.equal(recovery.disabled, false);
                recovery.click();
                await waitFor(() => !pending());
                if (ending === 'cli') assert.equal($('questions').hidden, true);
                else assert.equal((await f.request(`/api/operations/${requestId}`)).body.state, 'failed');
            } else {
                await waitFor(() => { tick(); return !pending() && $('questions').hidden; });
                if (ending === 'turn') assert.equal((await f.request(`/api/operations/${requestId}`)).body.value.turnEnded, true);
            }
            assert.equal(JSON.parse(window.sessionStorage.getItem('questionDrafts'))[key], '確認まで保持する回答');
            assert.equal(JSON.parse(window.sessionStorage.getItem('drafts')).a, '通常の会話の下書き');
            assert.equal($('draft').value, '通常の会話の下書き');
            assert.equal(f.state.steers.length, 1);
        });
    }
});

test('Claude shares the conversation composer and retains drafts while awaiting input', async t => {
    const f = await fixture(); t.after(() => f.close());
    const c = await f.addClaude(true);
    await c.write([c.row('user', '画面を確認してください'), c.row('assistant', [{ type: 'text', text: 'Claudeからの返答' }])]);
    const { window, $ } = await mount(t, f, false, {}, 1);
    assert.match($('thread-list').textContent, /Claude Code/);
    window.document.querySelector('.thread-button').click();
    await waitFor(() => $('turns').textContent.includes('Claudeからの返答'));
    assert.match($('turns').textContent, /Claude Code/);
    const text = '同じ入力欄から送る\n複数行の指示';
    $('draft').value = text; $('draft').dispatchEvent(new window.Event('input'));
    $('send').click();
    await waitFor(() => $('draft').value === '');
    assert.equal(f.state.writes.at(-1).text, '\x1b[200~' + text + '\x1b[201~');
    c.session.status = 'waiting'; c.session.waitingFor = 'input needed';
    await waitFor(() => $('status').textContent === '承認・回答待ち');
    $('draft').value = '保持する指示'; $('draft').dispatchEvent(new window.Event('input'));
    assert.equal($('send').disabled, true);
    assert.equal($('composer-terminal').hidden, false);
    assert.equal($('draft').value, '保持する指示');
    assert.deepEqual(f.state.calls, []);
});

function holdResponse(window, matches) {
    const original = window.fetch;
    const gate = Promise.withResolvers();
    const held = { seen: false, consumed: false, release: gate.resolve, fail: () => gate.reject(new Error('Simulated network failure')) };
    window.fetch = async (path, options) => {
        const response = await original(path, options);
        if (!held.seen && matches(path, options)) {
            held.value = await response.clone().json();
            held.seen = true;
            await gate.promise;
            const json = response.json.bind(response);
            response.json = async () => { const value = await json(); held.consumed = true; return value; };
        }
        return response;
    };
    return held;
}

test('changes dialog selects files as text, shows empty states and discards stale reads', async t => {
    const f = await fixture(); t.after(() => f.close());
    let mode = 'files';
    f.service.changes = async (id, path) => {
        if (path !== null) {
            if (mode === 'unavailable') return { state: 'unavailable', path, message: '内容を表示できません。' };
            if (mode === 'deleted') return { state: 'ready', path, diff: `--- a/${path}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n` };
            return { state: 'ready', path, diff: mode === 'large'
                ? `--- a/${path}\n+++ b/${path}\n@@ -1 +1,2500 @@\n-old\n${'+x\n'.repeat(2500)}`
                : `--- a/${path}\n+++ b/${path}\n@@ -5,3 +9,4 @@\n  common\t\n---old\n-old\n+++new\n+${id}/${path}\n+<img src=x onerror=alert(1)>\n\\ No newline at end of file\n` };
        }
        if (mode === 'notGit') return { state: 'notGit', files: [], message: 'この会話の作業ディレクトリはGit管理外です。' };
        return { state: 'ready', root: '/projects/repo', files: mode === 'empty' ? [] : [
            { path: 'one.txt', status: ' M' }, { path: 'two.txt', status: '??' },
        ] };
    };
    const { window, $ } = await mount(t, f, true);
    const select = id => window.document.querySelector(`.thread-button[data-thread-id="${id}"]`).click();
    select('a'); $('changes-open').click();
    await waitFor(() => $('changes-diff').textContent.includes('a/one.txt'));
    assert.equal($('changes-file').options.length, 2);
    assert.equal($('changes-diff').querySelector('img'), null);
    assert.equal($('changes-summary').textContent, '差分全体: 追加3行 · 削除2行');
    assert.deepEqual([...$('changes-diff').querySelectorAll('.diff-label')].map(label => label.textContent), ['', '削除', '削除', '追加', '追加', '追加']);
    assert.equal($('changes-detail').textContent, '');
    assert.equal($('changes-diff').querySelector('.diff-context .diff-text').textContent, ' common\t\n');
    assert.equal($('changes-diff').querySelector('.diff-hunk').textContent, '変更箇所 · 9行目付近\n');
    assert.match($('changes-diff').querySelector('.diff-note').textContent, /末尾に改行がありません/);
    assert.deepEqual([...$('changes-diff').querySelectorAll('.diff-deletion .diff-text, .diff-addition .diff-text')].map(text => text.textContent), ['--old\n', 'old\n', '++new\n', 'a/one.txt\n', '<img src=x onerror=alert(1)>\n']);
    assert.doesNotMatch($('changes-diff').textContent, /--- a\/|\+\+\+ b\//);
    const choose = path => { $('changes-file').value = path; $('changes-file').dispatchEvent(new window.Event('change')); };
    const held = holdResponse(window, path => path.includes('/changes?path=one.txt'));
    choose('one.txt'); await waitFor(() => held.seen);
    assert.equal($('changes-summary').textContent, '');
    choose('two.txt'); await waitFor(() => $('changes-diff').textContent.includes('a/two.txt'));
    held.release(); await waitFor(() => held.consumed);
    assert.match($('changes-diff').textContent, /a\/two.txt/);
    for (const transition of ['reopen', 'conversation']) {
        const stale = holdResponse(window, path => path.includes('/changes?path=one.txt'));
        choose('one.txt'); await waitFor(() => stale.seen);
        if (transition === 'reopen') $('changes-close').click();
        else { select('b'); assert.equal($('changes-dialog').open, false); }
        $('changes-open').click();
        await waitFor(() => !$('changes-file').disabled && $('changes-diff').textContent.includes('/one.txt'));
        choose('two.txt');
        await waitFor(() => $('changes-diff').textContent.includes(`${transition === 'reopen' ? 'a' : 'b'}/two.txt`));
        stale.release(); await waitFor(() => stale.consumed);
        assert.equal($('changes-file').value, 'two.txt');
        assert.match($('changes-diff').textContent, /\/two.txt/);
        assert.equal($('changes-summary').textContent, '差分全体: 追加3行 · 削除2行');
    }
    mode = 'deleted'; choose('one.txt');
    await waitFor(() => $('changes-summary').textContent === '差分全体: 追加0行 · 削除2行');
    assert.equal($('changes-diff').querySelector('.diff-hunk').textContent, '変更箇所 · 変更前1行目付近\n');
    mode = 'large'; choose('one.txt');
    await waitFor(() => $('changes-limit').textContent.includes('先頭2000行'));
    assert.equal($('changes-diff').children.length, 2000);
    assert.equal($('changes-summary').textContent, '差分全体: 追加2500行 · 削除1行');
    mode = 'unavailable'; choose('two.txt');
    await waitFor(() => $('changes-detail').textContent === '内容を表示できません。');
    assert.equal($('changes-diff').hidden, true);
    assert.equal($('changes-summary').textContent, '');
    assert.equal($('changes-limit').textContent, '');
    mode = 'large'; choose('one.txt');
    await waitFor(() => $('changes-limit').textContent.includes('先頭2000行'));
    const staleList = holdResponse(window, path => path.endsWith('/changes'));
    $('changes-refresh').click(); await waitFor(() => staleList.seen);
    assert.equal($('changes-summary').textContent, '');
    assert.equal($('changes-limit').textContent, '');
    $('changes-close').click(); mode = 'empty'; $('changes-open').click();
    await waitFor(() => $('changes-state').textContent === '作業ツリーに変更はありません。');
    staleList.release(); await waitFor(() => staleList.consumed);
    assert.equal($('changes-file').options.length, 0); assert.equal($('changes-diff').hidden, true);
    assert.equal($('changes-file').disabled, true);
    assert.equal($('changes-summary').textContent, '');
    mode = 'notGit'; $('changes-refresh').click();
    await waitFor(() => $('changes-state').textContent.includes('Git管理外'));
});

test('changes dialog closes on thread end and poll failure and discards late responses', async t => {
    for (const transition of ['ended', 'poll failure']) {
        await t.test(transition, async t => {
            const f = await fixture(); t.after(() => f.close());
            f.service.changes = async (id, path) => path === null
                ? { state: 'ready', root: '/projects/repo', files: [{ path: 'one.txt', status: ' M' }] }
                : { state: 'ready', path, diff: '--- a/one.txt\n+++ b/one.txt\n@@ -0,0 +1 @@\n+current content\n' };
            const { window, $ } = await mount(t, f, true);
            window.document.querySelector('.thread-button[data-thread-id="a"]').click();
            await waitFor(() => $('send-state').textContent.includes('待機中のPC'));
            $('changes-open').click();
            await waitFor(() => $('changes-diff').textContent.includes('current content'));
            const stale = holdResponse(window, path => path.includes('/changes?path='));
            $('changes-file').dispatchEvent(new window.Event('change'));
            await waitFor(() => stale.seen);
            if (transition === 'ended') f.state.process.foreground_processes = [{ pid: 100, name: 'zsh', argv: ['zsh'] }];
            else f.state.failHerdr = true;
            window.document.dispatchEvent(new window.Event('visibilitychange'));
            await waitFor(() => transition === 'ended' ? $('status').textContent === '終了' : $('connection').classList.contains('error'));
            assert.equal($('changes-dialog').open, false);
            stale.release(); await waitFor(() => stale.consumed);
            assert.equal($('changes-dialog').open, false);
            assert.equal($('changes-diff').textContent, '');
            assert.equal($('changes-diff').hidden, true);
            assert.equal($('changes-summary').textContent, '');
            assert.equal($('changes-limit').textContent, '');
        });
    }
});

test('UI retains history and drafts, rejects stale responses, and recovers after errors', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { window, $ } = await mount(t, f);
    assert.equal(window.location.hash, '');
    const select = title => [...window.document.querySelectorAll('.thread-button')].find(button => button.textContent.includes(title)).click();
    select('モバイル表示');
    await waitFor(() => window.document.querySelectorAll('.turn').length === 20);
    $('draft').value = '会話aの下書き'; $('draft').dispatchEvent(new window.Event('input'));
    $('draft').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    assert.equal(f.state.queue.length, 0);
    $('older').click();
    await waitFor(() => window.document.querySelectorAll('.turn').length === 26);
    const details = window.document.querySelector('details'); details.open = true;
    f.state.turns.get('a').at(-1).items[1].text = '更新された出力';
    await waitFor(() => $('turns').textContent.includes('更新された出力'));
    assert.equal(window.document.querySelectorAll('.turn').length, 26);
    assert.equal(details.open, true);
    f.state.historyDelay = 100;
    select('APIのレスポンス');
    select('モバイル表示');
    await waitFor(() => $('title').textContent.includes('モバイル表示') && !$('send').disabled);
    assert.equal($('turns').textContent.includes('別の会話の出力'), false);
    assert.equal($('draft').value, '会話aの下書き');
    f.state.historyDelay = 0;
    f.state.failHistory = true;
    await waitFor(() => $('history-notice').classList.contains('error'));
    assert.equal(window.document.querySelectorAll('.turn').length, 26);
    assert.equal($('send').disabled, false);
    f.state.failHistory = false;
    await waitFor(() => !$('send').disabled);
    $('send').click();
    await waitFor(() => $('draft').value === '');
    assert.equal(f.state.queue.length, 1);
    assert.equal(f.state.queue[0].input[0].text, '会話aの下書き');
    $('terminal-open').click();
    await waitFor(() => $('pane-select').options.length === 2);
    $('pane-select').value = 'w1:p1'; $('bind').click();
    await waitFor(() => $('terminal-screen').textContent.includes('指示を待っています'));
    assert.equal($('terminal-send').disabled, false);
    $('terminal-text').value = '回答'; $('terminal-send').click();
    await waitFor(() => f.state.writes.length === 1 && !$('terminal-refresh').disabled);
    assert.deepEqual(f.state.writes, [{ pane_id: 'w1:p1', text: '回答' }]);
    f.state.changeProcessOnInput = true;
    $('keys').querySelector('[aria-label="Enter"]').click();
    await waitFor(() => f.state.writes.length === 2 && !$('terminal-refresh').disabled);
    assert.equal($('terminal-result').textContent, 'w1:p1 · 端末へ送信しました。');
    assert.match($('terminal-state').textContent, /選び直してください/);
    assert.equal($('terminal-send').disabled, true);
    f.state.changeProcessOnInput = false;
    $('bind').click();
    await waitFor(() => $('terminal-state').textContent.includes('会話IDで関連付け済み'));
    f.state.screen += '\n表示を更新しました';
    $('terminal-text').value = '表示変更後の入力'; $('terminal-send').click();
    await waitFor(() => $('terminal-result').textContent.includes('失敗') && !$('terminal-refresh').disabled);
    const failedResult = $('terminal-result').textContent;
    $('terminal-refresh').click();
    await waitFor(() => !$('terminal-refresh').disabled);
    assert.equal($('terminal-result').textContent, failedResult);
    f.state.ignoreInput = true;
    $('terminal-text').value = '応答が切れる入力'; $('terminal-send').click();
    await waitFor(() => $('terminal-result').textContent.includes('不明') && !$('terminal-refresh').disabled);
    const unknownResult = $('terminal-result').textContent;
    $('terminal-refresh').click();
    await waitFor(() => !$('terminal-refresh').disabled);
    assert.equal($('terminal-result').textContent, unknownResult);
    assert.equal($('terminal-send').disabled, true);
    $('terminal-resolve').click();
    assert.equal($('terminal-result').textContent, 'PCで端末操作の結果を確認しました。');
    $('terminal-close').click();
    await waitFor(() => f.service.bindings.size === 0);
    f.state.ignoreInput = false;
    f.state.threads.get('a').status = { type: 'active', activeFlags: [] };
    f.state.panes[0].agent_status = 'working';
    f.state.queue = [{ id: 'pending', input: [{ type: 'text', text: '待機中の指示' }] }];
    const previousWrites = f.state.writes.length;
    $('draft').value = '処理中の追加指示\n続きを確認してください'; $('draft').dispatchEvent(new window.Event('input'));
    await waitFor(() => !$('send').disabled);
    assert.match($('send-state').textContent, /処理中のCodexへ追加/);
    f.state.ansiScreen = codexScreen('Ask Codex to do anything', false);
    $('send').click();
    await waitFor(() => $('send-state').textContent.includes('下書きがあります'));
    assert.equal(f.state.writes.length, previousWrites);
    assert.equal($('draft').value, '処理中の追加指示\n続きを確認してください');
    f.state.ansiScreen = codexScreen();
    $('send').click();
    await waitFor(() => $('draft').value === '');
    assert.equal(f.state.writes.length, previousWrites + 1);
    f.state.ignoreInput = true;
    $('draft').value = '結果不明の追加指示'; $('draft').dispatchEvent(new window.Event('input'));
    await waitFor(() => !$('send').disabled);
    $('send').click();
    await waitFor(() => !$('resolve').hidden);
    assert.equal($('draft').value, '結果不明の追加指示');
    assert.equal($('send').disabled, true);
    $('send').click();
    assert.equal(f.state.writes.length, previousWrites + 2);
    assert.equal(JSON.parse(window.sessionStorage.getItem('pending')).a.state, 'unknown');
});

test('launch UI prevents repeat requests, recovers by ID and hands off after trust confirmation', async t => {
    const f = await fixture(); t.after(() => f.close());
    f.state.launchThread = false;
    let { window, $ } = await mount(t, f, true);
    window.document.querySelector('.thread-button[data-thread-id="a"]').click();
    await waitFor(() => !$('draft').disabled);
    $('draft').value = '元の会話の下書き'; $('draft').dispatchEvent(new window.Event('input'));
    $('launch-open').click();
    assert.equal($('launch-dialog').open, true);
    $('launch-path').value = 'relative/path';
    $('launch-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    assert.match($('launch-state').textContent, /絶対パス/);
    assert.equal(f.state.creates.length, 0);
    const held = holdResponse(window, (path, options) => path === '/api/launches' && options.method === 'POST');
    $('launch-path').value = process.cwd();
    $('launch-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await waitFor(() => held.seen && f.state.creates.length === 1);
    const id = window.sessionStorage.getItem('launchRequestId');
    assert(id);
    assert.equal($('launch-submit').disabled, true);
    $('launch-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    assert.equal(f.state.creates.length, 1);
    assert.equal(window.JSON.parse(window.sessionStorage.getItem('pending')).launch, undefined);
    assert.equal(window.JSON.parse(window.sessionStorage.getItem('drafts')).a, '元の会話の下書き');
    held.release();
    await waitFor(() => held.consumed);
    const stored = Object.fromEntries(['launchRequestId', 'drafts', 'pending'].map(key => [key, window.sessionStorage.getItem(key)]));
    await waitFor(() => $('usage').textContent.includes('コンテキスト5%使用'));
    window.close();
    ({ window, $ } = await mount(t, f, true, stored));
    const tick = () => window.document.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(() => {
        tick();
        return !$('launch-terminal').hidden;
    });
    assert.equal(f.state.creates.length, 1);
    $('launch-open').click(); $('launch-terminal').click();
    assert.equal($('launch-dialog').open, false); assert.equal($('terminal-dialog').open, true);
    await waitFor(() => $('pane-select').value.startsWith('launch-p'));
    const paneId = $('pane-select').value;
    assert.equal($('pane-select').options.length, 1);
    $('bind').click();
    await waitFor(() => !$('terminal-send').disabled);
    $('keys').querySelector('[aria-label="Enter"]').click();
    await waitFor(() => f.state.writes.length === 2 && !$('terminal-refresh').disabled);
    $('terminal-close').click();
    assert.equal($('terminal-dialog').open, false); assert.equal($('launch-dialog').open, true);
    const launched = f.state.panes.find(pane => pane.pane_id === paneId);
    const threadId = f.state.resolveLaunch(launched);
    const original = window.fetch;
    window.fetch = async (path, options) => {
        const response = await original(path, options);
        if (path !== '/api/threads') return response;
        const value = await response.json();
        value.threads = value.threads.filter(thread => thread.id !== threadId);
        return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    tick();
    await waitFor(() => $('title').textContent === '新しく起動した会話');
    assert.equal($('launch-dialog').open, false); assert.equal($('terminal-dialog').open, false);
    assert.equal(window.sessionStorage.getItem('launchRequestId'), null);
    assert(window.document.querySelector(`.thread-button[data-thread-id="${threadId}"]`));
    await waitFor(() => !$('send-state').textContent.includes('確認しています'));
    $('draft').value = '起動後の最初の指示'; $('draft').dispatchEvent(new window.Event('input'));
    $('send').click();
    await waitFor(() => f.state.queue.length === 1);
    assert.equal(f.state.calls.find(call => call.method === 'thread/queue/add').params.threadId, threadId);
    assert.equal(window.JSON.parse(window.sessionStorage.getItem('drafts')).a, '元の会話の下書き');
});

test('unknown launch requires PC confirmation before a new request', async t => {
    const f = await fixture(); t.after(() => f.close());
    f.state.malformedCreate = true;
    const { window, $ } = await mount(t, f);
    $('launch-open').click(); $('launch-path').value = process.cwd();
    $('launch-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await waitFor(() => !$('launch-resolve').hidden);
    const id = window.sessionStorage.getItem('launchRequestId');
    assert.equal($('launch-submit').disabled, true);
    assert.equal(f.state.creates.length, 1);
    $('launch-close').click(); $('launch-open').click();
    assert.equal(window.sessionStorage.getItem('launchRequestId'), id);
    $('launch-resolve').click();
    await waitFor(() => !$('launch-submit').disabled);
    assert.equal(f.service.launches.get(id).confirmed, true);
    assert.equal(window.sessionStorage.getItem('launchRequestId'), null);
});

test('closed launch pane enables the next launch in the UI', async t => {
    const f = await fixture(); t.after(() => f.close());
    f.state.initialShellPending = true; f.state.launchThread = false;
    const { window, $ } = await mount(t, f);
    $('launch-open').click(); $('launch-path').value = process.cwd();
    $('launch-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await waitFor(() => f.state.herdrCalls.some(call => call.method === 'pane.process_info' && call.params.pane_id.startsWith('launch-p')));
    const id = window.sessionStorage.getItem('launchRequestId');
    const pane = f.state.panes.find(pane => pane.pane_id.startsWith('launch-p'));
    f.state.panes = f.state.panes.filter(candidate => candidate !== pane);
    await waitFor(() => $('launch-state').textContent.includes('終了しました'));
    assert.equal($('launch-submit').disabled, false);
    assert.equal($('launch-resolve').hidden, true);
    f.state.initialShellPending = false;
    $('launch-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await waitFor(() => f.state.creates.length === 2);
    assert.notEqual(window.sessionStorage.getItem('launchRequestId'), id);
});

test('first-message history, state failure and ended conversations preserve drafts and recover', async t => {
    const f = await fixture(); t.after(() => f.close());
    f.state.turns.set('a', []);
    f.state.historyError = { code: -32600, message: 'thread a is not materialized yet; thread/turns/list is unavailable before first user message' };
    const { window, $ } = await mount(t, f);
    window.document.querySelector('.thread-button[data-thread-id="a"]').click();
    await waitFor(() => $('history-notice').textContent === '履歴はまだありません。');
    $('draft').value = '最初の指示'; $('draft').dispatchEvent(new window.Event('input'));
    await waitFor(() => !$('send').disabled);
    $('send').click();
    await waitFor(() => $('draft').value === '');
    assert.deepEqual(f.state.calls.filter(call => call.method === 'thread/queue/add').map(call => call.params.threadId), ['a']);
    f.state.historyError = null; f.state.queue = [];
    f.state.turns.set('a', [f.state.makeTurn(1, '保持する履歴')]);
    await waitFor(() => $('turns').textContent.includes('保持する履歴'));
    $('draft').value = '保持する下書き'; $('draft').dispatchEvent(new window.Event('input'));
    f.state.failState = true;
    await waitFor(() => $('history-notice').classList.contains('error') && $('send').disabled);
    assert.equal($('draft').value, '保持する下書き');
    assert.match($('turns').textContent, /保持する履歴/);
    f.state.failState = false;
    await waitFor(() => !$('send').disabled);
    f.state.threads.get('a').status = { type: 'active', activeFlags: ['waitingOnApproval'] };
    await waitFor(() => !$('composer-terminal').hidden);
    $('terminal-open').click();
    await waitFor(() => $('pane-select').options.length === 2);
    $('pane-select').value = 'w1:p1'; $('bind').click();
    await waitFor(() => f.service.bindings.size === 1 && $('terminal-screen').textContent.includes('指示を待っています'));
    const process = structuredClone(f.state.process);
    f.state.process.foreground_processes = [{ pid: 100, name: 'zsh', argv: ['zsh'] }];
    await waitFor(() => $('send-state').textContent.includes('終了しました'));
    await waitFor(() => f.service.bindings.size === 0);
    assert.equal($('terminal-dialog').open, false);
    assert.equal($('status').textContent, '終了');
    assert.equal($('terminal-open').disabled, true);
    assert.equal($('composer-terminal').hidden, true);
    assert.equal($('send').disabled, true);
    assert.equal($('terminal-send').disabled, true);
    assert.equal($('draft').value, '保持する下書き');
    assert.match($('turns').textContent, /保持する履歴/);
    assert.equal(window.document.querySelector('.thread-button[data-thread-id="a"]'), null);
    f.state.threads.get('a').status = { type: 'idle' };
    f.state.process = process;
    await waitFor(() => !$('send').disabled);
    assert.equal($('status').textContent, '待機中');
    assert.equal($('terminal-open').disabled, false);
    assert.equal($('composer-terminal').hidden, true);
    assert.equal($('draft').value, '保持する下書き');
    assert.match($('turns').textContent, /保持する履歴/);
    f.state.failHerdr = true;
    await waitFor(() => $('connection').classList.contains('error') && $('send').disabled);
    assert.equal($('draft').value, '保持する下書き');
    assert.match($('turns').textContent, /保持する履歴/);
    f.state.failHerdr = false;
    await waitFor(() => !$('send').disabled && !$('connection').classList.contains('error'));
});

test('terminal selection and delayed binding or screen responses keep input on the displayed pane', async t => {
    const f = await fixture(); t.after(() => f.close());
    f.state.panes[1].agent_session = null;
    f.state.resources.get(201).ports = new Set([41001]);
    f.state.panes.push({ pane_id: 'w3:p3', terminal_id: 'term3', agent_status: 'blocked' });
    f.state.processes.set('w3:p3', { shell_pid: 102, foreground_process_group_id: 202, foreground_processes: [{ pid: 202, name: 'codex', argv: ['codex'] }] });
    f.state.resources.set(202, { ports: new Set([41002]), threadIds: new Set() });
    const { window, $ } = await mount(t, f, true);
    const selectThread = id => window.document.querySelector(`.thread-button[data-thread-id="${id}"]`).click();
    const choose = paneId => { $('pane-select').value = paneId; $('pane-select').dispatchEvent(new window.Event('change')); };
    const shown = paneId => $('terminal-state').textContent.startsWith(paneId) && !$('terminal-refresh').disabled;
    selectThread('a');
    await waitFor(() => $('draft').disabled === false && $('turns').children.length === 20);
    $('terminal-open').click();
    await waitFor(() => $('pane-select').options.length === 3);
    choose('w1:p1'); $('bind').click();
    await waitFor(() => shown('w1:p1'));
    choose('w2:p2');
    assert.equal($('terminal-send').disabled, true);
    assert.equal($('terminal-screen').textContent, '');
    $('terminal-send').click();
    assert.equal(f.state.writes.length, 0);
    choose('w1:p1');
    const olderBind = holdResponse(window, (path, options) => path.endsWith('/bind') && JSON.parse(options.body).paneId === 'w1:p1');
    $('bind').click(); await waitFor(() => olderBind.seen);
    choose('w2:p2'); $('bind').click();
    await waitFor(() => shown('w2:p2'));
    olderBind.release();
    await waitFor(() => !f.service.bindings.has(olderBind.value.bindingId));
    assert.equal($('pane-select').value, 'w2:p2');
    assert.equal(shown('w2:p2'), true);
    $('terminal-text').value = '選択中の端末への入力'; $('terminal-send').click();
    await waitFor(() => f.state.writes.length === 1 && !$('terminal-refresh').disabled);
    assert.equal(f.state.writes[0].pane_id, 'w2:p2');
    choose('w1:p1');
    f.state.screen = '古い端末表示';
    const olderRead = holdResponse(window, path => path.includes('/terminal?'));
    $('bind').click(); await waitFor(() => olderRead.seen);
    choose('w2:p2'); f.state.screen = '選択中の端末表示'; $('bind').click();
    await waitFor(() => shown('w2:p2'));
    olderRead.release(); await waitFor(() => olderRead.consumed);
    assert.equal($('terminal-screen').textContent, '選択中の端末表示');
    assert.equal(shown('w2:p2'), true);
    for (const transition of ['reopen', 'conversation']) {
        choose('w1:p1');
        const stale = holdResponse(window, (path, options) => path.endsWith('/bind') && JSON.parse(options.body).paneId === 'w1:p1');
        $('bind').click(); await waitFor(() => stale.seen);
        if (transition === 'reopen') $('terminal-close').click();
        else { selectThread('b'); selectThread('a'); }
        $('terminal-open').click();
        await waitFor(() => $('pane-select').options.length === 3);
        choose('w2:p2'); $('bind').click(); await waitFor(() => shown('w2:p2'));
        stale.release(); await waitFor(() => !f.service.bindings.has(stale.value.bindingId));
        assert.equal(shown('w2:p2'), true);
        assert.equal($('terminal-screen').textContent, '選択中の端末表示');
    }
    $('terminal-close').click();
    await waitFor(() => f.service.bindings.size === 0);
});

test('late operation lookups cannot clear a newer message or terminal submission', async t => {
    for (const terminal of [false, true]) {
        await t.test(terminal ? 'terminal failure lookup' : 'message success lookup', async t => {
            const f = await fixture(); t.after(() => f.close());
            const { window, $ } = await mount(t, f, true);
            window.document.querySelector('.thread-button[data-thread-id="a"]').click();
            await waitFor(() => $('turns').children.length === 20);
            if (terminal) {
                $('terminal-open').click(); await waitFor(() => $('pane-select').options.length === 2);
                $('pane-select').value = 'w1:p1'; $('bind').click();
                await waitFor(() => $('terminal-state').textContent.includes('会話IDで関連付け済み'));
                f.state.screen += '\n表示の変更';
            }
            const pending = () => JSON.parse(window.sessionStorage.getItem('pending'))[terminal ? 'terminal' : 'a'];
            const submit = text => {
                $(terminal ? 'terminal-text' : 'draft').value = text;
                if (!terminal) $('draft').dispatchEvent(new window.Event('input'));
                $(terminal ? 'terminal-send' : 'send').click();
            };
            const endpoint = terminal ? '/terminal-input' : '/send';
            const first = holdResponse(window, path => path.endsWith(endpoint));
            submit('最初の入力'); await waitFor(() => first.seen);
            const firstId = pending().requestId;
            f.state.queue = [];
            first.fail(); await waitFor(() => pending()?.state === 'unknown');
            const lookup = holdResponse(window, path => path === `/api/operations/${firstId}`);
            window.document.dispatchEvent(new window.Event('visibilitychange'));
            await waitFor(() => lookup.seen);
            $(terminal ? 'terminal-resolve' : 'resolve').click();
            f.state.queue = [];
            if (terminal) {
                $('terminal-refresh').click(); await waitFor(() => !$('terminal-refresh').disabled);
            } else await waitFor(() => !$('send').disabled);
            const second = holdResponse(window, path => path.endsWith(endpoint));
            submit('次の入力'); await waitFor(() => second.seen);
            const secondId = pending().requestId;
            const afterLookup = holdResponse(window, path => path.includes('/history'));
            lookup.release(); await waitFor(() => afterLookup.seen);
            assert.equal(pending().requestId, secondId);
            assert.equal(pending().state, 'processing');
            assert.equal($(terminal ? 'terminal-text' : 'draft').value, '次の入力');
            if (terminal) assert.match($('terminal-result').textContent, /確認しています/);
            afterLookup.release(); second.fail();
            await waitFor(() => pending()?.state === 'unknown');
            f.state.queue = [];
            await waitFor(() => {
                window.document.dispatchEvent(new window.Event('visibilitychange'));
                return !pending();
            });
            assert.equal($(terminal ? 'terminal-text' : 'draft').value, '');
            if (terminal) {
                await waitFor(() => !$('terminal-refresh').disabled);
                assert.match($('terminal-result').textContent, /端末へ送信しました/);
                assert.equal($('terminal-resolve').hidden, true);
                assert.equal($('terminal-send').disabled, false);
            }
        });
    }
});

test('mobile navigation preserves reading position, tool disclosure, drafts and list focus', async t => {
    const f = await fixture(); t.after(() => f.close());
    const turn = f.state.turns.get('a').at(-1);
    turn.items.push(
        { id: 'tool-next', type: 'commandExecution', command: 'pnpm build', status: 'inProgress', aggregatedOutput: 'ビルド中' },
        { id: 'message-between', type: 'agentMessage', text: '途中の説明' },
        { id: 'tool-after', type: 'commandExecution', command: 'pnpm test', status: 'completed', aggregatedOutput: 'テスト完了' },
    );
    const { window, $ } = await mount(t, f);
    const visible = () => window.document.body.classList.contains('reading');
    const getComputedStyle = window.getComputedStyle.bind(window);
    window.getComputedStyle = element => element.id === 'conversation' ? { display: visible() ? 'flex' : 'none' } : getComputedStyle(element);
    Object.defineProperties($('history'), {
        scrollHeight: { get: () => visible() ? 12000 : 0 },
        clientHeight: { get: () => visible() ? 600 : 0 },
    });
    const select = id => window.document.querySelector(`.thread-button[data-thread-id="${id}"]`).click();
    select('a');
    await waitFor(() => !$('send-state').textContent.includes('確認しています') && window.document.querySelectorAll('.turn').length === 20);
    let article = window.document.querySelector('.turn[data-id="turn-26"]');
    assert.deepEqual([...article.children].map(item => item.tagName), ['SECTION', 'SECTION', 'DETAILS', 'SECTION', 'DETAILS']);
    let tools = article.querySelector('details');
    assert.equal(tools.open, false);
    assert.equal(tools.querySelector('summary').textContent, 'ツール実行2件 · 実行中');
    assert.deepEqual([...tools.querySelectorAll('.tool-label')].map(item => item.textContent), ['pnpm check', 'pnpm build']);
    tools.open = true;
    $('history').scrollTop = 1000;
    $('draft').value = '会話ごとに保持する下書き'; $('draft').dispatchEvent(new window.Event('input'));
    turn.items.find(item => item.id === 'tool-next').status = 'completed';
    turn.items.find(item => item.id === 'tool-next').aggregatedOutput = 'ビルド完了';
    await waitFor(() => $('turns').textContent.includes('ビルド完了'));
    tools = window.document.querySelector('.turn[data-id="turn-26"] details');
    assert.equal(tools.open, true);
    assert.equal(tools.querySelector('summary').textContent, 'ツール実行2件 · 完了');
    assert.equal($('history').scrollTop, 1000);
    $('back').click();
    $('history').scrollTop = 0;
    const focused = window.document.querySelector('.thread-button[data-thread-id="a"]');
    focused.focus();
    f.state.threads.get('a').preview = '一覧の更新後も選択位置を保持';
    await waitFor(() => $('thread-list').textContent.includes('一覧の更新後も選択位置を保持'));
    assert.equal(window.document.activeElement.dataset.threadId, 'a');
    assert.equal(window.document.activeElement.classList.contains('thread-button'), true);
    select('b');
    await waitFor(() => $('turns').textContent.includes('別の会話の出力'));
    assert.equal($('status').textContent, '承認・回答待ち');
    assert.equal($('composer-terminal').hidden, false);
    $('composer-terminal').click();
    await waitFor(() => $('pane-select').options.length === 2);
    assert.equal($('terminal-dialog').open, true);
    assert.equal($('pane-select').value, 'w2:p2');
    assert.match($('pane-select').options[1].textContent, /API/);
    $('terminal-close').click();
    $('back').click();
    $('history').scrollTop = 0;
    select('a');
    await waitFor(() => $('turns').textContent.includes('ビルド完了'));
    assert.equal($('history').scrollTop, 1000);
    assert.equal($('draft').value, '会話ごとに保持する下書き');
    article = window.document.querySelector('.turn[data-id="turn-26"]');
    assert.equal(article.querySelector('details').open, true);
    assert.equal($('composer-terminal').hidden, true);
});
