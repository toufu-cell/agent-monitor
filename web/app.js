import { mergeTurns, requestId, stateLabel, currentSelection, groupItems, toolState } from './model.js';
import { safeMarkdown } from './markdown.js';

const $ = id => document.getElementById(id);
const getStored = (key, fallback) => {
    try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
let token = sessionStorage.getItem('token') || '';
if (location.hash.length > 1) {
    token = location.hash.slice(1);
    sessionStorage.setItem('token', token);
    history.replaceState(null, '', location.pathname + location.search);
}
let notificationThread = new URL(location.href).searchParams.get('thread');
let notificationThreadMissing = false;
let notificationRegistration = null;
let notificationSubscription = null;
let notificationRegistered = false;
let notificationConfig = null;
let notificationBusy = false;
let selected = null;
let generation = 0;
let threads = [];
let listReady = false;
let polling = false;
let terminalBinding = null;
let terminalView = null;
let terminalBusy = false;
let terminalRequest = 0;
let terminalResultRequestId = null;
let terminalOwner = null;
let launchId = sessionStorage.getItem('launchRequestId') || null;
let launchState = launchId ? { requestId: launchId, state: 'waiting' } : null;
let launchBusy = false;
let launchPolling = false;
let launchError = '';
const caches = new Map();
const ranks = new Map();
const drafts = getStored('drafts', {});
const pending = getStored('pending', {});
const imageDrafts = getStored('imageDrafts', {});
const images = new Map();
const questionDrafts = getStored('questionDrafts', {});
const questionPending = getStored('questionPending', {});
let pins;
try { pins = new Set(JSON.parse(localStorage.getItem('pins') || '[]')); } catch { pins = new Set(); }
const save = () => {
    sessionStorage.setItem('drafts', JSON.stringify(drafts)); sessionStorage.setItem('pending', JSON.stringify(pending));
    sessionStorage.setItem('imageDrafts', JSON.stringify(imageDrafts));
    sessionStorage.setItem('questionDrafts', JSON.stringify(questionDrafts)); sessionStorage.setItem('questionPending', JSON.stringify(questionPending));
};
for (const [id, operation] of Object.entries(pending)) {
    if (operation.phase === 'uploading') delete pending[id];
}
sessionStorage.setItem('pending', JSON.stringify(pending));

async function api(path, body, keepalive = false) {
    const image = body instanceof File;
    const response = await fetch(`/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': image ? body.type : 'application/json' }) },
        body: body === undefined ? undefined : image ? body : JSON.stringify(body),
        signal: keepalive ? undefined : AbortSignal.timeout(image ? 180000 : 12000), keepalive,
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || '接続を確認してください。'), { status: response.status });
    return value;
}

function notificationState(message, error = false) {
    $('notification-state').textContent = message;
    $('notification-state').classList.toggle('error', error);
    $('notification-toggle').textContent = notificationRegistered ? '通知を解除する' : '通知を有効にする';
    $('notification-toggle').hidden = !notificationRegistration || !notificationConfig?.available;
    $('notification-toggle').disabled = notificationBusy || !notificationRegistration || !notificationConfig?.available;
    $('notification-test').hidden = !notificationRegistered;
    $('notification-test').disabled = notificationBusy;
}

async function checkNotifications() {
    try {
        notificationConfig = await api('notifications');
        if (!notificationConfig.available) return notificationState(notificationConfig.error || '通知を利用できません。');
        const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (iphone && !navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches) {
            return notificationState('通知はホーム画面に追加してから有効にしてください。');
        }
        if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
            return notificationState('このブラウザは通知に対応していません。');
        }
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        notificationRegistration = await navigator.serviceWorker.ready;
        notificationSubscription = await notificationRegistration.pushManager.getSubscription();
        notificationRegistered = notificationSubscription
            ? (await api('notifications/status', { endpoint: notificationSubscription.endpoint })).registered : false;
        notificationState(notificationRegistered ? '通知は有効です。' : Notification.permission === 'denied'
            ? '通知が拒否されています。端末の設定で許可してください。' : '作業完了と回答待ちの質問を通知します。');
    } catch (error) { notificationState(error.message, true); }
}

async function toggleNotifications() {
    if (notificationBusy || !notificationRegistration) return;
    notificationBusy = true;
    try {
        if (notificationRegistered) {
            notificationState('通知を解除しています…');
            await api('notifications/unsubscribe', { endpoint: notificationSubscription.endpoint });
            notificationRegistered = false;
            if (!await notificationSubscription.unsubscribe()) throw new Error('PCの登録を解除しました。端末の通知を解除するには再読込みしてください。');
            notificationSubscription = null;
            notificationState('通知を解除しました。');
        } else {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                notificationState('通知を許可してから有効にしてください。');
                return;
            }
            notificationState('通知を登録しています…');
            const key = Uint8Array.from(atob(notificationConfig.publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
            notificationSubscription = await notificationRegistration.pushManager.getSubscription()
                || await notificationRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
            const result = await api('notifications/subscribe', { subscription: notificationSubscription.toJSON() });
            if (!result.registered) throw new Error('PCに通知の登録を保存できません。もう一度有効にしてください。');
            notificationRegistered = true;
            notificationState('通知は有効です。');
        }
    } catch (error) { notificationState(error.message, true); }
    finally { notificationBusy = false; notificationState($('notification-state').textContent, $('notification-state').classList.contains('error')); }
}

async function testNotification() {
    if (notificationBusy || !notificationRegistered) return;
    notificationBusy = true; notificationState('テスト通知を送信しています…');
    try {
        await api('notifications/test', { endpoint: notificationSubscription.endpoint });
        notificationState('テスト通知を送信しました。端末の通知を確認してください。');
    } catch (error) { notificationState(error.message, true); }
    finally { notificationBusy = false; notificationState($('notification-state').textContent, $('notification-state').classList.contains('error')); }
}

async function openNotificationThread() {
    if (!notificationThread || !listReady) return;
    const id = notificationThread;
    notificationThread = null;
    if (threads.some(thread => thread.id === id)) await selectThread(id);
    else {
        notificationThreadMissing = true;
        rememberConversation(); closeTerminal(); document.body.classList.remove('reading');
    }
}

function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

function providerName(provider) {
    return provider === 'claude' ? 'Claude Code' : 'Codex';
}

function renderLaunch() {
    const state = launchState?.state;
    const active = launchId && !['failed', 'ended'].includes(state);
    $('launch-submit').disabled = launchBusy || Boolean(active);
    $('launch-path').disabled = launchBusy || Boolean(active);
    $('launch-open').textContent = active ? '起動状態を確認' : '新しいCodex会話';
    $('launch-state').textContent = launchError || (state === 'unknown'
        ? '起動結果が不明です。PCで確認するまで新しい起動を停止しています。'
        : state === 'waiting' ? 'PCでCodexの起動を待っています。承認が必要な場合は端末を開いてください。'
        : state === 'failed' ? `起動できませんでした。${launchState.message || ''}`
        : state === 'ended' ? '起動した端末のCodexは終了しました。'
        : '起動後に会話を開きます。この画面を閉じてもPCの処理は続きます。');
    $('launch-state').classList.toggle('error', Boolean(launchError) || ['failed', 'unknown'].includes(state));
    $('launch-terminal').hidden = !launchState?.terminalAvailable;
    $('launch-resolve').hidden = state !== 'unknown' || launchBusy;
}

function openLaunch() {
    closeTerminal({ returnToLaunch: false });
    renderLaunch();
    if (!$('launch-dialog').open) $('launch-dialog').showModal();
    refreshLaunch();
}

async function settleLaunch(result) {
    if (!launchId || result.requestId !== launchId) return;
    if (result.blockedBy) {
        launchId = result.blockedBy; sessionStorage.setItem('launchRequestId', launchId);
        launchState = { requestId: launchId, state: 'unknown' }; launchError = '';
        renderLaunch(); return;
    }
    launchState = result; launchError = '';
    renderLaunch();
    if (result.state !== 'ready' || !result.thread) return;
    const thread = result.thread;
    threads = [...threads.filter(candidate => candidate.id !== thread.id), thread];
    if (!ranks.has(thread.id)) ranks.set(thread.id, ranks.size);
    cacheFor(thread.id).thread = thread;
    launchId = null; sessionStorage.removeItem('launchRequestId');
    $('launch-dialog').close();
    closeTerminal({ returnToLaunch: false });
    renderLaunch(); renderList();
    await selectThread(thread.id);
}

async function refreshLaunch() {
    if (!launchId || launchBusy || launchPolling) return;
    const id = launchId;
    launchPolling = true;
    try { await settleLaunch(await api(`launches/${encodeURIComponent(id)}`)); }
    catch (error) {
        if (launchId === id) {
            launchState = { ...launchState, requestId: id, state: 'unknown', terminalAvailable: false, missing: error.status === 404 };
            launchError = `起動状態を取得できません。PCで結果を確認してください。${error.message}`;
            renderLaunch();
        }
    } finally { launchPolling = false; }
}

async function startLaunch(event) {
    event.preventDefault();
    if ($('launch-submit').disabled) return;
    const path = $('launch-path').value;
    if (!path.trim() || path.length > 4096 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(path)
        || !(path.startsWith('/') || path === '~' || path.startsWith('~/'))) {
        launchError = 'PCの絶対パスか~/で始まるパスを入力してください。'; renderLaunch(); return;
    }
    launchId = requestId();
    sessionStorage.setItem('launchRequestId', launchId);
    launchState = { requestId: launchId, state: 'waiting' };
    launchBusy = true; launchError = ''; renderLaunch();
    try { await settleLaunch(await api('launches', { path, requestId: launchId })); }
    catch (error) {
        if (error.status && error.status < 500) {
            launchId = null; sessionStorage.removeItem('launchRequestId'); launchState = null;
        } else launchState = { ...launchState, state: 'unknown' };
        launchError = error.message;
    } finally { launchBusy = false; renderLaunch(); }
}

async function confirmLaunch() {
    if (!launchId || launchState?.state !== 'unknown' || launchBusy) return;
    if (!window.confirm('PCで起動結果を確認しましたか？解除後は新しい操作として起動できます。')) return;
    launchBusy = true; renderLaunch();
    try {
        try { await api(`launches/${encodeURIComponent(launchId)}/confirm`, { confirmed: true }); }
        catch (error) { if (!(launchState.missing && error.status === 404)) throw error; }
        launchId = null; launchState = null; launchError = '';
        sessionStorage.removeItem('launchRequestId');
    } catch (error) { launchError = error.message; }
    finally { launchBusy = false; renderLaunch(); }
}

function renderList() {
    const focused = document.activeElement;
    const focusedThread = focused?.dataset.threadId;
    const focusedPin = focused?.classList.contains('pin');
    const scroll = $('thread-list').scrollTop;
    const query = $('search').value.toLocaleLowerCase();
    const visible = threads.filter(thread => `${thread.cwd} ${thread.title} ${thread.preview}`.toLocaleLowerCase().includes(query));
    visible.sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || ranks.get(a.id) - ranks.get(b.id));
    const groups = new Map();
    for (const thread of visible) {
        const key = pins.has(thread.id) ? 'ピン留め' : thread.cwd;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(thread);
    }
    const fragment = document.createDocumentFragment();
    for (const [project, entries] of groups) {
        fragment.append(node('h2', project || '場所未設定', 'project-group'));
        for (const thread of entries) {
            const row = node('div', undefined, `thread-row${thread.id === selected ? ' selected' : ''}`);
            const button = node('button', undefined, 'thread-button');
            button.dataset.threadId = thread.id;
            button.append(node('span', thread.title, 'thread-title'), node('span', thread.preview, 'thread-preview'));
            const meta = node('span', undefined, 'thread-meta');
            meta.append(node('span', `${providerName(thread.provider)} · ${stateLabel(thread.status)}`), node('time', new Date(thread.updatedAt * 1000).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
            button.append(meta);
            button.addEventListener('click', () => selectThread(thread.id));
            const pin = node('button', pins.has(thread.id) ? '★' : '☆', 'pin');
            pin.dataset.threadId = thread.id;
            pin.setAttribute('aria-label', `${thread.title}をピン留め`);
            pin.setAttribute('aria-pressed', String(pins.has(thread.id)));
            pin.addEventListener('click', () => {
                if (pins.has(thread.id)) pins.delete(thread.id); else pins.add(thread.id);
                localStorage.setItem('pins', JSON.stringify([...pins]));
                renderList();
            });
            row.append(button, pin); fragment.append(row);
        }
    }
    if (!visible.length && listReady) fragment.append(node('p', query ? '条件に合う会話がありません。' : '表示できる会話がありません。', 'notice'));
    $('thread-list').replaceChildren(fragment);
    if (focusedThread) {
        [...$('thread-list').querySelectorAll('button')].find(button => button.dataset.threadId === focusedThread && button.classList.contains('pin') === focusedPin)?.focus({ preventScroll: true });
    }
    $('thread-list').scrollTop = scroll;
}

function cacheFor(id) {
    if (!caches.has(id)) caches.set(id, { turns: [], cursor: null, loaded: false, historyReady: false, stateReady: false, questions: [], queue: [], fetching: false, openTools: new Set() });
    return caches.get(id);
}

function conversationVisible() { return getComputedStyle($('conversation')).display !== 'none'; }

function rememberConversation() {
    if (!selected) return;
    drafts[selected] = $('draft').value;
    if (conversationVisible()) cacheFor(selected).scroll = $('history').scrollTop;
    save();
}

function restoreReadingPosition(cache) {
    $('history').scrollTop = cache.scroll ?? $('history').scrollHeight;
    $('latest').hidden = !cache.unseen || nearBottom();
    readingPosition();
}

async function selectThread(id) {
    notificationThreadMissing = false;
    if (selected === id) {
        if (!conversationVisible()) { document.body.classList.add('reading'); restoreReadingPosition(cacheFor(id)); }
        return;
    }
    closeTerminal({ returnToLaunch: false });
    rememberConversation();
    selected = id; generation++;
    save();
    const thread = threads.find(thread => thread.id === id);
    const cache = cacheFor(id);
    cache.thread = thread;
    cache.stateReady = false;
    cache.usage = null;
    $('title').textContent = thread.title; $('project').textContent = thread.cwd;
    $('draft').value = drafts[id] || ''; $('draft').disabled = false;
    $('terminal-open').disabled = false;
    $('turns').replaceChildren();
    $('questions').replaceChildren();
    document.body.classList.add('reading');
    renderList(); renderHistory(cache, false, true); renderComposer();
    restoreReadingPosition(cache);
    refreshUsage();
    await refreshSelected();
}

function nearBottom() { const el = $('history'); return el.scrollHeight - el.scrollTop - el.clientHeight < 100; }

function renderHistory(cache, older = false, initial = false) {
    const scroller = $('history');
    const visible = conversationVisible();
    const atBottom = nearBottom();
    const anchor = [...$('turns').children].find(el => el.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
    const top = anchor?.getBoundingClientRect().top;
    let changed = false;
    let previous = null;
    const existing = new Map([...$('turns').children].map(el => [el.dataset.id, el]));
    for (const turn of cache.turns) {
        let article = existing.get(turn.id);
        if (!article) { article = node('article', undefined, 'turn'); article.dataset.id = turn.id; changed = true; }
        const itemNodes = new Map([...article.children].map(el => [el.dataset.id, el]));
        for (const group of groupItems(turn.items)) {
            let element = itemNodes.get(group.id);
            const signature = JSON.stringify(group);
            if (element?.dataset.signature === signature) continue;
            changed = true;
            const item = group.items[0];
            const isMessage = group.type === 'message';
            const fresh = node(isMessage ? 'section' : 'details', undefined, isMessage ? `message ${item.type === 'userMessage' ? 'user-message' : ''}` : 'tool');
            fresh.dataset.id = group.id; fresh.dataset.signature = signature;
            if (isMessage) {
                fresh.append(node('p', item.type === 'userMessage' ? 'あなた' : item.type === 'plan' ? '計画' : providerName(cache.thread?.provider), 'message-role'));
                const content = node('div', undefined, 'message-body');
                if (item.type === 'userMessage') content.textContent = item.text; else content.innerHTML = safeMarkdown(item.text);
                content.querySelectorAll('a').forEach(link => { link.rel = 'noreferrer noopener'; });
                fresh.append(content);
                for (const question of item.questions || []) {
                    const entry = node('section', undefined, 'history-question');
                    entry.append(node('p', '質問', 'message-role'));
                    const prose = node('div', undefined, 'message-body'); prose.innerHTML = safeMarkdown(question.title);
                    entry.append(prose);
                    if (question.options?.length) {
                        const options = node('ul');
                        options.append(...question.options.map(option => node('li', option))); entry.append(options);
                    }
                    fresh.append(entry);
                }
            } else {
                fresh.open = element ? element.open : cache.openTools.has(group.id);
                fresh.append(node('summary', `ツール実行${group.items.length}件 · ${toolState(group.items)}`));
                for (const tool of group.items) {
                    const entry = node('section', undefined, 'tool-entry');
                    entry.append(node('p', tool.label || tool.type, 'tool-label'), node('pre', tool.text));
                    fresh.append(entry);
                }
                fresh.addEventListener('toggle', () => {
                    if (fresh.open) cache.openTools.add(group.id); else cache.openTools.delete(group.id);
                });
            }
            if (element) element.replaceWith(fresh); else article.append(fresh);
        }
        const expected = previous ? previous.nextSibling : $('turns').firstChild;
        if (expected !== article) $('turns').insertBefore(article, expected);
        previous = article;
    }
    $('older').hidden = !cache.cursor;
    $('history-notice').textContent = cache.error || (!cache.loaded ? '履歴を読み込んでいます…' : !cache.turns.length ? '履歴はまだありません。' : '');
    $('history-notice').classList.toggle('error', Boolean(cache.error));
    $('history-notice').hidden = !$('history-notice').textContent;
    if (!visible) { if (changed) cache.unseen = true; return; }
    if (anchor?.isConnected && (!atBottom || older)) scroller.scrollTop += anchor.getBoundingClientRect().top - top;
    if ((atBottom && !older) || initial) scroller.scrollTop = scroller.scrollHeight;
    if (changed && !atBottom && !older && !initial) { cache.unseen = true; $('latest').hidden = false; }
    readingPosition();
}

function readingPosition() {
    $('reading-position').textContent = nearBottom() ? '最新の出力を表示中' : '過去の出力を読んでいます';
    if (nearBottom()) {
        $('latest').hidden = true;
        if (selected) cacheFor(selected).unseen = false;
    }
}

function renderUsage() {
    const cache = cacheFor(selected);
    $('usage').hidden = cache.thread?.provider !== 'codex';
    const usage = cache.closed || !cache.stateReady ? null : cache.usage;
    $('usage').textContent = `コンテキスト${usage?.contextUsedPercent == null ? '不明' : `${usage.contextUsedPercent}%使用`} · 週残り${usage?.weeklyLeftPercent == null ? '不明' : `${usage.weeklyLeftPercent}%`}`;
}

async function refreshUsage() {
    if (!selected) return;
    const id = selected, captured = generation, cache = cacheFor(id);
    if (cache.closed || cache.thread?.provider !== 'codex' || cache.usageFetching) return;
    cache.usageFetching = true;
    const request = cache.usageRequest = Symbol();
    try {
        const usage = await api(`threads/${encodeURIComponent(id)}/usage`);
        if (!currentSelection(selected, generation, id, captured) || cache.closed || cache.usageRequest !== request) return;
        cache.usage = usage;
        renderUsage();
    } catch {
        if (currentSelection(selected, generation, id, captured) && cache.usageRequest === request) { cache.usage = null; renderUsage(); }
    } finally { cache.usageFetching = false; }
}

function renderComposer() {
    if (!selected) return;
    const cache = cacheFor(selected);
    const operation = pending[selected];
    const image = images.get(selected);
    const missingImage = imageDrafts[selected] && !image;
    $('status').textContent = cache.closed ? '終了' : stateLabel(cache.thread?.status);
    renderProgress(cache);
    $('terminal-open').disabled = Boolean(cache.closed);
    const idle = cache.stateReady && cache.thread?.status.type === 'idle' && !cache.queue.length;
    const active = cache.stateReady && cache.thread?.status.type === 'active' && !cache.thread.status.activeFlags?.length;
    $('send').disabled = (!idle && !active) || Boolean(operation) || Boolean(missingImage) || (!$('draft').value.trim() && !image);
    $('image-select').disabled = Boolean(operation) || Boolean(cache.closed);
    $('image-file').disabled = $('image-select').disabled;
    $('image-remove').disabled = Boolean(operation);
    $('image-preview').hidden = !image && !missingImage;
    $('image-thumbnail').hidden = !image;
    if (image && $('image-thumbnail').getAttribute('src') !== image.url) $('image-thumbnail').src = image.url;
    if (!image) $('image-thumbnail').removeAttribute('src');
    $('image-name').textContent = image ? image.file.name : missingImage ? '画像を選び直してください。ページの再読込みで画像の選択が解除されました。' : '';
    $('send-state').textContent = operation ? (operation.state === 'unknown' ? '送信結果が不明です。PCで確認するまで再送できません。'
        : operation.phase === 'uploading' ? '画像をアップロードしています…' : '送信結果を確認しています…')
        : cache.closed ? 'PCの会話は終了しました。下書きと履歴は保持されます。'
        : cache.sendError || (!cache.stateReady ? '接続と会話の状態を確認しています。下書きは保持されます。'
        : active ? `処理中の${providerName(cache.thread?.provider)}へ追加の指示を送ります。`
        : cache.queue.length ? '待機中の指示があります。処理が終わると送信できます。'
        : idle ? '待機中のPCの会話へ送信します。' : `${stateLabel(cache.thread?.status)}です。端末で状態を確認できます。`);
    $('resolve').hidden = operation?.state !== 'unknown';
    $('composer-terminal').hidden = cache.closed || !cache.thread?.status.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput', 'waitingOnApprovalOrInput'].includes(flag));
    $('queue').replaceChildren(...cache.queue.map(item => node('p', `待機中の指示\n${item.text}`)));
    renderQuestions();
    renderUsage();
}

function latestUserTurn(cache) {
    return cache.turns.findLast(turn => turn.items.some(item => item.type === 'userMessage'));
}

function renderProgress(cache) {
    const visible = !cache.closed && cache.stateReady && cache.historyReady && cache.thread?.status.type === 'active';
    $('progress-line').hidden = !visible;
    if (!visible) return;
    const turn = cache.thread.provider === 'claude'
        ? (!cache.claudeAwaitingTurn ? latestUserTurn(cache) : null)
        : cache.turns.find(turn => turn.id === cache.activeTurnId && turn.status === 'inProgress');
    const tool = turn?.items.findLast(item => !['userMessage', 'agentMessage', 'plan'].includes(item.type) && ['inProgress', 'running'].includes(item.status));
    const waiting = cache.thread.status.activeFlags?.some(flag => ['waitingOnApproval', 'waitingOnUserInput', 'waitingOnApprovalOrInput'].includes(flag));
    $('stage').hidden = Boolean(waiting);
    $('stage').textContent = waiting ? '' : tool ? 'ツール実行中' : '作業中';
    const startedAt = turn?.startedAt;
    const elapsed = Date.now() - startedAt * 1000;
    const confirmed = turn?.items.some(item => item.type === 'userMessage') && typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 && Number.isFinite(elapsed) && elapsed >= 0;
    $('elapsed').hidden = !confirmed;
    $('elapsed').textContent = confirmed ? `指示から${Math.floor(elapsed / 60000)}分経過` : '';
}

function questionKey(id, question) { return JSON.stringify([id, question.turnId, question.itemId, question.index]); }

function renderQuestions() {
    const cache = cacheFor(selected), container = $('questions');
    const questions = new Map((cache.closed ? [] : cache.questions || []).map(question => [questionKey(selected, question), question]));
    for (const [key, operation] of Object.entries(questionPending)) {
        if (operation.threadId !== selected) continue;
        if (operation.state === 'succeeded' && (cache.closed || cache.stateReady && cache.questionsReady && cache.activeTurnId !== operation.question.turnId)) {
            delete questionPending[key]; save(); continue;
        }
        if (!questions.has(key)) questions.set(key, operation.question);
    }
    const existing = new Map([...container.children].map(element => [element.dataset.key, element]));
    for (const [key, question] of questions) {
        let form = existing.get(key);
        if (!form) {
            form = node('form', undefined, 'question'); form.dataset.key = key;
            const title = node('div', undefined, 'question-title message-body'); title.innerHTML = safeMarkdown(question.title);
            title.querySelectorAll('a').forEach(link => { link.rel = 'noreferrer noopener'; });
            const options = node('div', undefined, 'question-options');
            const input = node('textarea'); input.rows = 2; input.maxLength = 32000;
            input.id = `question-answer-${requestId()}`; input.setAttribute('aria-label', '質問への回答');
            input.value = questionDrafts[key] || '';
            for (const option of question.options || []) {
                const button = node('button', option, 'question-option'); button.type = 'button';
                button.addEventListener('click', () => { input.value = option; input.dispatchEvent(new Event('input')); });
                options.append(button);
            }
            input.addEventListener('input', () => { questionDrafts[key] = input.value; save(); renderQuestions(); });
            const label = node('label', '回答（自由に入力できます）'); label.htmlFor = input.id;
            const status = node('p', undefined, 'question-state notice'); status.setAttribute('role', 'status');
            const submit = node('button', '回答を送信', 'question-submit'); submit.type = 'submit';
            const recovery = node('button', 'PCで回答結果を確認して解除', 'question-recover'); recovery.type = 'button';
            recovery.addEventListener('click', () => recoverQuestion(key));
            form.addEventListener('submit', event => { event.preventDefault(); if (!submit.disabled) sendQuestion(key, question); });
            form.append(title, options, label, input, status, submit, recovery); container.append(form);
        }
        const operation = questionPending[key];
        const active = cache.questions?.some(current => questionKey(selected, current) === key);
        const ready = cache.stateReady && cache.questionsReady && cache.answerable && cache.historyReady && !cache.closed && active;
        const reserved = Boolean(operation || question.operation);
        form.querySelector('textarea').disabled = !ready || reserved;
        form.querySelectorAll('.question-option').forEach(button => {
            button.disabled = !ready || reserved;
            button.setAttribute('aria-pressed', String(Boolean(form.querySelector('textarea').value) && button.textContent === form.querySelector('textarea').value));
        });
        form.querySelector('.question-submit').disabled = !ready || reserved || !form.querySelector('textarea').value.trim();
        form.querySelector('.question-recover').hidden = operation?.state !== 'unknown';
        form.querySelector('.question-state').textContent = operation?.error || (operation?.state === 'unknown'
            ? '回答の送信結果が不明です。PCで確認してから解除してください。'
            : reserved ? '回答の反映を確認しています…'
            : !ready ? '最新の会話と履歴を確認できるまで回答を停止しています。下書きは保持されます。'
            : cache.questionErrors?.[key] || '選択肢を押すと回答欄に入ります。送信前に編集できます。');
    }
    for (const [key, element] of existing) if (!questions.has(key)) element.remove();
    container.hidden = !questions.size;
}

function settleQuestion(key, result) {
    const operation = questionPending[key];
    if (!operation || operation.requestId !== result.requestId) return;
    if (result.state === 'succeeded' && (result.value?.confirmed || result.value?.turnEnded || cacheFor(operation.threadId).closed)) {
        if (result.value?.confirmed && questionDrafts[key] === operation.text) delete questionDrafts[key];
        delete questionPending[key];
    } else if (result.state === 'failed') {
        const cache = cacheFor(operation.threadId); cache.questionErrors ??= {}; cache.questionErrors[key] = result.message;
        delete questionPending[key];
    } else { operation.state = result.state; operation.error = ''; }
    save(); if (operation.threadId === selected) renderQuestions();
}

async function sendQuestion(key, question) {
    const id = selected, cache = cacheFor(id);
    if (questionPending[key] || !cache.stateReady || !cache.historyReady) return;
    const operation = { requestId: requestId(), threadId: id, question, text: questionDrafts[key], state: 'processing' };
    questionPending[key] = operation; if (cache.questionErrors) delete cache.questionErrors[key]; save(); renderQuestions();
    try {
        settleQuestion(key, await api(`threads/${encodeURIComponent(id)}/answer`, { requestId: operation.requestId,
            turnId: question.turnId, itemId: question.itemId, index: question.index, answer: operation.text }));
    } catch (error) {
        settleQuestion(key, { requestId: operation.requestId, state: error.status ? 'failed' : 'unknown', message: error.message });
    }
    if (selected === id) await refreshSelected();
}

async function recoverQuestion(key) {
    const operation = questionPending[key];
    if (operation?.state !== 'unknown' || !window.confirm('PCで回答の送信結果を確認しましたか？解除後は新しい操作として回答を送信できます。')) return;
    try {
        await api(`threads/${encodeURIComponent(operation.threadId)}/answer-recover`, { requestId: operation.requestId,
            turnId: operation.question.turnId, itemId: operation.question.itemId, index: operation.question.index, confirmed: true });
        if (questionPending[key]?.requestId !== operation.requestId) return;
        delete questionPending[key]; save();
        if (operation.threadId === selected) { renderQuestions(); await refreshSelected(); }
    } catch (error) {
        if (questionPending[key]?.requestId !== operation.requestId) return;
        operation.error = error.message; renderQuestions();
    }
}

async function refreshSelected() {
    if (!selected || cacheFor(selected).closed) return;
    const id = selected, captured = generation, cache = cacheFor(id);
    if (cache.fetching) return;
    cache.fetching = true;
    try {
        const until = cache.turns.at(-1)?.id;
        const [state, history] = await Promise.allSettled([
            api(`threads/${encodeURIComponent(id)}/state`),
            api(`threads/${encodeURIComponent(id)}/history${until ? `?until=${encodeURIComponent(until)}` : ''}`),
        ]);
        if (!currentSelection(selected, generation, id, captured)) return;
        cache.stateReady = state.status === 'fulfilled';
        if (!cache.stateReady) { cache.usageRequest = null; cache.usage = null; }
        cache.historyReady = history.status === 'fulfilled';
        if (cache.stateReady) {
            cache.thread = state.value.thread; cache.queue = state.value.queue;
            cache.questionsReady = state.value.questionsReady !== false;
            cache.answerable = Boolean(state.value.answerable);
            cache.activeTurnId = state.value.activeTurnId;
            if (cache.questionsReady) cache.questions = state.value.questions || [];
            for (const question of cache.questions) {
                const key = questionKey(id, question);
                if (question.operation && !questionPending[key]) questionPending[key] = { requestId: question.operation, threadId: id, question, state: 'processing' };
            }
        }
        if (history.status === 'fulfilled') {
            const hadTurns = cache.turns.length > 0;
            cache.turns = mergeTurns(cache.turns, history.value.turns);
            if (!cache.loaded || !hadTurns) cache.cursor = history.value.nextCursor;
            cache.loaded = true;
        }
        if (cache.stateReady && cache.thread.provider === 'claude') {
            const status = cache.thread.status.type;
            const latest = latestUserTurn(cache)?.id ?? null;
            if (status === 'idle' && (cache.stageStatus !== 'idle' || !cache.claudeIdleBaselineReady)) {
                cache.claudeIdleBaselineReady = cache.historyReady;
                if (cache.historyReady) cache.claudeIdleUserTurn = latest;
            }
            if (status === 'active') {
                if (!cache.claudeIdleBaselineReady && (cache.stageStatus === 'idle' || cache.claudeAwaitingTurn)) {
                    cache.claudeAwaitingTurn = true;
                    if (cache.historyReady) {
                        cache.claudeIdleUserTurn = latest;
                        cache.claudeIdleBaselineReady = true;
                    }
                } else {
                    cache.claudeAwaitingTurn = Boolean(cache.claudeIdleBaselineReady) && (!latest || latest === cache.claudeIdleUserTurn);
                }
            }
            if (['idle', 'active'].includes(status)) cache.stageStatus = status;
        }
        cache.error = state.status === 'rejected' ? state.reason.message : history.status === 'rejected' ? history.reason.message : null;
        renderHistory(cache); renderComposer();
    } catch (error) {
        if (!currentSelection(selected, generation, id, captured)) return;
        cache.usageRequest = null; cache.usage = null;
        cache.stateReady = false; cache.error = error.message; renderHistory(cache); renderComposer();
    } finally { cache.fetching = false; }
}

async function olderHistory() {
    if (!selected) return;
    const id = selected, captured = generation, cache = cacheFor(id);
    if (!cache.cursor || cache.fetching) return;
    cache.fetching = true; $('older').disabled = true;
    try {
        const page = await api(`threads/${encodeURIComponent(id)}/history?cursor=${encodeURIComponent(cache.cursor)}`);
        if (!currentSelection(selected, generation, id, captured)) return;
        cache.turns = mergeTurns(cache.turns, page.turns, true); cache.cursor = page.nextCursor; cache.error = null;
        renderHistory(cache, true);
    } catch (error) {
        if (currentSelection(selected, generation, id, captured)) { cache.error = error.message; renderHistory(cache, true); }
    } finally { cache.fetching = false; $('older').disabled = false; }
}

function settleOperation(id, result) {
    const operation = pending[id];
    if (!operation || operation.requestId !== result.requestId) return;
    if (id === 'terminal') {
        if (['succeeded', 'failed'].includes(result.state)) delete pending.terminal;
        else operation.state = result.state;
        showTerminalResult(operation, result);
        if (result.state === 'succeeded' && terminalResultRequestId === result.requestId && $('terminal-text').value === operation.text) $('terminal-text').value = '';
        save(); terminalControls();
        if (['succeeded', 'failed'].includes(result.state) && terminalBinding?.bindingId === operation.bindingId && !terminalBusy) refreshTerminal();
        return;
    }
    if (result.state === 'succeeded') {
        if (drafts[id] === pending[id].text) drafts[id] = '';
        if (operation.imageSelection && images.get(id)?.selectionId === operation.imageSelection) clearImage(id);
        else if (operation.imageSelection && !images.has(id)) delete imageDrafts[id];
        delete pending[id];
        if (id === selected) $('draft').value = drafts[id] || '';
    } else if (result.state === 'failed') {
        const message = result.message; delete pending[id];
        if (id !== 'terminal') cacheFor(id).sendError = message;
        if (id === selected) renderComposer();
    } else pending[id].state = result.state;
    save();
    if (id === selected && result.state !== 'failed') renderComposer();
}

async function sendMessage() {
    if ($('send').disabled || !selected) return;
    const id = selected;
    const image = images.get(id);
    const operation = { requestId: requestId(), text: $('draft').value, state: 'processing', phase: image ? 'uploading' : 'sending', ...(image ? { imageSelection: image.selectionId } : {}) };
    cacheFor(id).sendError = null;
    drafts[id] = operation.text; pending[id] = operation; save(); renderComposer();
    if (image) {
        try {
            const uploaded = await api(`threads/${encodeURIComponent(id)}/images`, image.file);
            operation.imageId = uploaded.imageId;
            operation.phase = 'sending';
            save();
            if (id === selected) renderComposer();
        } catch (error) {
            settleOperation(id, { requestId: operation.requestId, state: 'failed', message: error.message });
            return;
        }
    }
    try { settleOperation(id, await api(`threads/${encodeURIComponent(id)}/send`, operation)); }
    catch (error) { settleOperation(id, { requestId: operation.requestId, state: error.status ? 'failed' : 'unknown', message: error.message }); }
    if (selected === id) await refreshSelected();
}

async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try {
        try {
            const result = await api('threads');
            threads = result.threads;
            threads.forEach(thread => { if (!ranks.has(thread.id)) ranks.set(thread.id, ranks.size); });
            listReady = true; $('connection').textContent = `${threads.length}件の会話 · 接続済み${result.unresolvedCount ? ` · 対応未確認${result.unresolvedCount}件` : ''}`; $('connection').classList.remove('error'); renderList();
            await openNotificationThread();
            if (notificationThreadMissing) $('connection').textContent += ' · 通知の会話は終了しているか、PCで開かれていません。';
            for (const operation of Object.values(questionPending)) cacheFor(operation.threadId).closed = !threads.some(thread => thread.id === operation.threadId);
        } finally { await refreshLaunch(); }
        if (selected) {
            const cache = cacheFor(selected);
            cache.closed = !threads.some(thread => thread.id === selected);
            if (cache.closed) {
                generation++;
                cache.usage = null;
                cache.stateReady = false;
                if (terminalOwner?.resource === 'threads') closeTerminal();
                renderComposer();
            }
        }
        for (const [id, operation] of Object.entries(pending)) {
            if (operation.phase === 'uploading') continue;
            try { settleOperation(id, await api(`operations/${operation.requestId}`)); }
            catch { settleOperation(id, { requestId: operation.requestId, state: 'unknown' }); }
        }
        for (const [key, operation] of Object.entries(questionPending)) {
            try { settleQuestion(key, await api(`operations/${operation.requestId}`)); }
            catch { settleQuestion(key, { requestId: operation.requestId, state: 'unknown' }); }
        }
        terminalControls();
        refreshUsage();
        await refreshSelected();
    } catch (error) {
        $('connection').textContent = `接続を確認してください。${error.message}`; $('connection').classList.add('error');
        if (selected) { cacheFor(selected).usageRequest = null; cacheFor(selected).usage = null; cacheFor(selected).stateReady = false; renderComposer(); }
    } finally { polling = false; }
}

function terminalControls() {
    const bound = terminalBinding && $('terminal-dialog').open && terminalBinding.paneId === $('pane-select').value;
    const ready = bound && terminalView && !terminalBusy && !pending.terminal;
    $('terminal-send').disabled = !ready;
    $('terminal-refresh').disabled = !bound || terminalBusy;
    $('keys').querySelectorAll('button').forEach(button => { button.disabled = !ready; });
    $('terminal-resolve').hidden = pending.terminal?.state !== 'unknown';
}

function currentTerminal(request, paneId) {
    return request === terminalRequest && $('terminal-dialog').open && (paneId === undefined || $('pane-select').value === paneId);
}

function releaseBinding(binding) {
    api(`${terminalPath(binding)}/unbind`, { bindingId: binding.bindingId }, true).catch(() => {});
}

function terminalPath(owner = terminalOwner) { return `${owner.resource}/${encodeURIComponent(owner.id)}`; }

function invalidateTerminal() {
    terminalRequest++;
    const binding = terminalBinding;
    terminalBinding = null; terminalView = null; terminalBusy = false;
    if (binding) releaseBinding(binding);
    $('terminal-screen').textContent = ''; terminalControls();
    return terminalRequest;
}

function showTerminalResult(operation, result) {
    if (terminalResultRequestId !== result.requestId) return;
    $('terminal-result').hidden = false;
    const message = result.state === 'succeeded' ? '端末へ送信しました。'
        : result.state === 'failed' ? `端末への送信に失敗しました。${result.message || ''}`
        : result.state === 'unknown' ? '送信結果が不明です。PCで確認するまで再送できません。'
        : '端末への送信結果を確認しています…';
    $('terminal-result').textContent = `${operation.paneId || '端末'} · ${message}`;
}

async function openTerminal(owner) {
    if ($('launch-dialog').open) $('launch-dialog').close();
    terminalOwner = owner?.resource ? owner : { resource: 'threads', id: selected };
    const target = terminalOwner, id = target.id, request = invalidateTerminal();
    terminalResultRequestId = pending.terminal?.requestId || null;
    if (pending.terminal) showTerminalResult(pending.terminal, pending.terminal);
    else $('terminal-result').textContent = '';
    $('terminal-result').hidden = !pending.terminal;
    $('pane-select').replaceChildren();
    if (target.resource === 'threads') {
        const placeholder = node('option', '端末を選んでください'); placeholder.value = '';
        $('pane-select').append(placeholder);
    }
    if (!$('terminal-dialog').open) $('terminal-dialog').showModal();
    $('terminal-state').textContent = '端末を取得しています…';
    try {
        const { panes } = target.resource === 'launches' ? { panes: launchState?.pane ? [launchState.pane] : [] }
            : await api(`threads/${encodeURIComponent(id)}/panes`);
        if (!currentTerminal(request)) return;
        for (const pane of panes) {
            const option = node('option', `${pane.id} · ${pane.title} · ${pane.cwd} · ${pane.workspace}${pane.session === id ? ' · この会話' : ''}`);
            option.value = pane.id; $('pane-select').append(option);
        }
        const matched = panes.filter(pane => target.resource === 'launches' || pane.session === id);
        if (matched.length === 1) $('pane-select').value = matched[0].id;
        $('terminal-state').textContent = '端末を選び、表示と対象名を確認してください。';
    } catch (error) { if (currentTerminal(request)) $('terminal-state').textContent = error.message; }
}

function closeTerminal({ returnToLaunch = true } = {}) {
    const returnLaunch = returnToLaunch && terminalOwner?.resource === 'launches' && launchId;
    invalidateTerminal();
    terminalOwner = null;
    terminalResultRequestId = null;
    if ($('terminal-dialog').open) $('terminal-dialog').close();
    $('terminal-text').value = ''; terminalControls();
    if (returnLaunch && !$('launch-dialog').open) { renderLaunch(); $('launch-dialog').showModal(); }
}

async function bindTerminal() {
    const owner = terminalOwner, paneId = $('pane-select').value;
    if (!paneId || !$('terminal-dialog').open) return;
    const request = invalidateTerminal();
    terminalBusy = true; terminalControls();
    $('terminal-state').textContent = '端末を関連付けています…';
    try {
        const binding = await api(`${terminalPath(owner)}/bind`, { paneId });
        if (!currentTerminal(request, paneId) || binding.paneId !== paneId) {
            releaseBinding({ ...binding, ...owner }); return;
        }
        terminalBinding = { ...binding, ...owner };
        terminalBusy = false;
        await refreshTerminal();
    } catch (error) { if (currentTerminal(request, paneId)) $('terminal-state').textContent = error.message; }
    finally { if (request === terminalRequest) { terminalBusy = false; terminalControls(); } }
}

async function refreshTerminal() {
    const binding = terminalBinding, request = terminalRequest;
    if (!binding || !currentTerminal(request, binding.paneId) || terminalBusy) return;
    const screen = $('terminal-screen');
    const atBottom = !binding.hasScreen || screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
    const scroll = screen.scrollTop;
    terminalBusy = true; terminalView = null; terminalControls();
    try {
        const view = await api(`${terminalPath(binding)}/terminal?bindingId=${encodeURIComponent(binding.bindingId)}`);
        if (!currentTerminal(request, binding.paneId) || terminalBinding !== binding) return;
        terminalView = view; binding.hasScreen = true; screen.textContent = view.text;
        screen.scrollTop = atBottom ? screen.scrollHeight : scroll;
        $('terminal-state').textContent = `${view.paneId} · ${binding.resource === 'launches' ? '起動したCodexで確認済み。' : '会話IDで関連付け済み。'}`;
    } catch (error) {
        if (currentTerminal(request, binding.paneId) && terminalBinding === binding) $('terminal-state').textContent = `端末表示を更新できません。「この端末を表示」で選び直してください。${error.message}`;
    }
    finally { if (request === terminalRequest && terminalBinding === binding) { terminalBusy = false; terminalControls(); } }
}

async function terminalInput(key) {
    const binding = terminalBinding, view = terminalView;
    if (!binding || !view || !currentTerminal(terminalRequest, binding.paneId) || terminalBusy || pending.terminal) return;
    if (key === 'Ctrl-C' && !window.confirm(`${binding.paneId}へCtrl-Cを送信して処理を中断しますか？`)) return;
    const body = { requestId: requestId(), bindingId: binding.bindingId, viewId: view.viewId,
        ...(key ? { key, confirmInterrupt: key === 'Ctrl-C' } : { text: $('terminal-text').value }) };
    const request = ++terminalRequest;
    const operation = { requestId: body.requestId, state: 'processing', bindingId: binding.bindingId, paneId: binding.paneId, text: body.text };
    terminalResultRequestId = operation.requestId;
    terminalBusy = true; pending.terminal = operation; save(); terminalControls();
    showTerminalResult(operation, operation);
    try {
        settleOperation('terminal', await api(`${terminalPath(binding)}/terminal-input`, body));
    } catch { settleOperation('terminal', { requestId: operation.requestId, state: 'unknown' }); }
    finally {
        if (request === terminalRequest && terminalBinding === binding) {
            terminalBusy = false; terminalView = null; terminalControls();
            if (!pending.terminal) await refreshTerminal();
        }
    }
}

$('search').addEventListener('input', renderList);
$('launch-open').addEventListener('click', openLaunch);
$('launch-form').addEventListener('submit', startLaunch);
$('launch-close').addEventListener('click', () => $('launch-dialog').close());
$('launch-dialog').addEventListener('cancel', event => { event.preventDefault(); $('launch-dialog').close(); });
$('launch-resolve').addEventListener('click', confirmLaunch);
$('launch-terminal').addEventListener('click', () => {
    if (!launchId || !launchState?.terminalAvailable) return;
    $('launch-dialog').close();
    openTerminal({ resource: 'launches', id: launchId });
});
$('draft').addEventListener('input', () => { if (selected) drafts[selected] = $('draft').value; save(); renderComposer(); });
function clearImage(id) {
    const image = images.get(id);
    if (image) URL.revokeObjectURL(image.url);
    images.delete(id);
    delete imageDrafts[id];
}
$('image-select').addEventListener('click', () => $('image-file').click());
$('image-file').addEventListener('change', () => {
    const file = $('image-file').files[0];
    $('image-file').value = '';
    if (!selected || pending[selected] || !file) return;
    const cache = cacheFor(selected);
    clearImage(selected);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) cache.sendError = 'PNG、JPEG、WebP、GIFの画像を選んでください。';
    else if (!file.size || file.size > 10 * 1024 * 1024) cache.sendError = '画像は10MiB以下のファイルを選んでください。';
    else {
        images.set(selected, { file, url: URL.createObjectURL(file), selectionId: requestId() });
        imageDrafts[selected] = true;
        cache.sendError = null;
    }
    save(); renderComposer();
});
$('image-remove').addEventListener('click', () => {
    if (!selected || pending[selected]) return;
    clearImage(selected); cacheFor(selected).sendError = null; save(); renderComposer();
});
$('send').addEventListener('click', sendMessage);
$('older').addEventListener('click', olderHistory);
$('history').addEventListener('scroll', readingPosition);
$('latest').addEventListener('click', () => { $('history').scrollTop = $('history').scrollHeight; readingPosition(); });
$('back').addEventListener('click', () => { rememberConversation(); closeTerminal(); document.body.classList.remove('reading'); });
$('resolve').addEventListener('click', () => {
    if (window.confirm('PCで送信結果を確認しましたか？下書きを解除すると、新しい操作として送信できるようになります。')) {
        delete pending[selected]; save(); renderComposer();
    }
});
$('terminal-open').addEventListener('click', openTerminal);
$('composer-terminal').addEventListener('click', openTerminal);
$('terminal-close').addEventListener('click', closeTerminal);
$('terminal-dialog').addEventListener('cancel', event => { event.preventDefault(); closeTerminal(); });
$('bind').addEventListener('click', bindTerminal);
$('pane-select').addEventListener('change', () => {
    invalidateTerminal();
    $('terminal-state').textContent = '選択した端末を「この端末を表示」で確認してください。';
});
$('terminal-refresh').addEventListener('click', refreshTerminal);
$('terminal-send').addEventListener('click', () => terminalInput());
$('terminal-resolve').addEventListener('click', () => {
    if (window.confirm('PCで端末操作の結果を確認しましたか？解除後は端末表示を更新し、新しい操作として送信できます。')) {
        delete pending.terminal; save(); terminalControls();
        terminalResultRequestId = null;
        $('terminal-result').textContent = 'PCで端末操作の結果を確認しました。';
    }
});
for (const [key, label] of [['Enter', 'Enter'], ['Escape', 'Esc'], ['Tab', 'Tab'], ['Up', '↑'], ['Down', '↓'], ['Left', '←'], ['Right', '→'], ['Backspace', '⌫'], ['Ctrl-C', 'Ctrl-C']]) {
    const button = node('button', label); button.disabled = true;
    button.setAttribute('aria-label', key);
    button.addEventListener('click', () => terminalInput(key)); $('keys').append(button);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
$('notification-toggle').addEventListener('click', toggleNotifications);
$('notification-test').addEventListener('click', testNotification);
navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type !== 'notification-thread' || typeof event.data.thread !== 'string' || event.data.thread.length > 200) return;
    notificationThread = event.data.thread;
    history.replaceState(null, '', `/?thread=${encodeURIComponent(notificationThread)}`);
    if (!document.hidden) poll();
});
checkNotifications();
window.addEventListener('pagehide', () => closeTerminal({ returnToLaunch: false }));
renderLaunch();
poll(); setInterval(poll, 2000);
