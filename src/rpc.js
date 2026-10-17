import net from 'node:net';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class UpstreamError extends Error {
    constructor(message, uncertain = false, rpcError = {}) {
        super(message);
        this.uncertain = uncertain;
        this.status = 502;
        this.code = rpcError.code;
        this.rpcMessage = rpcError.message;
    }
}

export class CodexClient {
    constructor(socketPath, timeout = 8000) {
        this.socketPath = socketPath;
        this.timeout = timeout;
        this.pending = new Map();
    }

    async connect() {
        if (this.ws?.readyState === WebSocket.OPEN && this.ready) return;
        if (this.connecting) return this.connecting;
        this.connecting = this.open().finally(() => { this.connecting = null; });
        return this.connecting;
    }

    async open() {
        const ws = new WebSocket('ws://localhost/', {
            createConnection: () => net.createConnection(this.socketPath),
            handshakeTimeout: this.timeout,
            maxPayload: 32 * 1024 * 1024,
        });
        this.ws = ws;
        this.ready = false;
        ws.on('message', data => {
            let message;
            try { message = JSON.parse(data.toString()); } catch { return; }
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new UpstreamError('Codexが要求を拒否しました。', false, message.error));
            else pending.resolve(message.result);
        });
        ws.on('error', () => {});
        ws.on('close', () => {
            if (this.ws === ws) this.ready = false;
            for (const [id, pending] of this.pending) {
                if (pending.ws !== ws) continue;
                clearTimeout(pending.timer);
                pending.reject(new UpstreamError('Codexとの接続が切れました。', true));
                this.pending.delete(id);
            }
        });
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', () => reject(new UpstreamError('Codexのsocketへ接続できません。')));
        });
        try {
            await this.send('initialize', {
                clientInfo: { name: 'agent_monitor', version: '0.1.0', title: 'Agent Monitor' },
                capabilities: { experimentalApi: true },
            });
            ws.send(JSON.stringify({ method: 'initialized' }));
            this.ready = true;
        } catch (error) {
            ws.close();
            throw error;
        }
    }

    send(method, params) {
        const ws = this.ws;
        if (ws?.readyState !== WebSocket.OPEN) throw new UpstreamError('Codexへ接続できません。');
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new UpstreamError('Codexの応答を確認できません。', true));
            }, this.timeout);
            this.pending.set(id, { resolve, reject, timer, ws });
            ws.send(JSON.stringify({ id, method, params }), error => {
                if (!error) return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new UpstreamError('Codexへの送信結果を確認できません。', true));
            });
        });
    }

    async call(method, params = {}) {
        await this.connect();
        return this.send(method, params);
    }

    close() { this.ws?.close(); }
}

export class HerdrClient {
    constructor(socketPath, timeout = 8000) {
        this.socketPath = socketPath;
        this.timeout = timeout;
    }

    call(method, params = {}) {
        if (!this.socketPath) throw new UpstreamError('Herdrのsocketを指定してください。');
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(this.socketPath);
            socket.setEncoding('utf8');
            const id = randomUUID();
            let buffer = '';
            let sent = false;
            const finish = (error, value) => {
                socket.destroy();
                if (error) reject(error); else resolve(value);
            };
            socket.setTimeout(this.timeout, () => finish(new UpstreamError('Herdrの応答を確認できません。', sent)));
            socket.on('error', () => finish(new UpstreamError('Herdrへ接続できません。', sent)));
            socket.on('end', () => finish(new UpstreamError('Herdrとの接続が切れました。', sent)));
            socket.on('connect', () => {
                sent = true;
                socket.write(`${JSON.stringify({ id, method, params })}\n`);
            });
            socket.on('data', data => {
                buffer += data.toString();
                if (buffer.length > 4 * 1024 * 1024) return finish(new UpstreamError('端末の応答が上限を超えました。', sent));
                if (!buffer.includes('\n')) return;
                try {
                    const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
                    if (message.id !== id) return finish(new UpstreamError('Herdrの応答IDが一致しません。', sent));
                    if (message.error) return finish(new UpstreamError('Herdrが要求を拒否しました。', false, message.error));
                    finish(null, message.result);
                } catch { finish(new UpstreamError('Herdrの応答を読み取れません。', sent)); }
            });
        });
    }
}
