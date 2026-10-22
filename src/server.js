import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { HttpError, requireString } from './service.js';

const STATIC = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
    ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
    ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

function authenticated(header, token) {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(header || '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function jsonBody(request) {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'JSON形式で送信してください。');
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 128 * 1024) throw new HttpError(413, '送信内容が上限を超えました。');
        chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'JSONを読み取れません。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '送信内容を確認してください。');
    return body;
}

export function createMonitorServer({ service, notifications, token, tailscaleLogin, origin, dist = new URL('../dist/', import.meta.url) }) {
    const expectedOrigin = new URL(origin).origin;
    const expectedHost = new URL(origin).host;
    const serveMode = tailscaleLogin !== undefined;
    if (serveMode) {
        if (typeof tailscaleLogin !== 'string' || !tailscaleLogin || /[\s,\x00-\x1f\x7f]/.test(tailscaleLogin) || new URL(origin).protocol !== 'https:') {
            throw new Error('Tailscale Serveには本人のLoginNameとHTTPSの接続先が必要です。');
        }
    } else if (typeof token !== 'string' || !token) {
        throw new Error('ローカル接続には認証トークンが必要です。');
    }
    const server = http.createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        const json = (status, value) => {
            if (response.destroyed || response.writableEnded) return;
            response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(value));
        };
        try {
            if (request.headers.host !== expectedHost) throw new HttpError(403, '接続先のHostが許可されていません。');
            if (request.headers.origin && request.headers.origin !== expectedOrigin) throw new HttpError(403, '接続元のOriginが許可されていません。');
            const url = new URL(request.url, expectedOrigin);
            if (url.pathname.startsWith('/api/')) {
                if (serveMode) {
                    if (request.headers['tailscale-user-login'] !== tailscaleLogin) throw new HttpError(401, 'Tailscale Serveで本人のログインを確認できません。PCと同じTailscaleアカウントで接続してください。');
                } else if (!authenticated(request.headers.authorization, token)) throw new HttpError(401, '認証できません。PCに表示されたQRコードから接続し直してください。');
                if (url.searchParams.has('token')) throw new HttpError(400, '認証情報はURLに指定できません。');
                if (request.method === 'POST' && request.headers.origin !== expectedOrigin) throw new HttpError(403, '変更操作にはOriginが必要です。');
                const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
                const [, resource, id, action] = segments;
                if (resource === 'notifications') {
                    const available = serveMode && notifications;
                    if (request.method === 'GET' && segments.length === 2) return json(200, available ? notifications.status() : { available: false, error: '通知はTailscale ServeのHTTPSで利用できます。' });
                    if (!available) throw new HttpError(503, '通知はTailscale ServeのHTTPSで利用できます。');
                    if (request.method === 'POST' && segments.length === 3) {
                        const body = await jsonBody(request);
                        if (id === 'subscribe') return json(200, await notifications.subscribe(body.subscription));
                        if (id === 'status') return json(200, notifications.registered(body.endpoint));
                        if (id === 'unsubscribe') return json(200, await notifications.unsubscribe(body.endpoint));
                        if (id === 'test') return json(200, await notifications.test(body.endpoint));
                    }
                    throw new HttpError(404, 'APIが見つかりません。');
                }
                if (request.method === 'GET') {
                    if (url.pathname === '/api/threads') return json(200, await service.list());
                    if (resource === 'operations' && segments.length === 3) return json(200, service.operation(id));
                    if (resource === 'launches' && segments.length === 3) return json(200, await service.launchStatus(id));
                    if (resource === 'launches' && action === 'terminal' && segments.length === 4) return json(200, await service.terminal(id, requireString(url.searchParams.get('bindingId')), 'launch'));
                    if (resource === 'threads' && segments.length === 4) {
                        if (action === 'state') return json(200, await service.questionState(id));
                        if (action === 'usage') return json(200, await service.usage(id));
                        if (action === 'history') return json(200, await service.history(id, url.searchParams.get('cursor'), url.searchParams.get('until')));
                        if (action === 'panes') return json(200, { panes: await service.panes(id) });
                        if (action === 'terminal') return json(200, await service.terminal(id, requireString(url.searchParams.get('bindingId'))));
                    }
                }
                if (request.method === 'POST' && resource === 'launches') {
                    const body = await jsonBody(request);
                    if (segments.length === 2) return json(200, await service.launch(body));
                    if (segments.length === 4) {
                        if (action === 'confirm') return json(200, service.confirmLaunch(id, body));
                        if (action === 'bind') return json(200, await service.bind(id, body.paneId, 'launch'));
                        if (action === 'unbind') return json(200, service.unbind(id, body.bindingId, 'launch'));
                        if (action === 'terminal-input') return json(200, await service.terminalInput(id, body, 'launch'));
                    }
                }
                if (request.method === 'POST' && resource === 'threads' && segments.length === 4) {
                    const body = await jsonBody(request);
                    if (action === 'send') return json(200, await service.send(id, body));
                    if (action === 'answer') return json(200, await service.answer(id, body));
                    if (action === 'answer-recover') return json(200, await service.recoverAnswer(id, body));
                    if (action === 'bind') return json(200, await service.bind(id, body.paneId));
                    if (action === 'unbind') return json(200, service.unbind(id, body.bindingId));
                    if (action === 'terminal-input') return json(200, await service.terminalInput(id, body));
                }
                throw new HttpError(404, 'APIが見つかりません。');
            }
            const file = STATIC.get(url.pathname);
            const threadQuery = url.pathname === '/' && [...url.searchParams.keys()].every(key => key === 'thread')
                && url.searchParams.getAll('thread').length <= 1 && (!url.searchParams.has('thread') || (url.searchParams.get('thread').length > 0 && url.searchParams.get('thread').length <= 200));
            if (request.method !== 'GET' || !file || (url.search && !threadQuery)) throw new HttpError(404, 'ページが見つかりません。');
            const content = await readFile(new URL(file[0], dist));
            response.writeHead(200, { 'Content-Type': file[1] });
            response.end(content);
        } catch (error) {
            json(error.status || 500, { error: error.status ? error.message : '要求を処理できません。接続を確認してください。' });
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.timeout = 30000;
    server.keepAliveTimeout = 5000;
    return server;
}
