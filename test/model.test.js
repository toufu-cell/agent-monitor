import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { mergeTurns, requestId, currentSelection } from '../web/model.js';
import { safeMarkdown } from '../web/markdown.js';
import { socketPaths } from '../src/cli.js';
import { tailscaleServe } from '../src/tailscale.js';

test('older pages survive head refresh and running items update by stable ID', () => {
    const turn = (id, text) => ({ id, items: [{ id: `${id}-item`, text }] });
    let turns = mergeTurns([], [turn('b', '途中')]);
    turns = mergeTurns(turns, [turn('a', '過去')], true);
    turns = mergeTurns(turns, [turn('b', '完了'), turn('c', '新着')]);
    assert.deepEqual(turns.map(turn => turn.id), ['a', 'b', 'c']);
    assert.equal(turns[1].items[0].text, '完了');
    assert.equal(turns[0].items[0].text, '過去');
    assert.equal(currentSelection('b', 3, 'a', 2), false);
    assert.equal(currentSelection('a', 4, 'a', 2), false);
});

test('Markdown removes executable HTML, dangerous links, remote images and styling', () => {
    const window = new JSDOM('').window;
    const html = safeMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)><svg onload=alert(2)></svg>\n\n[x](javascript:alert(1)) [data](data:text/html,x) [safe](https://example.com)\n\n<a href="//evil.example" style="color:red" onclick="alert(1)">link</a>', createDOMPurify(window));
    const document = new JSDOM(html).window.document;
    assert.equal(document.querySelector('script,img,svg,[style],[onclick],[onerror]'), null);
    assert.deepEqual([...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')), ['https://example.com']);
    window.close();
});

test('request IDs use getRandomValues without secure-context randomUUID', () => {
    let invoked = false;
    const id = requestId({ getRandomValues(bytes) { invoked = true; bytes.fill(15); return bytes; } });
    assert.equal(invoked, true); assert.match(id, /^[a-f0-9]{48}$/);
    assert.notEqual(requestId(), requestId());
});

test('socket discovery uses override, environment and Codex home', () => {
    assert.deepEqual(socketPaths({}, { CODEX_HOME: '/custom', HERDR_SOCKET_PATH: '/fake/herdr' }, '/home'), { codex: '/custom/app-server-control/app-server-control.sock', herdr: '/fake/herdr' });
    assert.equal(socketPaths({ 'codex-socket': '/override' }, { CODEX_APP_SERVER_CONTROL_SOCKET: '/env' }).codex, '/override');
    assert.equal(socketPaths({}, { CODEX_APP_SERVER_CONTROL_SOCKET: '/env' }).codex, '/env');
});

const serveListener = 'monitor.example.ts.net:443';
function serveFixture(port = 4317) {
    return {
        status: { BackendState: 'Running', Self: { DNSName: 'monitor.example.ts.net.', UserID: 42 }, User: { 42: { LoginName: 'owner@example.com' } } },
        serve: { TCP: { 443: { HTTPS: true } }, Web: { [serveListener]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } },
    };
}
const serveRunner = data => async (_executable, args) => ({ stdout: JSON.stringify(args[0] === 'status' ? data.status : data.serve) });

test('Tailscale Serve derives a fixed HTTPS origin and keeps the selected executable', async () => {
    for (const fallback of [false, true]) {
        const data = serveFixture(4320), calls = [];
        const run = async (executable, args, options) => {
            calls.push({ executable, args });
            assert.equal(options.timeout, 5000);
            if (fallback && executable === 'tailscale') throw Object.assign(new Error('Command not found'), { code: 'ENOENT' });
            return serveRunner(data)(executable, args);
        };
        assert.deepEqual(await tailscaleServe(4320, run), { origin: 'https://monitor.example.ts.net', tailscaleLogin: 'owner@example.com' });
        const selected = fallback ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale';
        assert.deepEqual(calls, [
            ...(fallback ? [{ executable: 'tailscale', args: ['status', '--json'] }] : []),
            { executable: selected, args: ['status', '--json'] },
            { executable: selected, args: ['serve', 'status', '--json'] },
        ]);
    }
    const data = serveFixture();
    data.status.Self.DNSName = 'monitor.example.ts.net';
    data.serve.TCP[8443] = { TCPForward: '127.0.0.1:9000' };
    data.serve.Web['other.example.ts.net:8443'] = { Handlers: { '/': { Text: 'Other service' } } };
    data.serve.AllowFunnel = { 'other.example.ts.net:8443': true };
    data.serve.Foreground = { unrelated: { TCP: { 8080: { HTTP: true } } } };
    data.serve.Services = { 'svc:unrelated': { TCP: { 443: { TCPForward: '127.0.0.1:9001' } } } };
    assert.equal((await tailscaleServe(4317, serveRunner(data))).origin, 'https://monitor.example.ts.net');
});

test('Tailscale Serve refuses stopped, invalid identity, missing and conflicting configuration', async t => {
    const cases = [
        ['stopped', data => { data.status.BackendState = 'Stopped'; }, /停止/],
        ['missing DNS', data => { delete data.status.Self.DNSName; }, /DNS名/],
        ['invalid DNS', data => { data.status.Self.DNSName = 'monitor.example.ts.net/path'; }, /DNS名/],
        ['missing own user', data => { data.status.Self.UserID = 99; }, /LoginName/],
        ['empty login', data => { data.status.User[42].LoginName = ''; }, /LoginName/],
        ['invalid login', data => { data.status.User[42].LoginName = 'owner@example.com\n'; }, /LoginName/],
        ['unconfigured', data => { data.serve = {}; }, /serve --bg --https=443 http:\/\/127.0.0.1:4317/],
        ['missing HTTPS flag', data => { delete data.serve.TCP[443].HTTPS; }, /HTTPS 443/],
        ['TCP forwarding', data => { data.serve.TCP[443].TCPForward = '127.0.0.1:4317'; }, /HTTPS 443/],
        ['wrong origin', data => { data.serve.Web['other.example.ts.net:443'] = data.serve.Web[serveListener]; delete data.serve.Web[serveListener]; }, /ルート転送/],
        ['wrong backend', data => { data.serve.Web[serveListener].Handlers['/'].Proxy = 'http://127.0.0.1:4320'; }, /ルート転送/],
        ['non-root handler', data => { data.serve.Web[serveListener].Handlers = { '/monitor/': { Proxy: 'http://127.0.0.1:4317' } }; }, /ルート転送/],
        ['extra API handler', data => { data.serve.Web[serveListener].Handlers['/api/'] = { Proxy: 'http://127.0.0.1:4320' }; }, /追加ハンドラー/],
        ['Funnel', data => { data.serve.AllowFunnel = { [serveListener]: true }; }, /Funnel/],
        ['foreground only', data => { data.serve = { Foreground: { session: data.serve } }; }, /Foreground/],
        ['foreground conflict', data => { data.serve.Foreground = { session: { TCP: { 443: { TCPForward: '127.0.0.1:4320' } } } }; }, /Foreground/],
    ];
    for (const [name, mutate, error] of cases) {
        await t.test(name, async () => {
            const data = serveFixture(); mutate(data);
            await assert.rejects(() => tailscaleServe(4317, serveRunner(data)), error);
        });
    }
    await assert.rejects(() => tailscaleServe(4317, async () => { throw new Error('Daemon unavailable'); }), /Tailscale.app/);
    const executables = [];
    await assert.rejects(() => tailscaleServe(4317, async (executable, args) => {
        executables.push(executable);
        if (args[0] === 'serve') throw Object.assign(new Error('Serve unavailable'), { code: 'ENOENT' });
        return { stdout: JSON.stringify(serveFixture().status) };
    }), /serve --bg/);
    assert.deepEqual(executables, ['tailscale', 'tailscale']);
});
