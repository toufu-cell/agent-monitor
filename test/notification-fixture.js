import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fakes.js';
import { Notifications } from '../src/notifications.js';
import { createMonitorServer } from '../src/server.js';

export async function notificationFixture(t, { tls = false } = {}) {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), 'am-push-web-'));
    let server, proxy;
    if (tls) {
        const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
        proxy = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
            const upstream = http.request({ host: '127.0.0.1', port: server.address().port, path: request.url, method: request.method,
                headers: { ...request.headers, 'tailscale-user-login': 'owner@example.com' } }, result => {
                response.writeHead(result.statusCode, result.headers); result.pipe(response);
            });
            upstream.on('error', () => { response.writeHead(502); response.end(); });
            request.pipe(upstream);
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    }
    const origin = proxy ? `https://127.0.0.1:${proxy.address().port}` : 'https://monitor.example.ts.net';
    const sent = [];
    const notifications = await new Notifications({ service: f.service, origin, file: join(directory, 'store/notifications.json'), intervalMs: 60000,
        send: async (subscription, payload) => { sent.push(JSON.parse(payload)); } }).open();
    server = createMonitorServer({ service: f.service, origin, notifications, tailscaleLogin: 'owner@example.com' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await notifications.close();
        proxy?.closeAllConnections(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        if (proxy) await new Promise(resolve => proxy.close(resolve));
        await f.close(); await rm(directory, { recursive: true, force: true });
    });
    const request = (path, options = {}) => new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: server.address().port, path, method: options.method || 'GET',
            headers: { Host: new URL(origin).host, Origin: origin, 'Tailscale-User-Login': 'owner@example.com', ...options.headers } }, response => {
            let text = ''; response.setEncoding('utf8'); response.on('data', value => { text += value; });
            response.on('end', () => resolve({ ok: response.statusCode < 400, status: response.statusCode, json: async () => JSON.parse(text) }));
        });
        request.on('error', reject); request.end(options.body);
    });
    return { ...f, origin, notifications, sent, request };
}
