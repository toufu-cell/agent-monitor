import webpush from 'web-push';
import { createECDH, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, chmod, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { HttpError } from './service.js';

const MAX_SUBSCRIPTIONS = 32;
const STORE_ERROR = '通知の保存ファイルを読み書きできません。PCで保存先を確認してください。';

function keyBytes(value, length) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid push key');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== length || bytes.toString('base64url') !== value) throw new Error('Invalid push key');
    return bytes;
}

function endpointUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid push endpoint');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
        || !(url.hostname.endsWith('.push.apple.com') || ['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname))
        || url.pathname === '/') throw new Error('Invalid push endpoint');
    return url.href;
}

function subscriptionValue(value) {
    try {
        const endpoint = endpointUrl(value?.endpoint);
        const publicKey = keyBytes(value?.keys?.p256dh, 65);
        const ecdh = createECDH('prime256v1');
        ecdh.generateKeys();
        ecdh.computeSecret(publicKey);
        keyBytes(value?.keys?.auth, 16);
        return { endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
    } catch { throw new HttpError(400, '通知の受信先または暗号鍵を確認できません。'); }
}

function notificationTitle(title) {
    return String(title || '名前のない会話').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
        .replace(/(?:~?\/|[A-Za-z]:\\)[^\s]+/g, '会話').slice(0, 70);
}

export class Notifications {
    constructor({ service, origin, file = join(homedir(), '.local/share/agent-monitor/notifications.json'),
        send = (...args) => webpush.sendNotification(...args), intervalMs = 5000 }) {
        this.service = service;
        this.origin = new URL(origin).origin;
        this.file = file;
        this.send = send;
        this.intervalMs = intervalMs;
        this.data = null;
        this.error = null;
        this.writes = Promise.resolve();
        this.previous = new Map();
        this.initialized = false;
        this.running = null;
        this.timer = null;
        this.closed = false;
        this.monitorVersion = 0;
    }

    async open() {
        try {
            let source;
            try {
                if ((await stat(this.file)).size > 1024 * 1024) throw new Error('Push store too large');
                source = await readFile(this.file, 'utf8');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (source !== undefined) {
                const data = JSON.parse(source);
                if (data.version !== 1 || !Array.isArray(data.subscriptions) || data.subscriptions.length > MAX_SUBSCRIPTIONS) throw new Error('Invalid push store');
                const ecdh = createECDH('prime256v1');
                ecdh.setPrivateKey(keyBytes(data.vapid?.privateKey, 32));
                if (!ecdh.getPublicKey().equals(keyBytes(data.vapid?.publicKey, 65))) throw new Error('Invalid VAPID keys');
                this.data = { version: 1, vapid: { publicKey: data.vapid.publicKey, privateKey: data.vapid.privateKey }, subscriptions: data.subscriptions.map(subscriptionValue) };
                if (new Set(this.data.subscriptions.map(value => value.endpoint)).size !== this.data.subscriptions.length) throw new Error('Duplicate push subscription');
                await chmod(dirname(this.file), 0o700);
                await chmod(this.file, 0o600);
            } else {
                this.data = { version: 1, vapid: webpush.generateVAPIDKeys(), subscriptions: [] };
                await this.persist(this.data);
            }
        } catch { this.error = STORE_ERROR; this.data = null; }
        if (this.data?.subscriptions.length) { await this.poll(); this.schedule(); }
        return this;
    }

    status() {
        return { available: !this.error && !this.closed, ...(this.error ? { error: this.error } : { publicKey: this.data?.vapid.publicKey }) };
    }

    requireAvailable() {
        if (this.error || this.closed || !this.data) throw new HttpError(503, this.error || '通知を利用できません。');
    }

    async persist(data) {
        const directory = dirname(this.file);
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        try {
            await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
            await rename(temporary, this.file);
        } finally { await rm(temporary, { force: true }); }
    }

    update(change) {
        const result = this.writes.then(async () => {
            this.requireAvailable();
            const next = { ...this.data, subscriptions: [...this.data.subscriptions] };
            change(next.subscriptions);
            try { await this.persist(next); }
            catch { this.error = STORE_ERROR; clearTimeout(this.timer); throw new HttpError(503, STORE_ERROR); }
            this.data = next;
        });
        this.writes = result.catch(() => {});
        return result;
    }

    async subscribe(value) {
        const subscription = subscriptionValue(value);
        await this.update(subscriptions => {
            if (!subscriptions.length) { this.monitorVersion++; this.previous.clear(); this.initialized = false; }
            const index = subscriptions.findIndex(value => value.endpoint === subscription.endpoint);
            if (index >= 0) subscriptions[index] = subscription;
            else {
                if (subscriptions.length >= MAX_SUBSCRIPTIONS) throw new HttpError(409, '通知の登録数が上限に達しました。使わない端末の通知を解除してください。');
                subscriptions.push(subscription);
            }
        });
        await this.poll();
        this.schedule();
        return { registered: true };
    }

    registered(endpoint) {
        this.requireAvailable();
        let normalized;
        try { normalized = endpointUrl(endpoint); } catch { throw new HttpError(400, '通知の受信先を確認できません。'); }
        return { registered: this.data.subscriptions.some(value => value.endpoint === normalized) };
    }

    async unsubscribe(endpoint) {
        this.registered(endpoint);
        await this.update(subscriptions => {
            const index = subscriptions.findIndex(value => value.endpoint === new URL(endpoint).href);
            if (index >= 0) subscriptions.splice(index, 1);
        });
        if (!this.data.subscriptions.length) {
            this.monitorVersion++;
            clearTimeout(this.timer);
            this.previous.clear(); this.initialized = false;
        }
        return { registered: false };
    }

    async deliver(subscription, payload) {
        try {
            await this.send(subscription, JSON.stringify(payload), { timeout: 10000, TTL: 300,
                vapidDetails: { subject: this.origin, ...this.data.vapid } });
            return true;
        } catch (error) {
            if ([404, 410].includes(error.statusCode)) {
                await this.update(subscriptions => {
                    const index = subscriptions.findIndex(value => value === subscription);
                    if (index >= 0) subscriptions.splice(index, 1);
                }).catch(() => {});
            }
            return false;
        }
    }

    async test(endpoint) {
        if (!this.registered(endpoint).registered) throw new HttpError(409, 'この端末の通知を有効にしてください。');
        const subscription = this.data.subscriptions.find(value => value.endpoint === new URL(endpoint).href);
        if (!await this.deliver(subscription, { title: 'Agent Monitor', body: 'テスト通知です。', url: '/' })) {
            throw new HttpError(502, 'テスト通知を送信できません。通知の登録を確認してください。');
        }
        return { sent: true };
    }

    schedule() {
        clearTimeout(this.timer);
        if (this.closed || this.error || !this.data?.subscriptions.length) return;
        this.timer = setTimeout(async () => { await this.poll(); this.schedule(); }, this.intervalMs);
        this.timer.unref?.();
    }

    poll() {
        if (this.running) return this.running;
        if (this.closed || this.error || !this.data?.subscriptions.length) return Promise.resolve();
        this.running = this.scan().finally(() => { this.running = null; });
        return this.running;
    }

    async scan() {
        const version = this.monitorVersion;
        let states;
        try { states = await this.service.notificationStates(); }
        catch {
            for (const previous of this.previous.values()) previous.status = 'unknown';
            return;
        }
        if (version !== this.monitorVersion || this.closed || !this.data.subscriptions.length) return;
        const next = new Map();
        for (const state of states) {
            const { thread } = state;
            const previous = this.previous.get(thread.id);
            const suppressQuestions = previous?.suppressQuestions ?? !this.initialized;
            const keys = state.questions.map(question => JSON.stringify([question.turnId, question.itemId, question.index]));
            const seen = new Set(previous?.seen || []);
            const freshQuestion = !suppressQuestions && state.questionsReady !== false && keys.some(key => !seen.has(key));
            keys.forEach(key => seen.add(key));
            const status = state.questionsReady === false ? 'unknown' : thread.status.type;
            next.set(thread.id, { status, seen, suppressQuestions: state.questionsReady === false && suppressQuestions });
            const bodies = [];
            if (this.initialized && previous?.status === 'active' && status === 'idle') bodies.push('作業が完了しました');
            if (this.initialized && freshQuestion) bodies.push('回答待ちの質問があります');
            for (const body of bodies) {
                if (this.closed || this.error || version !== this.monitorVersion) break;
                const payload = { title: notificationTitle(thread.title), body, url: `/?thread=${encodeURIComponent(thread.id)}` };
                await Promise.all(this.data.subscriptions.map(subscription => this.deliver(subscription, payload)));
            }
        }
        for (const [id, previous] of this.previous) {
            if (!next.has(id)) next.set(id, { ...previous, status: 'unknown' });
        }
        if (version === this.monitorVersion) { this.previous = next; this.initialized = true; }
    }

    async close() {
        this.closed = true;
        clearTimeout(this.timer);
        await this.running;
        await this.writes;
    }
}
