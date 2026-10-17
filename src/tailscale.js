import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function tailscaleJSON(run) {
    let executable = 'tailscale';
    let selected = false;
    return async args => {
        const options = { timeout: 5000, maxBuffer: 1024 * 1024 };
        let result;
        try { result = await run(executable, args, options); }
        catch (error) {
            if (selected || error.code !== 'ENOENT' || executable !== 'tailscale') throw error;
            executable = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
            result = await run(executable, args, options);
        }
        selected = true;
        return JSON.parse(result.stdout);
    };
}

export async function tailscaleServe(port, run = promisify(execFile)) {
    const json = tailscaleJSON(run);
    let status;
    try { status = await json(['status', '--json']); }
    catch { throw new Error('Tailscaleの状態を取得できません。Tailscale.appで接続を有効にしてください。CLIはPATHまたは/Applications/Tailscale.app/Contents/MacOS/Tailscaleに必要です。'); }
    if (status?.BackendState !== 'Running') throw new Error('Tailscaleが停止しています。Tailscale.appで接続を有効にしてから起動し直してください。');
    const dnsName = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : '';
    const login = status.Self?.UserID == null ? undefined : status.User?.[status.Self.UserID]?.LoginName;
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(dnsName)
        || typeof login !== 'string' || !login || /[\s,\x00-\x1f\x7f]/.test(login)) {
        throw new Error('TailscaleのDNS名と本人のLoginNameを確認できません。Tailscale.appのログイン状態とMagicDNSを確認してください。');
    }
    const origin = new URL(`https://${dnsName}`).origin;
    const listener = `${new URL(origin).hostname}:443`;
    const proxy = `http://127.0.0.1:${port}`;
    const setup = `tailscale serve --bg --https=443 ${proxy}`;
    const guidance = `設定を確認してください。永続化コマンド: ${setup}。このPCではtailscaleの代わりに/Applications/Tailscale.app/Contents/MacOS/Tailscaleも使えます。初回は表示されるURLでHTTPSの利用を許可してください。`;
    let serve;
    try { serve = await json(['serve', 'status', '--json']); }
    catch { throw new Error(`Tailscale Serveの設定を取得できません。${guidance}`); }
    const foreground = Object.values(serve?.Foreground || {});
    if ([serve, ...foreground].some(config => config?.AllowFunnel?.[listener] === true)) {
        throw new Error(`このHTTPS接続先でFunnelが有効です。${listener}のFunnelを無効にしてから起動し直してください。`);
    }
    if (foreground.some(config => config?.TCP?.['443'] || config?.Web?.[listener])) {
        throw new Error(`HTTPS 443に一時的なForeground設定があります。そのServeコマンドを終了し、永続設定に切り替えてください。${guidance}`);
    }
    const tcp = serve?.TCP?.['443'];
    const handlers = serve?.Web?.[listener]?.Handlers;
    const root = handlers?.['/'];
    if (tcp?.HTTPS !== true || tcp.HTTP || tcp.TCPForward || tcp.TerminateTLS
        || !handlers || Object.keys(handlers).length !== 1 || root?.Proxy !== proxy || root.Path || root.Text || root.Redirect) {
        throw new Error(`Tailscale Serveには${origin}/から${proxy}へのHTTPS 443ルート転送が必要です。同じ接続先の追加ハンドラーも確認してください。${guidance}`);
    }
    return { origin, tailscaleLogin: login };
}
