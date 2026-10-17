import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePresence, isCodexTui, originPort, readPresence } from '../src/presence.js';

test('lsof resources keep LISTEN sockets and writer lock FDs separate from connections and filenames', () => {
    const id = '0199aabb-ccdd-7000-8000-0123456789ab';
    const resources = parsePresence([
        'p42', 'ccodex', 'fcwd', `n/home/user/.codex/thread-writer-locks/${id}.lock`,
        'f5', 'n127.0.0.1:41001', 'TST=LISTEN',
        'f6', 'n127.0.0.1:50000->127.0.0.1:41002', 'TST=ESTABLISHED',
        'f7', 'n[::1]:41003', 'TST=LISTEN',
        'f8', `n/home/user/.codex/thread-writer-locks/${id}.lock`,
        'f9', 'n/home/user/.codex/thread-writer-locks/.coordination.lock',
        'p43', 'ccodex', 'f5', 'n*:41004', 'TST=LISTEN',
    ].join('\n'));
    assert.deepEqual([...resources.get(42).ports], [41001, 41003]);
    assert.deepEqual([...resources.get(42).threadIds], [id]);
    assert.deepEqual([...resources.get(43).ports], [41004]);
    assert.deepEqual([...resources.get(43).threadIds], []);
    assert.deepEqual([...parsePresence(`p42\nfcwd\nn/home/thread-writer-locks/${id}.lock\n`).get(42).threadIds], []);
});

test('presence accepts only positive integer TUI PIDs and loopback origins', async () => {
    assert.equal(isCodexTui({ pid: 42, argv: ['/opt/bin/codex', '--model', 'gpt-6.1-sol'] }), true);
    assert.equal(isCodexTui({ pid: 42, argv: ['codex', 'resume', 'id'] }), true);
    for (const option of ['--cd', '--profile', '--model', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '--local-provider', '--sandbox', '--add-dir', '--ask-for-approval', '-C', '-p', '-m', '-c', '-s', '-a']) {
        for (const args of [[option, 'review'], [`${option}=review`]]) {
            assert.equal(isCodexTui({ pid: 42, argv: ['codex', ...args] }), true);
            assert.equal(isCodexTui({ pid: 42, argv: ['codex', ...args, 'exec'] }), false);
        }
    }
    for (const option of ['--image', '-i']) {
        assert.equal(isCodexTui({ pid: 42, argv: ['codex', option, 'review', 'exec'] }), true);
        assert.equal(isCodexTui({ pid: 42, argv: ['codex', `${option}=review`, 'exec'] }), false);
    }
    assert.equal(isCodexTui({ pid: 42, argv: ['codex', '--', 'exec', '--profile', 'review'] }), true);
    for (const process of [{ pid: 42, argv: ['codex', 'app-server'] }, { pid: 42, argv: ['codex', 'exec', 'prompt'] }, { pid: 42, argv: ['zsh'] }, { pid: -1, argv: ['codex'] }]) {
        assert.equal(isCodexTui(process), false);
    }
    for (const origin of ['https://example.com:41001', 'http://127.0.0.1:41001/path', 'http://user@localhost:41001', null]) assert.equal(originPort(origin), null);
    assert.equal(originPort('http://127.0.0.1:41001'), 41001);
    assert.equal(originPort('http://[::1]:41002'), 41002);
    await assert.rejects(readPresence([1, '2;echo']), /Invalid foreground PID/);
    assert.deepEqual(await readPresence([]), new Map());
});
