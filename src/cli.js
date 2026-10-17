import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import QRCode from 'qrcode';
import { CodexClient, HerdrClient } from './rpc.js';
import { MonitorService } from './service.js';
import { createMonitorServer } from './server.js';
import { tailscaleServe } from './tailscale.js';
import { Notifications } from './notifications.js';

export function socketPaths(options, env = process.env, home = homedir()) {
    const codexHome = env.CODEX_HOME || join(home, '.codex');
    return {
        codex: options['codex-socket'] || env.CODEX_APP_SERVER_CONTROL_SOCKET || env.CODEX_APP_SERVER_CONTROL_SOCKET_PATH || join(codexHome, 'app-server-control', 'app-server-control.sock'),
        herdr: options['herdr-socket'] || env.HERDR_SOCKET_PATH,
    };
}

async function main() {
    const { values } = parseArgs({ options: {
        tailscale: { type: 'boolean', default: false },
        port: { type: 'string', default: '4317' },
        'codex-socket': { type: 'string' }, 'herdr-socket': { type: 'string' },
        help: { type: 'boolean', default: false },
    } });
    if (values.help) {
        console.log(`agent-monitor
agent-monitor --tailscale

HerdrのターミナルでHERDR_SOCKET_PATHを引き継いで実行します。
両モードとも127.0.0.1だけで接続を受け付けます。
終了: Ctrl+C

--tailscale          設定済みTailscale ServeのHTTPSで本人だけに接続を許可する
--port 4317          ポートを指定する
--codex-socket PATH  Codexのsocketを絶対パスで指定する
--herdr-socket PATH  Herdrのsocketを絶対パスで指定する
--help               使い方を表示する`);
        return;
    }
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('portには1から65535までの整数を指定してください。');
    const paths = socketPaths(values);
    if (!isAbsolute(paths.codex) || (paths.herdr && !isAbsolute(paths.herdr))) throw new Error('socketには絶対パスを指定してください。');
    const access = values.tailscale ? await tailscaleServe(port)
        : { origin: `http://127.0.0.1:${port}`, token: randomBytes(32).toString('base64url') };
    const codex = new CodexClient(paths.codex);
    const service = new MonitorService(codex, new HerdrClient(paths.herdr));
    const notifications = values.tailscale ? await new Notifications({ service, origin: access.origin }).open() : null;
    const server = createMonitorServer({ service, notifications, ...access });
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
    catch (error) { await notifications?.close(); codex.close(); throw error; }
    const url = values.tailscale ? access.origin : `${access.origin}/#${access.token}`;
    console.log(`Agent Monitor\n${url}`);
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    console.log(values.tailscale ? 'PCと同じTailscaleログインのスマホで接続してください。このHTTPS URLはブックマークできます。' : 'PC内で接続できます。スマホ接続にはTailscale Serveを設定して--tailscaleで起動してください。');
    if (!paths.herdr) console.log('端末操作を使う場合は--herdr-socketまたはHERDR_SOCKET_PATHを指定してください。');
    const stop = async () => { server.close(); server.closeAllConnections(); await notifications?.close(); codex.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
    main().catch(error => { console.error(error.code ? '起動できません。socketのパスとポートを確認してください。' : error.message); process.exitCode = 1; });
}
