import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const execute = promisify(execFile);

export function isCodexTui(process) {
    if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || !Array.isArray(process.argv)) return false;
    const [command, ...args] = process.argv;
    if (typeof command !== 'string' || basename(command) !== 'codex') return false;
    const valueOptions = new Set(['--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '--model', '--local-provider', '--profile', '--sandbox', '--cd', '--add-dir', '--ask-for-approval', '-c', '-m', '-p', '-s', '-C', '-a']);
    const subcommands = new Set(['app-server', 'mcp-server', 'mcp', 'exec', 'e', 'review', 'login', 'logout', 'completion', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'features', 'help']);
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (typeof arg !== 'string') return false;
        if (arg === '--') return true;
        if (arg === '--image' || arg === '-i') {
            while (typeof args[index + 1] === 'string' && !args[index + 1].startsWith('-')) index++;
            continue;
        }
        if (valueOptions.has(arg)) { index++; continue; }
        if (arg.startsWith('-')) continue;
        return !subcommands.has(arg);
    }
    return true;
}

export function parsePresence(output) {
    const resources = new Map();
    let resource, fd;
    const finish = () => {
        if (!resource || !fd || !/^\d/.test(fd.number)) return;
        if (fd.listen) {
            const match = fd.name?.match(/^(?:127\.0\.0\.1|\[::1\]|\*):(\d+)$/);
            if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) resource.ports.add(Number(match[1]));
        }
        const lock = fd.name?.match(/\/thread-writer-locks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i);
        if (lock) resource.threadIds.add(lock[1]);
    };
    for (const line of output.split('\n')) {
        const value = line.slice(1);
        if (line[0] === 'p') {
            finish(); fd = null;
            const pid = Number(value);
            resource = /^\d+$/.test(value) && Number.isSafeInteger(pid) && pid > 0 ? { ports: new Set(), threadIds: new Set() } : null;
            if (resource) resources.set(pid, resource);
        } else if (line[0] === 'f') { finish(); fd = { number: value }; }
        else if (line[0] === 'n' && fd) fd.name = value;
        else if (line === 'TST=LISTEN' && fd) fd.listen = true;
    }
    finish();
    return resources;
}

export async function readPresence(pids) {
    if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid foreground PID');
    if (!pids.length) return new Map();
    const { stdout } = await execute('lsof', ['-nP', '-a', '-p', [...new Set(pids)].join(','), '-FpcfnT'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    return parsePresence(stdout);
}

export function originPort(origin) {
    try {
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return null;
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
        return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    } catch { return null; }
}
