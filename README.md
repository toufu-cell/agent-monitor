# Agent Monitor

PCのHerdrで開いているCodexとClaude Codeの会話を、スマホから読むための個人用ツールです。
プロジェクト別に会話を探し、過去の出力を読み、次の指示を送れます。
スマホを閉じても、PC側のCLIで作業が続きます。

## 必要環境

- macOSとHerdr
- Node.js 24以上とpnpm 10
- Codex CLI、または`claude agents --json`を実行できるClaude Code
- スマホ接続には、PCとスマホのTailscale

## インストールと起動

リポジトリのディレクトリで実行します。

1. `pnpm install`で依存を用意します。
2. `pnpm build`で画面をビルドします。
3. `mkdir -p ~/.local/bin`でコマンドの配置先を作ります。
4. `ln -s "$PWD/bin/agent-monitor" ~/.local/bin/agent-monitor`でシンボリックリンクを作ります。

`~/.local/bin`をPATHに含めて使います。
Node.jsがない場合は、`brew install node@24`で用意できます。

Herdr内でCodexまたはClaude Codeを起動し、Herdrの別ターミナルで実行します。

```sh
agent-monitor
```

起動出力のURLをPCのブラウザで開きます。
終了は起動したターミナルでCtrl+Cです。
ポートやsocketの指定は[接続設定](docs/usage.md#接続設定)を参照してください。

## スマホから接続する

通常起動のAgent Monitorが動いていれば、Ctrl+Cで終了しておきます。

1. PCのTailscale.appで接続を有効にします。
2. PCでHTTPSの転送先を設定します。

    ```sh
    tailscale serve --bg --https=443 http://127.0.0.1:4317
    ```

    初回は表示されたURLからHTTPSの利用を許可し、必要なら同じコマンドを再実行します。
    `tailscale`が見つからない場合は[接続設定](docs/usage.md#接続設定)を参照してください。

3. スマホのTailscaleに、PCと同じアカウントでログインします。
4. Herdrのターミナルで起動します。

    ```sh
    agent-monitor --tailscale
    ```

5. 起動出力のQRコードをスマホで読み取ります。

HTTPSのURLは再起動後も同じなので、ブックマークやホーム画面から使えます。
TailscaleのアクセスルールでPCのTCP 443を許可してください。
接続はPC所有者と同じTailscaleアカウントに限ります。
Funnelを無効にし、このHTTPS接続先のルートはAgent Monitor専用にします。

## 基本操作

1. プロジェクト名や会話名で検索します。
2. 会話を開き、必要なら「前の履歴を読む」で過去を追加します。
3. 「次の指示」に入力し、「指示を送信」を押します。

Enterは改行です。
処理中にも追加の指示を送れます。
Codexの質問は会話内で回答でき、承認や特殊キーの操作には「端末を開く」を使います。
新しいCodex会話の起動と、作業完了やCodexの質問の通知にも対応します。
「画像を選択」で画像を1枚添付し、指示と一緒に送れます。画像だけでも送信できます。
PNG、JPEG、WebP、GIFに対応し、上限は10MiBです。
送信時にPCへ保存し、有効期間は送信から30日です。期限切れの画像は次のアップロード時に削除します。
送信前の画像は会話を切り替えても保持します。ページを再読み込みしたら画像を選び直してください。
詳しい手順は[操作ガイド](docs/usage.md)を参照してください。

## 利用時の注意

- Herdrで現在開いていて、会話と端末の対応を確認できるCodexとClaude Codeが対象です。
- Codexの`/new`と`/resume`による会話切替は対象外です。再開するときはPCでCLIを終了して起動し直してください。
- 送信や起動の結果が不明になったら、PCで結果を確認してから画面の解除ボタンを押してください。サーバー再起動後の再送も、PCで確認してから行います。
- 誤送信を避けるため、スマホからの端末操作中はPC側で対象を切り替えないでください。
- PCとAgent Monitorの起動中に使えます。PC内のプロセスは信頼する前提です。通常起動のURLとQRコードは、PCを操作できる認証情報として扱ってください。

## 開発

```sh
pnpm build
pnpm check
pnpm test
pnpm test:browser
pnpm lint:text
```

検証内容と実行環境は[開発ガイド](docs/development.md)を参照してください。
