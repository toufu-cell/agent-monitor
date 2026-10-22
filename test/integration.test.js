import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, copyFile, appendFile, truncate, stat, rm, writeFile, mkdtemp, symlink, readFile, readdir, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { fixture, codexScreen, claudeScreen } from './fakes.js';
import { mergeTurns } from '../web/model.js';
import { createMonitorServer } from '../src/server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVQImWM4ZmdxzM6CAUIBACTWBPHkwkg6AAAAAElFTkSuQmCC', 'base64');
const JPEG = await sharp(Buffer.from(Array.from({ length: 32 * 32 * 3 }, (_, i) => (i * 31 + (i >> 3) * 7) % 256)), { raw: { width: 32, height: 32, channels: 3 } }).jpeg().toBuffer();
const WEBP = await sharp(PNG).webp().toBuffer();
const GIF = await sharp(PNG).gif().toBuffer();
const IMAGE_FORMATS = [[PNG, 'image/png', 'png'], [JPEG, 'image/jpeg', 'jpg'], [WEBP, 'image/webp', 'webp'], [GIF, 'image/gif', 'gif']];
const ANIMATIONS = await Promise.all(['gif', 'webp'].map(format => sharp(Buffer.from([198, 62, 56, 0, 128, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })[format]().toBuffer()));
const IMAGE_LIFETIME = 30 * 24 * 60 * 60 * 1000;

async function imageFixture(t) {
    const f = await fixture(); t.after(() => f.close());
    const directory = await mkdtemp(join(tmpdir(), 'am-images-'));
    f.service.imageDir = join(directory, 'private "images"');
    t.after(() => rm(directory, { recursive: true, force: true }));
    await f.request('/api/threads');
    f.upload = async (id = 'a', bytes = PNG, type = 'image/png', headers = {}) => {
        const response = await fetch(`${f.origin}/api/threads/${encodeURIComponent(id)}/images`, {
            method: 'POST', headers: { Authorization: `Bearer ${f.token}`, Origin: f.origin, 'Content-Type': type, ...headers }, body: bytes,
        });
        return { status: response.status, body: await response.json() };
    };
    return f;
}

test('image upload validates HTTP identity, formats and bounded bodies before private storage', async t => {
    const f = await imageFixture(t);
    for (const [headers, status] of [
        [{ Authorization: '' }, 401], [{ Origin: '' }, 403], [{ Origin: 'https://evil.example' }, 403],
    ]) assert.equal((await f.upload('a', PNG, 'image/png', headers)).status, status);
    const badHost = await new Promise((resolve, reject) => {
        const request = http.request(`${f.origin}/api/threads/a/images`, { method: 'POST', headers: { Host: 'evil.example', Origin: f.origin, Authorization: `Bearer ${f.token}`, 'Content-Type': 'image/png' } }, response => {
            response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject); request.end(PNG);
    });
    assert.equal(badHost, 403);
    assert.equal((await f.upload('unknown')).status, 404);
    for (const [bytes, type] of [[PNG, 'image/jpeg'], [Buffer.from('<svg/>'), 'image/svg+xml'], [Buffer.from('bad'), 'image/png']]) {
        assert.equal((await f.upload('a', bytes, type)).status, 415);
    }
    assert.equal((await f.upload('a', Buffer.alloc(0))).status, 413);
    assert.equal((await f.upload('a', Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
    const streamed = await fetch(`${f.origin}/api/threads/a/images`, {
        method: 'POST', headers: { Authorization: `Bearer ${f.token}`, Origin: f.origin, 'Content-Type': 'image/png' },
        body: (async function* () { yield PNG; yield Buffer.alloc(10 * 1024 * 1024); })(), duplex: 'half',
    });
    assert.equal(streamed.status, 413); await streamed.json();
    for (const [bytes, type, extension] of IMAGE_FORMATS) {
        const result = await f.upload('a', bytes, type, { 'X-Filename': '../../original.png' });
        assert.equal(result.status, 200);
        assert.match(result.body.imageId, /^[a-f0-9-]{36}$/);
        const path = f.service.images.get(result.body.imageId).path;
        assert.equal(path.endsWith(`/${result.body.imageId}.${extension}`), true);
        assert.deepEqual(await readFile(path), bytes);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    const padding = Buffer.alloc(10 * 1024 * 1024 - PNG.length);
    padding.writeUInt32BE(padding.length - 12); padding.write('paDd', 4);
    padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
    const large = Buffer.concat([PNG.subarray(0, -12), padding, PNG.subarray(-12)]);
    assert.equal((await f.upload('a', large)).status, 200);
    assert.equal((await stat(f.service.imageDir)).mode & 0o777, 0o700);
    assert.equal((await readdir(f.service.imageDir)).length, 5);
    const page = await fetch(f.origin);
    assert.match(page.headers.get('content-security-policy'), /img-src 'self' blob:/);
});

test('image upload rejects incomplete and corrupt image data before storage or delivery', async t => {
    const f = await imageFixture(t);
    const corruptPNG = Buffer.from(PNG); corruptPNG[corruptPNG.indexOf('IDAT') + 4] ^= 255;
    const scan = JPEG.indexOf(Buffer.from([255, 218]));
    const corruptJPEG = Buffer.concat([JPEG.subarray(0, scan + 2 + JPEG.readUInt16BE(scan + 2) + 10), JPEG.subarray(-2)]);
    const corruptWEBP = Buffer.from(WEBP); corruptWEBP.fill(255, 25);
    const corruptGIF = Buffer.from(GIF); corruptGIF[corruptGIF.indexOf(44) + 10] = 13;
    const cases = [
        ['png', PNG, 8, 12, corruptPNG], ['jpeg', JPEG, 4, 2, corruptJPEG],
        ['webp', WEBP, 12, 1, corruptWEBP], ['gif', GIF, 6, 1, corruptGIF],
    ].flatMap(([format, bytes, header, ending, corrupt]) => [
        [`${format} header`, bytes.subarray(0, header), `image/${format}`],
        [`${format} missing ending`, bytes.subarray(0, -ending), `image/${format}`],
        [`${format} incomplete pixels`, bytes.subarray(0, Math.floor(bytes.length * 0.75)), `image/${format}`],
        [`${format} corrupt pixels`, corrupt, `image/${format}`],
    ]);
    const [gif, webp] = ANIMATIONS.map(bytes => Buffer.from(bytes));
    const lastGIFFrame = gif.lastIndexOf(44); gif[lastGIFFrame + 10 + 6] = 13;
    webp.fill(255, webp.lastIndexOf('VP8 ') + 12);
    cases.push(['gif corrupt second frame', gif, 'image/gif'], ['webp corrupt second frame', webp, 'image/webp']);
    const textData = Buffer.concat([Buffer.from('note\0before'), PNG.subarray(-12), Buffer.from('after')]);
    const textChunk = Buffer.alloc(textData.length + 12);
    textChunk.writeUInt32BE(textData.length); textChunk.write('tEXt', 4); textData.copy(textChunk, 8);
    textChunk.writeUInt32BE(crc32(textChunk.subarray(4, -4)), textChunk.length - 4);
    const pngWithText = Buffer.concat([PNG.subarray(0, -12), textChunk, PNG.subarray(-12)]);
    const comment = Buffer.from('before;after');
    const gifWithComment = Buffer.concat([GIF.subarray(0, -1), Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0, 0x3b])]);
    cases.push(
        ['png truncated at embedded IEND', pngWithText.subarray(0, pngWithText.indexOf(PNG.subarray(-12)) + 12), 'image/png'],
        ['gif truncated at embedded trailer', gifWithComment.subarray(0, gifWithComment.indexOf(0x3b, GIF.length - 1) + 1), 'image/gif'],
    );
    for (const [name, bytes, type] of cases) await t.test(name, async () => {
        const result = await f.upload('a', bytes, type);
        assert.equal(result.status, 415);
        assert.equal(result.body.imageId, undefined);
        assert.equal(f.service.images.size, 0);
        assert.deepEqual(await readdir(f.service.imageDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
    });
});

test('image validation reads every animation frame and bounds total decoded pixels', async t => {
    const f = await imageFixture(t);
    for (const [index, format] of ['gif', 'webp'].entries()) {
        const result = await f.upload('a', ANIMATIONS[index], `image/${format}`);
        assert.equal(result.status, 200);
        assert.deepEqual(await readFile(f.service.images.get(result.body.imageId).path), ANIMATIONS[index]);
    }
    const photo = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#c63e38' } }).png().toBuffer();
    assert.equal((await f.upload('a', photo)).status, 200);
    const frame = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#c63e38' } }).gif().toBuffer();
    const descriptor = frame.indexOf(44);
    const animation = Buffer.concat([frame.subarray(0, descriptor), ...Array(65).fill(frame.subarray(descriptor, -1)), frame.subarray(-1)]);
    const metadata = await sharp(animation, { animated: true }).metadata();
    assert.equal(metadata.pages, 65);
    assert.equal(metadata.width * metadata.height, 65000000);
    assert.equal((await f.upload('a', animation, 'image/gif')).status, 415);
    const webpFrames = await sharp(ANIMATIONS[1], { animated: true }).resize(1000, 1000).webp().toBuffer();
    const firstFrame = webpFrames.indexOf('ANMF');
    const webpAnimation = Buffer.concat([webpFrames.subarray(0, firstFrame), ...Array(33).fill(webpFrames.subarray(firstFrame))]);
    webpAnimation.writeUInt32LE(webpAnimation.length - 8, 4);
    const webpMetadata = await sharp(webpAnimation, { animated: true }).metadata();
    assert.equal(webpMetadata.pages, 66);
    assert.equal(webpMetadata.width * webpMetadata.height, 66000000);
    assert.equal((await f.upload('a', webpAnimation, 'image/webp')).status, 415);
    assert.equal((await readdir(f.service.imageDir)).length, 3);
    assert.equal(f.service.images.size, 3);
});

test('images belong to a conversation and reach Codex queue or quoted CLI input without history data', async t => {
    const f = await imageFixture(t);
    const uploaded = (await f.upload()).body;
    const image = f.service.images.get(uploaded.imageId);
    const body = { requestId: 'image_queue_1234567890', text: '', imageId: uploaded.imageId };
    assert.equal((await f.request('/api/threads/b/send', { ...body, requestId: 'image_other_1234567890' })).body.state, 'failed');
    assert.equal((await f.request('/api/threads/a/send', body)).body.state, 'succeeded');
    assert.equal((await f.request('/api/threads/a/send', body)).body.state, 'succeeded');
    assert.deepEqual(f.state.queue[0].input, [{ type: 'text', text: '', textElements: [] }, { type: 'localImage', path: image.path }]);
    assert.equal(f.state.calls.filter(call => call.method === 'thread/queue/add').length, 1);
    const second = (await f.upload()).body;
    assert.equal((await f.request('/api/threads/a/send', { ...body, imageId: second.imageId })).status, 409);
    f.state.queue[0].input = [{ type: 'image', imageUrl: 'data:image/png;base64,PRIVATE_IMAGE' }];
    const queue = (await f.request('/api/threads/a/state')).body.queue;
    assert.equal(queue[0].text, '[画像]'); assert.equal(JSON.stringify(queue).includes('PRIVATE_IMAGE'), false);
    f.state.turns.get('a').at(-1).items[0].content.push({ type: 'image', imageUrl: 'data:image/png;base64,PRIVATE_IMAGE' });
    const history = (await f.request('/api/threads/a/history')).body;
    assert.match(JSON.stringify(history), /\[画像\]/); assert.equal(JSON.stringify(history).includes('PRIVATE_IMAGE'), false);
    f.state.queue = [];
    f.state.threads.get('a').status = { type: 'active', activeFlags: [] }; f.state.panes[0].agent_status = 'working';
    const cliBody = { ...body, requestId: 'image_active_1234567890', text: '画像の色を確認' };
    assert.equal((await f.request('/api/threads/a/send', cliBody)).body.state, 'succeeded');
    const expected = `画像の色を確認\n\n添付画像を次の絶対パスから読み取ってください。\n画像: ${JSON.stringify(image.path)}`;
    assert.deepEqual(f.state.writes.at(-1), { pane_id: 'w1:p1', text: '\x1b[200~' + expected + '\x1b[201~', keys: ['Enter'] });
    for (const [index, text] of ['/exit', ' !ls', '\u001b[201~'].entries()) {
        const result = await f.request('/api/threads/a/send', { ...cliBody, requestId: `image_cli_invalid_${index}_123456`, text });
        assert.equal(result.status === 400 || result.body.state === 'failed', true);
    }
    assert.equal(f.state.writes.length, 1);
    const c = await f.addClaude(); await f.request('/api/threads');
    const claudeImage = (await f.upload(c.id)).body;
    assert.equal((await f.request(`/api/threads/${c.id}/send`, { requestId: 'image_claude_1234567890', text: '', imageId: claudeImage.imageId })).body.state, 'succeeded');
    assert.equal(f.state.writes.at(-1).pane_id, c.pane.pane_id);
    assert.match(f.state.writes.at(-1).text, /添付画像/);
    assert.equal(JSON.parse(f.state.writes.at(-1).text.split('画像: ')[1].slice(0, -6)), f.service.images.get(claudeImage.imageId).path);
    f.service.images.clear();
    const lost = await f.request('/api/threads/a/send', { ...body, requestId: 'image_lost_1234567890' });
    assert.equal(lost.body.state, 'failed'); assert.match(lost.body.message, /選び直して/);
});

test('image expiry preserves fresh sends and removes expired files including unknown outcomes', async t => {
    const f = await imageFixture(t);
    let now = Date.UTC(2026, 9, 22); f.service.now = () => now;
    const uploaded = (await f.upload()).body;
    const expired = f.service.images.get(uploaded.imageId).path;
    const unrelated = join(f.service.imageDir, 'keep.txt'); await writeFile(unrelated, 'keep');
    now += IMAGE_LIFETIME;
    const rejected = await f.request('/api/threads/a/send', { requestId: 'image_expired_1234567890', text: '', imageId: uploaded.imageId });
    assert.equal(rejected.body.state, 'failed'); assert.match(rejected.body.message, /選び直して/);
    await f.upload();
    await assert.rejects(stat(expired), { code: 'ENOENT' }); assert.equal(await readFile(unrelated, 'utf8'), 'keep');
    const renewed = (await f.upload()).body; const path = f.service.images.get(renewed.imageId).path;
    now += IMAGE_LIFETIME - 1000;
    assert.equal((await f.request('/api/threads/a/send', { requestId: 'image_renew_1234567890', text: '', imageId: renewed.imageId })).body.state, 'succeeded');
    assert.equal((await stat(path)).mtimeMs, now);
    now += 2000; await f.upload(); assert.ok(await stat(path));
    f.state.queue = [];
    f.state.threads.get('a').status = { type: 'active', activeFlags: [] }; f.state.panes[0].agent_status = 'working';
    const gate = { paneId: 'w1:p1', ...Promise.withResolvers(), entered: Promise.withResolvers() }; f.state.readGate = gate;
    const sending = f.request('/api/threads/a/send', { requestId: 'image_inflight_1234567890', text: '', imageId: renewed.imageId });
    await gate.entered.promise;
    await f.upload(); assert.ok(await stat(path));
    gate.resolve(); assert.equal((await sending).body.state, 'succeeded');
    const unknown = (await f.upload()).body; const unknownPath = f.service.images.get(unknown.imageId).path;
    now += IMAGE_LIFETIME - 1000;
    f.state.ignoreInput = true;
    const unknownBody = { requestId: 'image_unknown_1234567890', text: '', imageId: unknown.imageId };
    assert.equal((await f.request('/api/threads/a/send', unknownBody)).body.state, 'unknown');
    assert.equal((await f.request('/api/threads/a/send', unknownBody)).body.state, 'unknown');
    assert.equal((await stat(unknownPath)).mtimeMs, now);
    now += 2000;
    await f.upload(); assert.ok(await stat(unknownPath));
    now += IMAGE_LIFETIME - 2000;
    await f.upload(); await assert.rejects(stat(unknownPath), { code: 'ENOENT' });
    f.service.images.clear();
    const orphan = join(f.service.imageDir, '00000000-0000-4000-8000-000000000000.png');
    await writeFile(orphan, PNG); await utimes(orphan, new Date(now - IMAGE_LIFETIME), new Date(now - IMAGE_LIFETIME));
    await f.upload(); await assert.rejects(stat(orphan), { code: 'ENOENT' });
});

test('usage HTTP reads only the verified Codex footer and validates percentages and target identity', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { state, request } = f;
    const unknown = { contextUsedPercent: null, weeklyLeftPercent: null };
    assert.equal((await request('/api/threads/a/usage', undefined, { Authorization: '' })).status, 401);
    await request('/api/threads');
    const screen = footer => codexScreen().replace('Context 5% used', footer);
    for (const [footer, expected] of [
        ['Context 64% used · weekly 85% left', { contextUsedPercent: 64, weeklyLeftPercent: 85 }],
        ['Context 0% used · weekly 100% left', { contextUsedPercent: 0, weeklyLeftPercent: 100 }],
        ['Context 100% used', { contextUsedPercent: 100, weeklyLeftPercent: null }],
        ['weekly 0% left', { contextUsedPercent: null, weeklyLeftPercent: 0 }],
        ...['Context 101% used · weekly -1% left', 'Context NaN% used · weekly Infinity% left',
            'Context 80% left · weekly 20% used', 'Context 1e1% used · weekly 85x% left',
            'Context 5% used · Context 6% used · weekly 85% left · weekly 90% left', 'short status'].map(value => [value, unknown]),
    ]) {
        state.ansiScreen = screen(footer);
        const result = await request('/api/threads/a/usage');
        assert.equal(result.status, 200); assert.deepEqual(result.body, expected);
    }
    state.ansiScreen = 'Context 90% used · weekly 20% left\n' + codexScreen('Context 70% used · weekly 30% left', false).replace('Context 5% used', 'status');
    assert.deepEqual((await request('/api/threads/a/usage')).body, unknown);
    state.ansiScreen = screen('Context 64% used · weekly 85% left');
    state.readPaneId = 'w2:p2';
    assert.deepEqual((await request('/api/threads/a/usage')).body, unknown);
    state.readPaneId = null;
    for (const text of [undefined, 'Context 64% used · weekly 85% left', screen('Context 64% used').replaceAll('›', '>')]) {
        state.ansiScreen = text;
        assert.deepEqual((await request('/api/threads/a/usage')).body, unknown);
    }
    state.ansiScreen = screen('Context 64% used · weekly 85% left');
    state.ignoreHerdrMethod = 'pane.read';
    assert.deepEqual((await request('/api/threads/a/usage')).body, unknown);
    state.ignoreHerdrMethod = null;
    const gate = { ...Promise.withResolvers(), entered: Promise.withResolvers(), paneId: 'w1:p1' };
    t.after(() => gate.resolve()); state.readGate = gate;
    const reading = request('/api/threads/a/usage');
    await gate.entered.promise;
    state.resources.get(200).ports = new Set([41002]);
    gate.resolve(); assert.deepEqual((await reading).body, unknown);
    state.resources.get(200).ports = new Set([41001]);
    await request('/api/threads');
    state.panes.push({ ...state.panes[0], pane_id: 'w3:p3' });
    assert.deepEqual((await request('/api/threads/a/usage')).body, unknown);
    state.panes.pop();
    state.resources.get(200).ports.add(41002);
    assert.equal((await request('/api/threads/a/usage')).status, 409);
    state.resources.get(200).ports = new Set([41001]);
    const c = await f.addClaude();
    await request('/api/threads');
    const reads = state.herdrCalls.filter(call => call.method === 'pane.read').length;
    assert.deepEqual((await request(`/api/threads/${c.id}/usage`)).body, unknown);
    assert.equal(state.herdrCalls.filter(call => call.method === 'pane.read').length, reads);
    assert.equal(state.writes.length, 0);
    assert.ok(state.herdrCalls.filter(call => call.method === 'pane.read').every(call => call.params.format === 'ansi' && call.params.strip_ansi === false));
});

test('async question history and pending state recognize exact replies, IDE context and legacy IDs', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { state, request } = f;
    const turn = state.ask();
    const item = turn.items[0];
    const identity = index => JSON.stringify(['request_user_input_async', item.id, index]);
    const reply = (questionItemId, answer = 'PCで回答') => ({ questionItemId, question: '環境?', answer });
    const envelope = value => `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`;
    await request('/api/threads');
    let current = (await request('/api/threads/a/state')).body;
    assert.deepEqual(current.questions.map(question => [question.index, question.questionItemId]), [[0, identity(0)], [1, identity(1)]]);
    let history = (await request('/api/threads/a/history')).body;
    assert.deepEqual(history.turns.at(-1).items[0].questions, item.questions);
    for (const text of ['quoted ' + envelope(reply(identity(0))), envelope([reply(identity(0)), null]), envelope([]), envelope(reply(identity(0), String.fromCharCode(0xd800)))]) {
        state.queue = [{ id: 'malformed', input: [{ type: 'text', text }] }];
        assert.equal((await request('/api/threads/a/state')).body.questions.length, 2);
    }
    state.queue = [{ id: 'pc-answer', input: [{ type: 'skill', name: 'example' }, { type: 'text', text: '# Context from my IDE setup:\n\n## Open tabs:\nfile.rs\n\n## My request for Codex:\n' + envelope(reply(identity(0))) }] }];
    current = (await request('/api/threads/a/state')).body;
    assert.deepEqual(current.questions.map(question => question.index), [1]);
    assert.match(current.queue[0].text, /質問: 環境\?\n\n回答: PCで回答/);
    state.queue = [];
    turn.items.push({ id: 'answer', type: 'userMessage', content: [{ type: 'text', text: envelope([reply(item.id, '全問への回答')]) }] });
    assert.deepEqual((await request('/api/threads/a/state')).body.questions, []);
    history = (await request('/api/threads/a/history')).body;
    assert.equal(history.turns.at(-1).items.at(-1).text, '質問: 環境?\n\n回答: 全問への回答');
    turn.items.pop();
    for (const status of ['completed', 'interrupted', 'failed']) {
        turn.status = status;
        assert.deepEqual((await request('/api/threads/a/state')).body.questions, []);
        assert.equal((await request('/api/threads/a/history')).body.turns.at(-1).items[0].questions.length, 2);
    }
});

test('answer HTTP validates question ownership and serializes bounded titles through turn steer', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { state, request } = f;
    const title = '環境\r\n' + 'あ'.repeat(170) + 'tail';
    const turn = state.ask('a', [{ title, options: ['開発', '本番'] }]);
    state.ansiScreen = codexScreen('PCの通常下書き', false);
    await request('/api/threads');
    const base = { requestId: 'question_answer_1234567890', turnId: turn.id, itemId: turn.items[0].id, index: 0, answer: '/compact\n自由な回答 <>&"引用"' };
    const hookState = (await request('/api/threads/a/state')).body;
    assert.equal(hookState.answerable, true);
    assert.deepEqual(hookState.thread.status.activeFlags, ['waitingOnApprovalOrInput']);
    assert.equal((await request('/api/threads/a/send', { requestId: 'question_normal_message_1234567890', text: '通常の追加指示' })).body.state, 'failed');
    for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
        state.threads.get('a').status = { type: 'active', activeFlags: [flag] };
        const blocked = (await request('/api/threads/a/state')).body;
        assert.equal(blocked.answerable, false); assert.equal(blocked.questions.length, 1);
        assert.equal((await request('/api/threads/a/answer', { ...base, requestId: `question_${flag}_1234567890` })).body.state, 'failed');
    }
    state.loadedIds = state.loadedIds.filter(id => id !== 'a');
    state.resources.get(200).threadIds.add('a');
    state.threads.get('a').status = { type: 'notLoaded' };
    const unloaded = (await request('/api/threads/a/state')).body;
    assert.equal(unloaded.answerable, false); assert.deepEqual(unloaded.questions, []);
    assert.equal((await request('/api/threads/a/history')).body.turns.at(-1).items[0].questions.length, 1);
    assert.equal((await request('/api/threads/a/answer', { ...base, requestId: 'question_unloaded_1234567890' })).body.state, 'failed');
    assert.equal(state.steers.length, 0); assert.equal(state.writes.length, 0);
    state.loadedIds.push('a');
    state.threads.get('a').status = { type: 'active', activeFlags: [] };
    assert.equal((await request('/api/threads/a/answer', base, { Authorization: '' })).status, 401);
    assert.equal((await request('/api/threads/a/answer', base, { Origin: '' })).status, 403);
    for (const [index, invalid] of [{ answer: '' }, { answer: 'a\x1b[200~' }, { answer: 'あ'.repeat(11000) }, { answer: '\ud800' }, { index: -1 }, { index: 0.5 }].entries()) {
        assert.equal((await request('/api/threads/a/answer', { ...base, ...invalid, requestId: `question_invalid_${index}_1234567890` })).status, 400);
    }
    for (const [index, invalid] of [{ turnId: 'old-turn' }, { itemId: 'other-message' }, { index: 9 }].entries()) {
        assert.equal((await request('/api/threads/a/answer', { ...base, ...invalid, requestId: `question_stale_${index}_1234567890` })).body.state, 'failed');
    }
    assert.equal((await request('/api/threads/b/answer', { ...base, requestId: 'question_wrong_thread_1234567890' })).body.state, 'failed');
    const gate = { ...Promise.withResolvers(), entered: Promise.withResolvers() };
    t.after(() => gate.resolve()); state.steerGate = gate;
    const sending = request('/api/threads/a/answer', base);
    await gate.entered.promise;
    assert.equal((await request('/api/threads/a/answer', base)).body.state, 'processing');
    assert.equal((await request('/api/threads/a/state')).body.questions.length, 0);
    gate.resolve();
    assert.equal((await sending).body.state, 'succeeded');
    assert.equal((await request('/api/threads/a/answer', base)).body.state, 'succeeded');
    assert.equal((await request('/api/threads/a/answer', { ...base, requestId: 'question_duplicate_1234567890' })).body.state, 'failed');
    assert.equal(state.steers.length, 1);
    const sent = state.steers[0];
    assert.equal(sent.threadId, 'a'); assert.equal(sent.expectedTurnId, turn.id); assert.equal(sent.clientUserMessageId, base.requestId);
    assert.deepEqual(Object.keys(sent.input[0]).sort(), ['text', 'text_elements', 'type']);
    const text = sent.input[0].text;
    const payload = JSON.parse(text.slice('<send_user_message_question_reply>'.length, -'</send_user_message_question_reply>'.length));
    assert.deepEqual(payload, [{ answer: base.answer, question: '環境  ' + 'あ'.repeat(168), questionItemId: JSON.stringify(['request_user_input_async', base.itemId, 0]) }]);
    assert.ok(Buffer.byteLength(payload[0].question) <= 512);
    assert.equal(state.writes.length, 0);
    assert.equal(state.calls.some(call => ['thread/resume', 'turn/start', 'thread/queue/add'].includes(call.method)), false);
    const confirmed = (await request('/api/threads/a/state')).body;
    assert.equal(confirmed.questions.length, 0);
    assert.equal((await request(`/api/operations/${base.requestId}`)).body.value.confirmed, true);
    state.queue = []; turn.status = 'completed';
    assert.equal((await request('/api/threads/a/answer', { ...base, requestId: 'question_ended_1234567890' })).body.state, 'failed');
    turn.status = 'inProgress'; turn.items[0].id = 'あ'.repeat(170);
    assert.equal((await request('/api/threads/a/answer', { ...base, itemId: turn.items[0].id, requestId: 'question_long_id_1234567890' })).body.state, 'failed');
    assert.equal(state.steers.length, 1);
});

test('uncertain answers reserve the question until upstream confirmation or guarded PC recovery', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { state, request } = f;
    const turn = state.ask(); state.ignoreSteer = true; state.steerConfirm = false;
    await request('/api/threads');
    const base = { requestId: 'question_unknown_1234567890', turnId: turn.id, itemId: turn.items[0].id, index: 0, answer: '保持する回答' };
    assert.equal((await request('/api/threads/a/answer', base)).body.state, 'unknown');
    assert.equal((await request('/api/threads/a/answer', { ...base, requestId: 'question_retry_1234567890' })).body.state, 'failed');
    assert.equal((await request('/api/threads/a/answer', base)).body.state, 'unknown');
    assert.equal((await request('/api/threads/a/state')).body.questions[0].operation, base.requestId);
    const recovery = { ...base, confirmed: true };
    for (const [path, changes] of [['a', { confirmed: false }], ['b', {}], ['a', { turnId: 'old-turn' }], ['a', { requestId: 'question_wrong_op_1234567890' }]]) {
        assert.equal((await request(`/api/threads/${path}/answer-recover`, { ...recovery, ...changes })).status, 409);
    }
    assert.equal((await request('/api/threads/a/answer-recover', recovery)).body.released, true);
    assert.equal((await request('/api/threads/a/answer', base)).body.state, 'failed');
    const next = { ...base, requestId: 'question_new_operation_1234567890' };
    assert.equal((await request('/api/threads/a/answer', next)).body.state, 'unknown');
    state.queue = [{ id: 'pc-confirmed', input: state.steers.at(-1).input }];
    assert.equal((await request('/api/threads/a/state')).body.questions[0].index, 1);
    assert.equal((await request(`/api/operations/${next.requestId}`)).body.value.confirmed, true);
    assert.equal(state.steers.length, 2);
    assert.equal(state.writes.length, 0);
    turn.status = 'completed';
    assert.equal((await request('/api/threads/a/answer-recover', { ...base, requestId: 'question_missing_operation_1234567890', confirmed: true })).body.released, true);
});

test('question polling bounds ordinary reads and retains uncertain operations after turn end', async t => {
    for (const uncertain of [false, true]) await t.test(uncertain ? 'uncertain answer awaits upstream confirmation' : 'accepted answer finishes with its original turn', async t => {
        const f = await fixture(); t.after(() => f.close());
        const { state, request } = f;
        const turn = state.ask('a', [{ title: '確認する環境は？' }]);
        state.steerConfirm = false; state.ignoreSteer = uncertain;
        const latestLimit = () => state.calls.findLast(call => call.method === 'thread/turns/list').params.limit;
        await request('/api/threads');
        assert.equal((await request('/api/threads/a/state')).body.activeTurnId, turn.id);
        assert.equal(latestLimit(), 1);
        const answer = { requestId: 'question_lifecycle_1234567890', turnId: turn.id, itemId: turn.items[0].id, index: 0, answer: '保持する回答' };
        assert.equal((await request('/api/threads/a/answer', answer)).body.state, uncertain ? 'unknown' : 'succeeded');
        turn.status = 'completed';
        const nextTurn = state.makeTurn(301); nextTurn.status = 'inProgress'; state.turns.get('a').push(nextTurn);
        const current = (await request('/api/threads/a/state')).body;
        assert.equal(current.activeTurnId, nextTurn.id); assert.deepEqual(current.questions, []);
        assert.equal(latestLimit(), 20);
        let operation = (await request(`/api/operations/${answer.requestId}`)).body;
        if (uncertain) {
            assert.equal(operation.state, 'unknown');
            turn.items.push({ id: 'upstream-answer', type: 'userMessage', content: state.steers[0].input });
            await request('/api/threads/a/state');
            assert.equal(latestLimit(), 20);
            operation = (await request(`/api/operations/${answer.requestId}`)).body;
            assert.deepEqual(operation.value, { confirmed: true });
        } else assert.deepEqual(operation.value, { turnEnded: true });
        assert.equal(operation.state, 'succeeded');
        await request('/api/threads/a/state');
        assert.equal(latestLimit(), 1);
    });
});

test('Claude viewing shares session discovery while delivery refreshes it and failures remain retryable', async t => {
    let now = 0;
    const f = await fixture({ now: () => now }); t.after(() => f.close());
    const c = await f.addClaude(true), api = `/api/threads/${c.id}`;
    const gate = { ...Promise.withResolvers(), entered: Promise.withResolvers() };
    t.after(() => gate.resolve());
    f.state.claudeGate = gate;
    const loading = f.service.claude.sessions();
    await gate.entered.promise;
    const shared = f.service.claude.sessions();
    assert.equal(f.state.claudeCalls, 1);
    const refreshing = f.service.claude.sessions({ fresh: true });
    assert.equal(f.state.claudeCalls, 2);
    gate.resolve();
    const [first, second] = await Promise.all([loading, shared, refreshing]);
    assert.deepEqual(first, second);
    for (const path of ['/api/threads', `${api}/state`, `${api}/history`]) assert.equal((await f.request(path)).status, 200);
    assert.equal(f.state.claudeCalls, 2);
    let calls = f.state.claudeCalls;
    assert.equal((await f.request(`${api}/send`, { requestId: 'claude_fresh_send_1234567890', text: '最新の対象へ送信' })).body.state, 'succeeded');
    assert.ok(f.state.claudeCalls > calls);
    calls = f.state.claudeCalls;
    const binding = (await f.request(`${api}/bind`, { paneId: c.pane.pane_id })).body;
    assert.ok(f.state.claudeCalls > calls);
    calls = f.state.claudeCalls;
    const view = (await f.request(`${api}/terminal?bindingId=${binding.bindingId}`)).body;
    assert.ok(f.state.claudeCalls > calls);
    calls = f.state.claudeCalls;
    assert.equal((await f.request(`${api}/terminal-input`, { requestId: 'claude_fresh_terminal_1234567890', bindingId: binding.bindingId, viewId: view.viewId, key: 'Enter' })).body.state, 'succeeded');
    assert.ok(f.state.claudeCalls > calls);
    assert.deepEqual(f.state.writes, [
        { pane_id: c.pane.pane_id, text: '\x1b[200~最新の対象へ送信\x1b[201~', keys: ['Enter'] },
        { pane_id: c.pane.pane_id, keys: ['Enter'] },
    ]);
    calls = f.state.claudeCalls;
    now += 1001; f.state.failClaude = true;
    assert.equal((await f.request('/api/threads')).status, 502);
    f.state.failClaude = false;
    assert.equal((await f.request('/api/threads')).status, 200);
    assert.equal(f.state.claudeCalls, calls + 2);
    c.session.status = 'busy'; now += 1001;
    assert.equal((await f.request(`${api}/state`)).body.thread.status.type, 'active');
});

test('Claude-only discovery, history, send and terminal operations need no Codex socket', async t => {
    let now = 0;
    const f = await fixture({ now: () => now }); t.after(() => f.close());
    const c = await f.addClaude(true);
    f.service.codex.socketPath += '.missing'; f.state.failPresence = true;
    const api = `/api/threads/${c.id}`;
    assert.deepEqual((await f.request('/api/threads')).body.threads.map(thread => [thread.id, thread.provider]), [[c.id, 'claude']]);
    assert.deepEqual((await f.request(`${api}/state`)).body.queue, []);
    assert.deepEqual((await f.request(`${api}/history`)).body, { turns: [], nextCursor: null });
    const send = (requestId, text = 'スマホの指示\n2行目') => f.request(`${api}/send`, { requestId, text });
    for (const [index, screen] of [claudeScreen('PCの下書き'), claudeScreen('1行目\r\n  2行目'), claudeScreen('\r\n  PCの下書き'), claudeScreen('  '), claudeScreen() + '\r\n❯ 別の欄', '❯\u00a0'].entries()) {
        f.state.ansiScreen = screen;
        assert.equal((await send(`claude_draft_${index}_1234567890`)).body.state, 'failed');
    }
    f.state.ansiScreen = claudeScreen();
    for (const [index, text] of ['/exit', '  !ls'].entries()) assert.equal((await send(`claude_command_${index}_1234567890`, text)).body.state, 'failed');
    assert.equal(f.state.writes.length, 0);
    for (const [index, status] of ['idle', 'busy'].entries()) {
        c.session.status = status;
        now += 1001;
        f.state.ansiScreen = claudeScreen(index ? '' : undefined);
        assert.equal((await f.request(`${api}/state`)).body.thread.status.type, index ? 'active' : 'idle');
        const requestId = `claude_send_${index}_1234567890`;
        assert.equal((await send(requestId)).body.state, 'succeeded');
        assert.equal((await send(requestId)).body.state, 'succeeded');
        assert.deepEqual(f.state.writes.at(-1), { pane_id: c.pane.pane_id, text: '\x1b[200~スマホの指示\n2行目\x1b[201~', keys: ['Enter'] });
    }
    const binding = (await f.request(`${api}/bind`, { paneId: c.pane.pane_id })).body;
    const view = (await f.request(`${api}/terminal?bindingId=${binding.bindingId}`)).body;
    const terminal = { requestId: 'claude_terminal_1234567890', bindingId: binding.bindingId, viewId: view.viewId, key: 'Enter' };
    assert.equal((await f.request(`${api}/terminal-input`, terminal)).body.state, 'succeeded');
    assert.equal((await f.request(`${api}/terminal-input`, terminal)).body.state, 'succeeded');
    assert.equal(f.state.writes.length, 3);
    f.state.ignoreInput = true;
    assert.equal((await send('claude_unknown_1234567890')).body.state, 'unknown');
    assert.equal((await send('claude_unknown_1234567890')).body.state, 'unknown');
    assert.equal(f.state.writes.length, 4);
    assert.deepEqual(f.state.calls, []);
});

test('Claude ownership and waiting status are rechecked before paste and terminal delivery', async t => {
    let now = 0;
    const f = await fixture({ now: () => now }); t.after(() => f.close());
    const c = await f.addClaude(true), api = `/api/threads/${c.id}`;
    await f.request('/api/threads');
    const original = structuredClone({ pane: c.pane, process: c.process, session: c.session });
    const mutations = [
        () => { c.process.foreground_processes[0].pid++; },
        () => { c.session.sessionId = '00000000-0000-4000-8000-000000000999'; },
        () => { c.session.cwd += '/other'; },
        () => { c.pane.agent_session.value = 'different'; },
        () => { c.pane.terminal_id = 'different'; },
        () => { c.session.status = 'waiting'; c.session.waitingFor = 'permission prompt'; },
        () => { c.session.waitingFor = 'dialog open'; },
        () => { c.pane.agent_status = 'blocked'; },
    ];
    for (const [index, mutate] of mutations.entries()) {
        Object.assign(c.pane, structuredClone(original.pane)); Object.assign(c.process, structuredClone(original.process));
        for (const key of Object.keys(c.session)) delete c.session[key];
        Object.assign(c.session, original.session);
        const gate = { ...Promise.withResolvers(), paneId: c.pane.pane_id, entered: Promise.withResolvers() };
        f.state.readGate = gate;
        const sending = f.request(`${api}/send`, { requestId: `claude_changed_${index}_1234567890`, text: '送信直前の確認' });
        await gate.entered.promise; mutate(); gate.resolve();
        assert.equal((await sending).body.state, 'failed');
    }
    assert.equal(f.state.writes.length, 0);
    Object.assign(c.pane, structuredClone(original.pane)); Object.assign(c.session, original.session); delete c.session.waitingFor;
    c.session.status = 'waiting';
    now += 1001;
    assert.deepEqual((await f.request(`${api}/state`)).body.thread.status.activeFlags, ['waitingOnApprovalOrInput']);
    c.session.status = 'idle';
    const binding = (await f.request(`${api}/bind`, { paneId: c.pane.pane_id })).body;
    const view = (await f.request(`${api}/terminal?bindingId=${binding.bindingId}`)).body;
    const gate = { ...Promise.withResolvers(), paneId: c.pane.pane_id, entered: Promise.withResolvers() };
    f.state.readGate = gate;
    const input = f.request(`${api}/terminal-input`, { requestId: 'claude_changed_binding_1234567890', bindingId: binding.bindingId, viewId: view.viewId, key: 'Enter' });
    await gate.entered.promise;
    c.session.sessionId = '00000000-0000-4000-8000-000000000999';
    gate.resolve();
    assert.equal((await input).body.state, 'failed');
    c.session.sessionId = original.session.sessionId;
    const rebound = (await f.request(`${api}/bind`, { paneId: c.pane.pane_id })).body;
    const refreshed = (await f.request(`${api}/terminal?bindingId=${rebound.bindingId}`)).body;
    c.process.foreground_processes[0].argv0 = 'zsh';
    assert.equal((await f.request(`${api}/terminal-input`, { requestId: 'claude_stale_binding_1234567890', bindingId: rebound.bindingId, viewId: refreshed.viewId, key: 'Enter' })).body.state, 'failed');
    assert.deepEqual((await f.request('/api/threads')).body.threads, []);
    assert.equal((await f.request(`${api}/state`)).status, 404);
    assert.equal(f.state.writes.length, 0);
});

test('Claude JSONL projects allowed records with stable append IDs and cursor anchors over real HTTP', async t => {
    const f = await fixture(); t.after(() => f.close());
    const c = await f.addClaude(true), api = `/api/threads/${c.id}/history`;
    const users = Array.from({ length: 26 }, (_, index) => c.row('user', `確認 ${index + 1}`));
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PRIVATE').toString('base64') } };
    const document = { type: 'document', title: 'PRIVATE', source: { type: 'base64', media_type: 'application/pdf', data: image.source.data } };
    users[0].message.content = [image];
    users[10].message.content = [image];
    users[11].message.content = [{ type: 'text', text: '本文と添付' }, image, document];
    const rows = users.flatMap((row, index) => Array.isArray(row.message.content)
        ? [row, c.row('assistant', [{ type: 'text', text: `添付への返答 ${index + 1}` }])]
        : [row]);
    const last = users.at(-1);
    const sameMessage = { id: 'same-message', role: 'assistant' };
    rows.push(c.row('assistant', [{ type: 'thinking', thinking: 'PRIVATE' }]),
        c.row('assistant', [{ type: 'text', text: '最初の本文' }], { message: { ...sameMessage, content: [{ type: 'text', text: '最初の本文' }] } }),
        c.row('system', 'PRIVATE'), c.row('user', 'PRIVATE', { isMeta: true }), c.row('assistant', [{ type: 'text', text: 'PRIVATE' }], { isSidechain: true }),
        c.row('assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }]),
        c.row('user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: '/projects/agent-monitor' }] }]));
    await c.write(rows);
    await appendFile(c.path, '{"type":');
    await f.request('/api/threads');
    const first = (await f.request(api)).body;
    assert.equal(first.turns.length, 20);
    assert.equal(first.turns.at(-1).id, last.uuid);
    assert.deepEqual(first.turns.at(-1).items.map(item => item.type), ['userMessage', 'agentMessage', 'dynamicToolCall']);
    assert.equal(first.turns.at(-1).items.at(-1).status, 'completed');
    assert.match(first.turns.at(-1).items.at(-1).text, /\/projects\/agent-monitor/);
    const size = (await stat(c.path)).size; await truncate(c.path, size - '{"type":'.length);
    const next = c.row('assistant', [], { message: { ...sameMessage, content: [{ type: 'text', text: '追記された本文' }] } });
    await c.append([next, next, ...Array.from({ length: 23 }, (_, index) => c.row('user', `追加 ${index}`))]);
    const update = (await f.request(`${api}?until=${last.uuid}`)).body;
    const merged = mergeTurns(first.turns, update.turns);
    assert.deepEqual(merged.find(turn => turn.id === last.uuid).items.filter(item => item.type === 'agentMessage').map(item => item.text), ['最初の本文', '追記された本文']);
    const older = (await f.request(`${api}?cursor=${first.nextCursor}`)).body;
    const initial = [...older.turns, ...first.turns];
    for (const [index, text] of [[0, '[画像]'], [10, '[画像]'], [11, '本文と添付\n[画像]\n[添付ファイル]']]) {
        const turn = initial.find(turn => turn.id === users[index].uuid);
        assert.deepEqual(turn?.items.map(item => [item.type, item.text]), [
            ['userMessage', text], ['agentMessage', `添付への返答 ${index + 1}`],
        ]);
    }
    assert.equal(JSON.stringify(initial).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(initial).includes(image.source.data), false);
    assert.equal(older.turns.length, 6); assert.equal(older.turns[0].id, rows[0].uuid); assert.equal(older.nextCursor, null);
    const otherProject = join(dirname(dirname(c.path)), 'duplicate'); await mkdir(otherProject);
    const duplicate = join(otherProject, `${c.session.sessionId}.jsonl`); await copyFile(c.path, duplicate);
    assert.match((await f.request(api)).body.error, /1つに特定/);
    await rm(duplicate);
    await c.write([c.row('user', '別の場所の履歴', { cwd: '/other' })]);
    assert.match((await f.request(api)).body.error, /対応を確認できません/);
    await writeFile(c.path, 'invalid JSON\n');
    assert.match((await f.request(api)).body.error, /解析できません/);
    await writeFile(c.path, 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.match((await f.request(api)).body.error, /2MiBを超えて/);
});

test('Codex and Claude coexist while ambiguous, internal and wrong-cwd Claude sessions stay unresolved', async t => {
    let now = 0;
    const f = await fixture({ now: () => now }); t.after(() => f.close());
    const c = await f.addClaude();
    let list = (await f.request('/api/threads')).body;
    assert.deepEqual(list.threads.map(thread => thread.provider), ['codex', 'codex', 'claude']);
    for (const mutate of [() => { c.session.kind = 'background'; }, () => { c.session.cwd = '/other'; }, () => { f.state.claudeSessions.push({ ...c.session }); }]) {
        c.session.kind = 'interactive'; c.session.cwd = c.pane.cwd; f.state.claudeSessions = [c.session];
        mutate(); now += 1001; list = (await f.request('/api/threads')).body;
        assert.deepEqual(list.threads.map(thread => thread.id), ['a', 'b']); assert.equal(list.unresolvedCount, 1);
    }
    f.state.claudeSessions = [c.session];
    now += 1001;
    const duplicate = { ...c.pane, pane_id: 'duplicate-claude' };
    f.state.panes.push(duplicate); f.state.processes.set(duplicate.pane_id, c.process);
    list = (await f.request('/api/threads')).body;
    assert.deepEqual(list.threads.map(thread => thread.id), ['a', 'b']); assert.equal(list.unresolvedCount, 2);
    f.state.panes.pop();
    f.service.codex.close(); f.service.codex.socketPath += '.missing';
    assert.equal((await f.request('/api/threads')).status, 502);
});

test('unmaterialized history allows the first instruction on the same thread and preserves other errors', async t => {
    const f = await fixture(); t.after(() => f.close());
    await f.request('/api/threads');
    const message = 'thread a is not materialized yet; thread/turns/list is unavailable before first user message';
    f.state.historyError = { code: -32600, message };
    const history = await f.request('/api/threads/a/history');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body, { turns: [], nextCursor: null });
    assert.equal((await f.request('/api/threads/a/state')).body.thread.status.type, 'idle');
    const body = { requestId: 'first_message_1234567890', text: '最初の指示' };
    assert.equal((await f.request('/api/threads/a/send', body)).body.state, 'succeeded');
    assert.equal((await f.request('/api/threads/a/send', body)).body.state, 'succeeded');
    assert.deepEqual(f.state.calls.filter(call => call.method === 'thread/queue/add').map(call => call.params.threadId), ['a']);
    for (const [error, query] of [
        [{ code: -1, message }, ''],
        [{ code: -32600, message: 'Invalid cursor' }, '?cursor=bad'],
        [{ code: -32600, message }, '?cursor=20'],
    ]) {
        f.state.historyError = error;
        assert.equal((await f.request(`/api/threads/a/history${query}`)).status, 502);
    }
});

test('Herdr foreground ownership excludes ended CLI sessions and unsupported unsubscribe fails visibly', async t => {
    const f = await fixture(); t.after(() => f.close());
    assert.equal((await f.request('/api/threads')).status, 200);
    f.state.process.foreground_processes = [{ pid: 100, name: 'zsh', argv: ['zsh'] }];
    assert.deepEqual((await f.request('/api/threads')).body.threads.map(thread => thread.id), ['b']);
    assert(f.state.loadedIds.includes('a'));
    assert.equal((await f.request('/api/threads/a/history')).status, 404);
    assert.equal((await f.request('/api/threads/b/state')).status, 200);
    f.state.failUnsubscribe = true;
    const unsupported = await f.request('/api/threads');
    assert.equal(unsupported.status, 502);
    assert.match(unsupported.body.error, /thread\/unsubscribeに対応していない/);
});

test('PID resources resolve ID-less panes, reject ambiguous users and recheck replacement CLIs', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { state, request } = f;
    state.threads.set('outside', { ...state.threads.get('a'), id: 'outside' });
    state.loadedIds.push('outside');
    state.origins.set('outside', 'http://127.0.0.1:42000');
    let list = await request('/api/threads');
    assert.deepEqual(list.body.threads.map(thread => thread.id), ['a', 'b']);
    assert.equal(list.body.unresolvedCount, 0);
    assert(state.calls.filter(call => call.method === 'mcpServerStatus/list').every(call => call.params.threadId && call.params.serverName === 'codex_tui' && call.params.detail === 'toolsAndAuthOnly'));
    assert.equal(state.calls.some(call => call.method === 'mcpServerStatus/list' && call.params.threadId === 'sub'), false);
    const binding = (await request('/api/threads/a/bind', { paneId: 'w1:p1' })).body;
    state.panes[0].agent_session = { agent: 'codex', value: 'a' };
    state.threads.set('replacement', { ...state.threads.get('a'), id: 'replacement' });
    state.loadedIds.push('replacement'); state.origins.set('replacement', 'http://127.0.0.1:43000');
    state.process.foreground_processes[0].pid = 300;
    state.resources.set(300, { ports: new Set([43000]), threadIds: new Set() });
    assert.equal((await request(`/api/threads/a/terminal?bindingId=${binding.bindingId}`)).status, 409);
    assert.equal((await request('/api/threads/a/send', { requestId: 'replaced_cli_1234567890', text: '古い会話への入力' })).body.state, 'failed');
    assert.equal(state.writes.length, 0);
    list = await request('/api/threads');
    assert.deepEqual(list.body.threads.map(thread => thread.id), ['replacement', 'b']);
    assert.equal((await request('/api/threads/replacement/bind', { paneId: 'w1:p1' })).status, 200);
    state.origins.set('outside', 'http://127.0.0.1:43000');
    list = await request('/api/threads');
    assert.deepEqual(list.body.threads.map(thread => thread.id), ['b']);
    assert.equal(list.body.unresolvedCount, 1);
    state.origins.delete('outside');
    state.process.foreground_processes[0].argv = ['codex', 'app-server'];
    assert.deepEqual((await request('/api/threads')).body.threads.map(thread => thread.id), ['b']);
    state.failPresence = true;
    assert.equal((await request('/api/threads')).status, 502);
    assert.equal((await request('/api/threads/b/send', { requestId: 'os_failed_1234567890', text: '状態未確認の入力' })).body.state, 'failed');
});

test('Installed CLI symlink: another cwd, authenticated loopback HTTP, QR and SIGTERM exit', async t => {
    const f = await fixture(); t.after(() => f.close());
    const directory = await mkdtemp(join(tmpdir(), 'am-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const launcher = join(directory, 'agent-monitor');
    await symlink(fileURLToPath(new URL('../bin/agent-monitor', import.meta.url)), launcher);
    const reserve = net.createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const child = spawn(launcher, ['--codex-socket', f.codexPath + '.missing', '--herdr-socket', f.herdrPath, '--port', String(port)], {
        cwd: directory,
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
        }
    });
    let output = '';
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI startup timed out')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.stdout.on('data', data => {
            output += data.toString();
            const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#([\w-]+)/);
            if (match && output.includes('スマホ接続')) { clearTimeout(timer); resolve(new URL(match[0])); }
        });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('CLI exited before ready')); });
    });
    assert.equal(url.hostname, '127.0.0.1');
    assert(url.hash.length > 40);
    assert(output.length > 500);
    const response = await fetch(`${url.origin}/api/operations/missing`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` } });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /操作の記録がありません/);
    child.kill('SIGTERM');
    const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI shutdown timed out')), 5000);
        exited.then(value => { clearTimeout(timer); resolve(value); });
    });
    assert.deepEqual(result, { code: 0, signal: null });
});

test('Serve requires a valid own-login configuration and local mode requires a token', () => {
    const origin = 'https://monitor.example.ts.net';
    for (const tailscaleLogin of ['', null, 42, ' ', 'owner@example.com\n', 'owner@example.com, owner@example.com']) {
        assert.throws(() => createMonitorServer({ origin, tailscaleLogin, token: 'valid-local-token' }), /LoginName/);
    }
    assert.throws(() => createMonitorServer({ origin: 'http://127.0.0.1:4317', tailscaleLogin: 'owner@example.com' }), /HTTPS/);
    for (const token of [undefined, null, '']) assert.throws(() => createMonitorServer({ origin, token }), /認証トークン/);
});

test('Serve HTTP authorizes only the own login and preserves exact Host and POST Origin checks', async t => {
    const f = await fixture(); t.after(() => f.close());
    const origin = 'https://monitor.example.ts.net', login = 'owner@example.com';
    const server = createMonitorServer({ service: f.service, origin, tailscaleLogin: login, token: f.token });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const request = (path, headers = {}, body) => new Promise((resolve, reject) => {
        const outgoing = http.request({ host: '127.0.0.1', port: server.address().port, path,
            method: body === undefined ? 'GET' : 'POST',
            headers: { Host: new URL(origin).host, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        }, response => {
            let text = '';
            response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
            response.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const identity = { 'Tailscale-User-Login': login };
    assert.equal((await request('/api/threads', identity)).status, 200);
    for (const headers of [
        {}, { Authorization: `Bearer ${f.token}` }, { Authorization: 'Bearer undefined' },
        { 'Tailscale-User-Login': '' }, { 'Tailscale-User-Login': 'other@example.com', Authorization: `Bearer ${f.token}` },
        { 'Tailscale-User-Login': [login, login] }, { 'Tailscale-User-Login': [login, 'other@example.com'] },
    ]) {
        const denied = await request('/api/threads', headers);
        assert.equal(denied.status, 401);
        assert.match(denied.body.error, /Tailscale Serve/);
        assert.equal(denied.body.error.includes('QR'), false);
    }
    assert.equal((await request('/api/threads', { ...identity, Host: 'evil.example', 'X-Forwarded-Host': new URL(origin).host })).status, 403);
    assert.equal((await request('/api/threads', { ...identity, Origin: 'https://evil.example', 'X-Forwarded-Origin': origin })).status, 403);
    const body = { requestId: 'serve_send_123456789012345', text: '本人の指示' };
    for (const headers of [identity, { ...identity, Origin: 'https://evil.example' }, { ...identity, 'X-Forwarded-Origin': origin }]) {
        assert.equal((await request('/api/threads/a/send', headers, body)).status, 403);
    }
    assert.equal((await request('/api/threads/a/send', { Origin: origin, Authorization: `Bearer ${f.token}` }, body)).status, 401);
    assert.equal(f.state.calls.filter(call => call.method === 'thread/queue/add').length, 0);
    const allowed = await request('/api/threads/a/send', { ...identity, Origin: origin }, body);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.state, 'succeeded');
    assert.equal(f.state.calls.filter(call => call.method === 'thread/queue/add').length, 1);
});

test('HTTP authentication, allowed targets, history and queue delivery', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { request, state } = f;
    await t.test('authentication, Host, Origin, JSON and static allowlist', async () => {
        assert.equal((await request('/api/threads', undefined, { Authorization: '' })).status, 401);
        assert.equal((await request('/api/threads', undefined, { Origin: 'http://evil.example' })).status, 403);
        const badHost = await new Promise(resolve => {
            http.get(`${f.origin}/api/threads`, { headers: { Host: 'evil.example', Authorization: `Bearer ${f.token}` } }, response => { response.resume(); resolve(response.statusCode); });
        });
        assert.equal(badHost, 403);
        assert.equal((await request('/api/threads?token=secret')).status, 400);
        assert.equal((await request('/api/threads/a/send', {}, { 'Content-Type': 'text/plain' })).status, 415);
        assert.equal((await request('/api/threads/a/send', {}, { Origin: '' })).status, 403);
        assert.equal((await request('/api/threads/a/send', { text: 'x'.repeat(140000) })).status, 413);
        for (const path of ['/src/cli.js', '/package.json', '/..%2fREADME.md', '/api/rpc']) {
            assert.equal((await fetch(`${f.origin}${path}`, { headers: { Authorization: `Bearer ${f.token}` } })).status, 404);
        }
        const response = await fetch(f.origin);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
    });
    await t.test('loaded pagination excludes subAgents and history hides reasoning', async () => {
        const list = await request('/api/threads');
        assert.deepEqual(list.body.threads.map(thread => thread.id), ['a', 'b']);
        const herdrSocket = f.service.herdr.socketPath;
        f.service.herdr.socketPath = undefined;
        const withoutHerdr = await request('/api/threads');
        assert.equal(withoutHerdr.status, 502);
        assert.equal((await request('/api/threads/a/history')).status, 502);
        f.service.herdr.socketPath = herdrSocket;
        assert.equal((await request('/api/threads/sub/history')).status, 404);
        assert.equal((await request('/api/threads/unknown/history')).status, 404);
        const page = await request('/api/threads/a/history');
        assert.equal(page.body.turns.length, 20);
        assert.equal(page.body.nextCursor, '20');
        assert.equal(JSON.stringify(page.body).includes('SECRET'), false);
        const older = await request('/api/threads/a/history?cursor=20');
        assert.equal(older.body.turns[0].id, 'turn-1');
        assert.equal(older.body.nextCursor, null);
        state.turns.get('a').push(...Array.from({ length: 23 }, (_, n) => state.makeTurn(n + 27)));
        const catchup = await request('/api/threads/a/history?until=turn-26');
        assert.equal(catchup.body.turns.at(-1).id, 'turn-49');
        assert(catchup.body.turns.some(turn => turn.id === 'turn-26'));
        state.failHistory = true;
        assert.equal((await request('/api/threads/a/history')).status, 502);
        state.failHistory = false;
    });
    await t.test('approval checks, validation and exactly one enqueue per idle operation ID', async () => {
        for (const activeFlags of [['waitingOnApproval'], ['waitingOnUserInput']]) {
            state.threads.get('a').status = { type: 'active', activeFlags };
            const result = await request('/api/threads/a/send', { requestId: `busy_${activeFlags.join('') || 'working'}_1234567890`, text: '次の指示' });
            assert.equal(result.body.state, 'failed');
        }
        state.threads.get('a').status = { type: 'idle' };
        for (const text of ['', 'x'.repeat(32001), '\u0000', '\u001b[200~', '\u0085', '\r']) assert.equal((await request('/api/threads/a/send', { requestId: 'input_123456789012345', text })).status, 400);
        const body = { requestId: 'message_123456789012345', text: '同じ会話への指示' };
        const first = await request('/api/threads/a/send', body);
        assert.equal(first.body.state, 'succeeded');
        const duplicate = await request('/api/threads/a/send', body);
        assert.equal(duplicate.body.state, 'succeeded');
        assert.equal(state.calls.filter(call => call.method === 'thread/queue/add').length, 1);
        const add = state.calls.find(call => call.method === 'thread/queue/add');
        assert.equal(add.params.threadId, 'a');
        assert.equal(add.params.clientUserMessageId, body.requestId);
        assert.equal(state.calls.some(call => ['turn/start', 'thread/start', 'thread/resume', 'thread/fork'].includes(call.method)), false);
        assert.equal((await request('/api/threads/a/send', { ...body, text: '別の内容' })).status, 409);
        state.queue.push({ id: 'q2', clientUserMessageId: 'other', input: [{ type: 'text', text: '待機中の指示' }] });
        assert.equal((await request('/api/threads/a/state')).body.queue.length, 2);
        assert.equal((await request('/api/threads/a/send', { requestId: 'blocked_queue_123456789', text: '追加' })).body.state, 'failed');
    });
    await t.test('unknown outcomes retain deduplication for queue and terminal delivery', async () => {
        for (const active of [false, true]) {
            state.queue = []; state.ignoreAdd = !active; state.ignoreInput = active;
            state.threads.get('a').status = active ? { type: 'active', activeFlags: [] } : { type: 'idle' };
            const body = { requestId: `unknown_${active}_123456789012345`, text: '結果不明' };
            const [first, concurrent] = await Promise.all([request('/api/threads/a/send', body), request('/api/threads/a/send', body)]);
            assert.equal(first.body.state, 'unknown');
            assert(['processing', 'unknown'].includes(concurrent.body.state));
            assert.equal((await request(`/api/operations/${body.requestId}`)).body.state, 'unknown');
            assert.equal((await request('/api/threads/a/send', body)).body.state, 'unknown');
            assert.equal(active ? state.writes.length : state.queue.filter(item => item.clientUserMessageId === body.requestId).length, 1);
        }
    });
});

test('processing messages use one bracketed paste and Enter while queued work remains pending', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { request, state } = f;
    await request('/api/threads');
    state.threads.get('a').status = { type: 'active', activeFlags: [] };
    state.panes[0].agent_status = 'working';
    state.queue = [{ id: 'existing', input: [{ type: 'text', text: '待機中の指示' }] }];
    for (const [index, text] of ['方針を変えてください', '1行目の指示\n2行目の指示'].entries()) {
        const body = { requestId: `steering_${index}_1234567890`, text };
        assert.equal((await request('/api/threads/a/send', body)).body.state, 'succeeded');
        assert.equal((await request('/api/threads/a/send', body)).body.state, 'succeeded');
        assert.deepEqual(state.writes.at(-1), { pane_id: 'w1:p1', text: '\x1b[200~' + text + '\x1b[201~', keys: ['Enter'] });
        assert.equal((await request('/api/threads/a/send', { ...body, text: '別の指示' })).status, 409);
    }
    assert.equal(state.writes.length, 2);
    assert.equal(state.calls.some(call => call.method.startsWith('thread/queue/')), false);
    assert(state.herdrCalls.filter(call => call.method === 'pane.read').every(call => call.params.format === 'ansi' && call.params.strip_ansi === false));
});

test('processing messages reject PC drafts, CLI commands and unrecognized input areas', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { request, state } = f;
    await request('/api/threads');
    state.threads.get('a').status = { type: 'active', activeFlags: [] };
    const screens = [
        codexScreen('PCの下書き', false),
        codexScreen('Ask Codex to do anything', false),
        codexScreen('別のplaceholder', false),
        codexScreen('下書き\n  続き', false),
        codexScreen('   ', false),
        '› 履歴の発言\n• 処理結果',
        codexScreen().replace(/\x1b\[[\d;]*m/g, ''),
        codexScreen() + '\n› 別の入力欄',
    ];
    for (const [index, screen] of screens.entries()) {
        state.ansiScreen = screen;
        const result = await request('/api/threads/a/send', { requestId: `draft_${index}_1234567890`, text: 'スマホの指示' });
        assert.equal(result.body.state, 'failed');
        assert.match(result.body.message, /端末/);
    }
    state.ansiScreen = codexScreen('任意の薄い案内');
    for (const [index, text] of ['  /exit', '!ls'].entries()) {
        assert.equal((await request('/api/threads/a/send', { requestId: `cli_command_${index}_1234567890`, text })).body.state, 'failed');
    }
    const duplicate = { ...state.panes[0], pane_id: 'duplicate', terminal_id: 'duplicate', tab_id: 'duplicate' };
    state.panes.push(duplicate);
    assert.equal((await request('/api/threads/a/send', { requestId: 'ambiguous_pane_1234567890', text: 'スマホの指示' })).body.state, 'failed');
    assert.equal(state.writes.length, 0);
});

test('processing delivery rechecks process, conversation and waiting state after reading the input', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { request, state } = f;
    await request('/api/threads');
    const original = structuredClone({ process: state.process, pane: state.panes[0], resources: state.resources });
    const changes = [
        () => { state.process.foreground_processes = [{ pid: 100, name: 'zsh', argv: ['zsh'] }]; },
        () => { state.process.foreground_processes[0].pid = 250; },
        () => { state.panes[0].terminal_id = 'replacement'; },
        () => { state.resources.get(200).threadIds = new Set(['other']); },
        () => { state.threads.get('a').status = { type: 'active', activeFlags: ['waitingOnApproval'] }; },
        () => { state.panes[0].agent_status = 'unknown'; },
        () => { state.panes[0].agent_status = 'blocked'; },
        () => { state.threads.get('a').status = { type: 'idle' }; state.panes[0].agent_status = 'idle'; },
    ];
    for (const [index, change] of changes.entries()) {
        state.process = structuredClone(original.process); state.panes[0] = structuredClone(original.pane); state.resources = structuredClone(original.resources);
        state.threads.get('a').status = { type: 'active', activeFlags: [] };
        state.panes[0].agent_status = 'working';
        const gate = { ...Promise.withResolvers(), paneId: 'w1:p1', entered: Promise.withResolvers() };
        state.readGate = gate;
        const sending = request('/api/threads/a/send', { requestId: `changed_target_${index}_1234567890`, text: '同じCodexへの指示' });
        await gate.entered.promise;
        change(); gate.resolve();
        const result = await sending;
        assert.equal(result.body.state, index === changes.length - 1 ? 'succeeded' : 'failed');
    }
    assert.equal(state.writes.length, 1);
});

test('processing messages and terminal actions reject concurrent input on the same pane', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { request, state } = f;
    await request('/api/threads');
    for (const thread of state.threads.values()) thread.status = { type: 'active', activeFlags: [] };
    state.panes.forEach(pane => { pane.agent_status = 'working'; });
    const binding = (await request('/api/threads/a/bind', { paneId: 'w1:p1' })).body;
    for (const terminalFirst of [false, true]) {
        const view = (await request(`/api/threads/a/terminal?bindingId=${binding.bindingId}`)).body;
        const terminal = { requestId: `terminal_lock_${terminalFirst}_1234567890`, bindingId: binding.bindingId, viewId: view.viewId, text: '端末入力' };
        const message = { requestId: `message_lock_${terminalFirst}_1234567890`, text: '追加指示' };
        const gate = { ...Promise.withResolvers(), paneId: 'w1:p1', entered: Promise.withResolvers() };
        state.readGate = gate;
        const first = request(`/api/threads/a/${terminalFirst ? 'terminal-input' : 'send'}`, terminalFirst ? terminal : message);
        await gate.entered.promise;
        assert.equal((await request(`/api/threads/a/${terminalFirst ? 'send' : 'terminal-input'}`, terminalFirst ? message : terminal)).body.state, 'failed');
        assert.equal((await request('/api/threads/b/send', { requestId: `other_pane_${terminalFirst}_1234567890`, text: '別の端末への指示' })).body.state, 'succeeded');
        gate.resolve();
        assert.equal((await first).body.state, 'succeeded');
    }
    assert.equal(state.writes.filter(write => write.pane_id === 'w1:p1').length, 2);
    assert.equal(state.writes.filter(write => write.pane_id === 'w2:p2').length, 2);
});

test('terminal identity, per-action approval, validation and deduplication through Unix socket', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { request, state } = f;
    await request('/api/threads');
    assert.deepEqual((await request('/api/threads/a/panes')).body.panes.map(pane => pane.title), ['Codex · agent-monitor']);
    assert.equal((await request('/api/threads/a/bind', { paneId: 'w2:p2' })).status, 409);
    assert.equal((await request('/api/threads/a/bind', { paneId: 'unknown' })).status, 409);
    const bind = async () => (await request('/api/threads/a/bind', { paneId: 'w1:p1' })).body;
    let binding = await bind();
    const read = async () => (await request(`/api/threads/a/terminal?bindingId=${binding.bindingId}`)).body;
    let view = await read();
    const input = extras => ({ requestId: 'terminal_12345678901234', bindingId: binding.bindingId, viewId: view.viewId, text: '回答', ...extras });
    assert.equal((await request('/api/threads/b/terminal-input', input())).body.state, 'failed');
    for (const text of ['hello\n', '\u001b[31m', '\u0085', 'x'.repeat(4001)]) {
        assert.equal((await request('/api/threads/a/terminal-input', input({ text }))).status, 400);
    }
    assert.equal((await request('/api/threads/a/terminal-input', input({ text: undefined, key: 'Ctrl-D' }))).status, 400);
    assert.equal((await request('/api/threads/a/terminal-input', input({ text: undefined, key: 'Ctrl-C' }))).status, 400);
    assert.equal((await request('/api/threads/a/terminal-input', input({ requestId: 'unconfirmed_1234567890', viewId: 'old-view' }))).body.state, 'failed');
    const good = input({ requestId: 'valid_terminal_1234567890' });
    assert.equal((await request('/api/threads/a/terminal-input', good)).body.state, 'succeeded');
    assert.equal((await request('/api/threads/a/terminal-input', good)).body.state, 'succeeded');
    assert.deepEqual(state.writes, [{ pane_id: 'w1:p1', text: '回答' }]);
    for (const [key, deliveredKey] of [['Enter', 'Enter'], ['Ctrl-C', 'ctrl+c']]) {
        view = await read();
        assert.equal((await request('/api/threads/a/terminal-input', input({ requestId: `key_${key}_1234567890`, text: undefined, key, confirmInterrupt: key === 'Ctrl-C' }))).body.state, 'succeeded');
        assert.deepEqual(state.writes.at(-1), { pane_id: 'w1:p1', keys: [deliveredKey] });
    }
    view = await read(); state.screen += '\n対象が更新されました';
    assert.equal((await request('/api/threads/a/terminal-input', input({ requestId: 'changed_screen_12345678' }))).body.state, 'failed');
    const originalProcess = structuredClone(state.process);
    for (const mutate of [() => { state.panes[0].terminal_id = 'replacement'; }, () => { state.process.shell_pid++; }, () => { state.process.foreground_processes[0].argv = ['other']; }, () => { state.process.foreground_processes[0].pid = 202; state.resources.set(202, state.resources.get(200)); }]) {
        state.process = structuredClone(originalProcess);
        state.panes[0].terminal_id = 'term1';
        binding = await bind(); view = await read(); mutate();
        assert.equal((await request('/api/threads/a/terminal-input', input({ requestId: `identity_${state.writes.length}_${Date.now()}` }))).body.state, 'failed');
        assert.equal((await read()).error, '端末を選び直してください。');
    }
    state.process = originalProcess;
    assert.equal(state.writes.length, 3);
    state.panes[0].agent_session = { value: 'stale-session' };
    binding = await bind(); view = await read();
    assert.equal((await request('/api/threads/a/terminal-input', input({ requestId: 'automatic_1234567890', text: undefined, key: 'Escape' }))).body.state, 'succeeded');
    await request('/api/threads/a/unbind', { bindingId: binding.bindingId });
    assert.equal((await request(`/api/threads/a/terminal?bindingId=${binding.bindingId}`)).status, 409);
});

test('Herdr discovers embedded CLI sessions and shared queue survives HTTP disconnect', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { request, state } = f;
    state.threads.set('embedded', { id: 'embedded', name: 'Embedded CLI', cwd: '/projects/embedded', source: 'cli', status: { type: 'notLoaded' } });
    state.turns.set('embedded', [state.makeTurn(200, '接続前の出力')]);
    state.panes.push({ pane_id: 'w3:p3', terminal_id: 'term3', tab_id: 'tab3', workspace_id: 'w3', terminal_title_stripped: 'Embedded CLI', agent_status: 'idle', agent_session: { agent: 'codex', value: 'embedded' } });
    const embedded = state.panes.at(-1);
    state.processes.set(embedded.pane_id, { shell_pid: 102, foreground_process_group_id: 202, foreground_processes: [{ pid: 202, name: 'codex', argv: ['codex'] }] });
    const embeddedProcess = structuredClone(state.processes.get(embedded.pane_id));
    state.resources.set(202, { ports: new Set(), threadIds: new Set(['embedded']) });
    const list = await request('/api/threads');
    assert.deepEqual(list.body.threads.map(thread => thread.id), ['a', 'b', 'embedded']);
    assert.equal(list.body.threads.at(-1).status.type, 'idle');
    assert.equal((await request('/api/threads/embedded/history')).body.turns[0].items[1].text, '接続前の出力');
    const body = { requestId: 'embedded_123456789012345', text: '共有queueへ送る指示' };
    const sent = await request('/api/threads/embedded/send', body, { Connection: 'close' });
    assert.equal(sent.body.state, 'succeeded');
    assert.equal(state.calls.find(call => call.method === 'thread/queue/add').params.threadId, 'embedded');
    assert.equal((await request('/api/threads/embedded/state')).body.queue[0].clientUserMessageId, body.requestId);
    const disconnected = new Promise(resolve => f.service.codex.ws.once('close', resolve));
    f.service.codex.close();
    await disconnected;
    embedded.agent_status = 'working';
    state.queue = [];
    state.turns.get('embedded').push(state.makeTurn(201, 'PCで完了した出力'));
    embedded.agent_status = 'done';
    const reconnected = await request('/api/threads/embedded/history');
    assert.equal(reconnected.status, 200);
    assert.equal(reconnected.body.turns.at(-1).items[1].text, 'PCで完了した出力');
    assert.equal((await request('/api/threads/embedded/state')).body.thread.status.type, 'idle');
    assert.equal(state.calls.some(call => ['turn/start', 'thread/start', 'thread/resume', 'thread/fork'].includes(call.method)), false);
    for (const [agentStatus, expectedType] of [['working', 'active'], ['blocked', 'active'], ['unknown', 'unknown'], ['idle', 'idle'], ['done', 'idle']]) {
        embedded.agent_status = agentStatus;
        state.queue = [];
        const current = await request('/api/threads/embedded/state');
        assert.equal(current.body.thread.status.type, expectedType);
        if (agentStatus === 'blocked') assert.deepEqual(current.body.thread.status.activeFlags, ['waitingOnApprovalOrInput']);
        const result = await request('/api/threads/embedded/send', { ...body, requestId: `status_${agentStatus}_1234567890` });
        assert.equal(result.body.state, ['working', 'idle', 'done'].includes(agentStatus) ? 'succeeded' : 'failed');
    }
    assert.equal(state.calls.some(call => call.method === 'thread/unsubscribe' && call.params.threadId === 'embedded'), false);
    state.processes.set(embedded.pane_id, { shell_pid: 300, foreground_processes: [{ pid: 300, name: 'zsh', argv: ['zsh'] }] });
    assert.equal((await request('/api/threads/embedded/state')).status, 409);
    assert.equal((await request('/api/threads/embedded/send', { ...body, requestId: 'shell_only_1234567890' })).body.state, 'failed');
    const stale = { ...embedded, pane_id: 'stale', agent_session: { agent: 'codex', value: 'old-session' } };
    state.panes.push(stale); state.processes.set(stale.pane_id, { foreground_processes: [] });
    assert.deepEqual((await request('/api/threads')).body.threads.map(thread => thread.id), ['a', 'b']);
    assert.equal(state.calls.some(call => call.method === 'thread/read' && call.params.threadId === 'old-session'), false);
    state.processes.set(embedded.pane_id, embeddedProcess);
    assert.equal((await request('/api/threads')).body.threads.some(thread => thread.id === 'embedded'), true);
    embedded.agent_session.value = 'different-session';
    assert.equal((await request('/api/threads/embedded/history')).status, 200);
    state.queue = [];
    assert.equal((await request('/api/threads/embedded/send', { ...body, requestId: 'changed_session_1234567890' })).body.state, 'succeeded');
    embedded.agent_session.value = 'embedded';
    state.failHerdr = true;
    assert.equal((await request('/api/threads/a/history')).status, 502);
    assert.equal((await request('/api/threads')).status, 502);
    assert.equal((await request('/api/threads/embedded/send', { ...body, requestId: 'herdr_down_1234567890' })).body.state, 'failed');
    f.service.herdr.socketPath = undefined;
    assert.equal((await request('/api/threads/a/history')).status, 502);
});

test('current Herdr state and daemon activity override idle and internal sessions stay hidden', async t => {
    const f = await fixture(); t.after(() => f.close());
    const { request, state } = f;
    state.panes[0].agent_session = { agent: 'codex', value: 'a' };
    const cases = [
        [{ type: 'idle' }, 'working', 'active', 'succeeded'],
        [{ type: 'idle' }, 'blocked', 'active', 'failed'],
        [{ type: 'idle' }, 'unknown', 'unknown', 'failed'],
        [{ type: 'active', activeFlags: [] }, 'idle', 'active', 'succeeded'],
        [{ type: 'active', activeFlags: [] }, 'unknown', 'active', 'failed'],
        [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, 'done', 'active', 'failed'],
    ];
    for (const [index, [daemon, herdr, expected, resultState]] of cases.entries()) {
        state.threads.get('a').status = daemon; state.panes[0].agent_status = herdr;
        await request('/api/threads');
        assert.equal((await request('/api/threads/a/state')).body.thread.status.type, expected);
        const result = await request('/api/threads/a/send', { requestId: `conflicting_${index}_1234567890`, text: '状態を再確認する指示' });
        assert.equal(result.body.state, resultState);
    }
    state.panes[0].agent_session.value = 'sub';
    assert.equal((await request('/api/threads')).body.threads.some(thread => thread.id === 'sub'), false);
    assert.equal(state.calls.some(call => call.method === 'thread/queue/add'), false);
});
