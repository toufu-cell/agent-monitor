import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT = 2000;
const LIMIT_MESSAGE = '取得上限に達しました。PCで残りの変更を確認してください。';
const UNAVAILABLE = {
    binary: 'バイナリまたはUTF-8以外のファイルのため、内容を表示できません。',
    symlink: 'シンボリックリンクのため、内容を表示できません。',
    large: '256KiBを超えるファイルのため、内容を表示できません。',
    special: '通常ファイル以外のため、内容を表示できません。',
};

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function validPath(path) {
    return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0')
        && !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function limited(error) { return error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ETIMEDOUT'; }

function gitReader() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const configEnv = { ...env };
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
        if (process.env[key] !== undefined) configEnv[key] = process.env[key];
    }
    Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
    const options = ['--no-pager', '--no-optional-locks', '--literal-pathspecs',
        '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
        '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never'];
    const deadline = Date.now() + 8000;
    const git = async (cwd, args, maxBuffer = MAX_OUTPUT_BYTES, acceptedCodes = [], environment = env) => {
        const timeout = Math.min(TIMEOUT, deadline - Date.now());
        if (timeout <= 0) throw Object.assign(new Error(LIMIT_MESSAGE), { code: 'ETIMEDOUT' });
        try { return (await execute('git', [...options, ...args], { cwd, env: environment, encoding: 'buffer', timeout, maxBuffer })).stdout; }
        catch (error) { if (acceptedCodes.includes(error.code)) return error.stdout; throw error; }
    };
    git.prepare = async cwd => {
        // Preserve the effective ignore path while isolating all other global configuration.
        const excludes = await git(cwd, ['config', '--null', '--path', '--get', 'core.excludesFile'], 64 * 1024, [1], configEnv);
        if (excludes.length) options.push('-c', `core.excludesFile=${excludes.toString('utf8').replace(/\0$/, '')}`);
        // status can invoke clean filters while checking the index against the worktree.
        const keys = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], 64 * 1024, [1]);
        for (const key of keys.toString('utf8').split('\0').filter(Boolean)) {
            options.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
        }
    };
    return git;
}

function text(bytes) {
    if (bytes.includes(0)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

async function worktreeFile(root, path) {
    const fullPath = join(root, path);
    let cursor = root;
    for (const part of path.split('/').slice(0, -1)) {
        cursor = join(cursor, part);
        const info = await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info) return { bytes: null };
        if (info.isSymbolicLink()) return { reason: 'symlink' };
        if (!info.isDirectory()) return { bytes: null };
    }
    const parent = await realpath(dirname(fullPath)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
    if (!parent) return { bytes: null };
    if (relative(root, parent).split('/').includes('..')) return { reason: 'symlink' };
    const info = await lstat(fullPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return { bytes: null };
    if (info.isSymbolicLink()) return { reason: 'symlink' };
    if (!info.isFile()) return { reason: 'special' };
    if (info.size > MAX_FILE_BYTES) return { reason: 'large' };
    const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        if (!(await handle.stat()).isFile()) return { reason: 'special' };
        const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
            const read = await handle.read(bytes, length, bytes.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
        }
        if (length > MAX_FILE_BYTES) return { reason: 'large' };
        return { bytes: bytes.subarray(0, length) };
    } finally { await handle.close(); }
}

async function fileDiff(git, root, file, hasHead) {
    const current = await worktreeFile(root, file.path);
    if (current.reason) return { reason: current.reason };
    let previous = null;
    if (hasHead && file.status !== '??') {
        const entry = await git(root, ['ls-tree', '-z', 'HEAD', '--', file.path]);
        if (entry.length) {
            const [mode, , object] = entry.toString('utf8').split('\t')[0].split(' ');
            if (mode === '120000') return { reason: 'symlink' };
            if (mode === '160000') return { reason: 'special' };
            const size = Number((await git(root, ['cat-file', '-s', object])).toString('ascii'));
            if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) return { reason: 'large' };
            previous = await git(root, ['cat-file', 'blob', object], MAX_FILE_BYTES + 1);
        }
    }
    const before = previous ?? Buffer.alloc(0), after = current.bytes ?? Buffer.alloc(0);
    if (text(before) === null || text(after) === null) return { reason: 'binary' };
    // Diff snapshots outside the repository to isolate attributes and later path changes.
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitor-diff-'));
    try {
        await writeFile(join(directory, 'before'), before, { mode: 0o600 });
        await writeFile(join(directory, 'after'), after, { mode: 0o600 });
        const output = await git(directory, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color',
            '--ignore-submodules=all', '--no-renames', '--', 'before', 'after'], MAX_OUTPUT_BYTES, [1]);
        const diff = output.toString('utf8');
        const hunk = diff.indexOf('@@');
        if (hunk < 0) return { diff: '', message: '内容の差分はありません。ファイルの状態が変更されています。' };
        const path = JSON.stringify(file.path);
        return { diff: `--- ${previous === null ? '/dev/null' : `a/${path}`}\n+++ ${current.bytes === null ? '/dev/null' : `b/${path}`}\n${diff.slice(hunk)}` };
    } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function readChanges(cwd, path = null) {
    if (path !== null && !validPath(path)) throw httpError(400, '変更一覧にあるリポジトリ相対パスを指定してください。');
    const git = gitReader();
    let root;
    try {
        if (!cwd || !isAbsolute(cwd)) return { state: 'notGit', files: [], message: 'この会話の作業ディレクトリはGit管理外です。' };
        root = (await git(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\n$/, '');
        root = await realpath(root);
        await git.prepare(root);
        const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all']);
        let decoded;
        try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(status); }
        catch { return { state: 'limited', root, files: [], message: 'UTF-8以外のファイル名があるため、PCで変更を確認してください。' }; }
        const entries = decoded.split('\0').filter(Boolean);
        const files = entries.slice(0, MAX_FILES).map(entry => ({ path: entry.slice(3), status: entry.slice(0, 2) }));
        const result = { state: 'ready', root, files, limited: entries.length > MAX_FILES };
        if (result.limited) result.message = LIMIT_MESSAGE;
        if (path === null) return result;
        const file = files.find(file => file.path === path);
        if (!file) throw httpError(409, '変更一覧が古くなりました。「更新」で一覧を取得し直してください。');
        const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], 1024, [1]);
        const detail = await fileDiff(git, root, file, head.length > 0);
        return { state: 'ready', root, ...file, ...detail, ...(detail.reason ? { message: UNAVAILABLE[detail.reason] } : {}) };
    } catch (error) {
        if (error.status) throw error;
        if (limited(error)) return { state: 'limited', root, files: [], message: LIMIT_MESSAGE };
        if (error.code === 'ENOENT' || /not a git repository|cannot change to/.test(error.stderr?.toString() || '')) {
            return { state: 'notGit', files: [], message: 'この会話の作業ディレクトリはGit管理外です。' };
        }
        if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw httpError(409, 'ファイルの状態が変わりました。「更新」で一覧を取得し直してください。');
        throw httpError(422, 'Gitの変更を取得できません。PCで作業ディレクトリとGitの状態を確認してください。');
    }
}
