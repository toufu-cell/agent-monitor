# 開発ガイド

[README](../README.md#開発)に検証コマンドをまとめています。

## テスト

`pnpm test`は、実際のHTTPとfakeのCodex WebSocket、Herdr Unix socketを通して動作を確認します。
Claude Codeのセッション一覧形式、JSONL履歴、DOMでの画面操作も対象です。

`pnpm test:browser`はGoogle Chromeで表示位置とスマホ幅の画面を確認します。
別の配置では`CHROME_PATH`で実行ファイルを指定してください。
画面の画像は`artifacts/`に出力します。

## 文章のチェック

`pnpm lint:text`は、共通のtextlint設定とグローバル環境の`@babel/parser`を使います。
READMEと実装内の文言を確認し、抽出元と結果を`artifacts/textlint-report.json`へ保存します。
`docs/`のMarkdownは共通設定で個別に確認します。

```sh
textlint --config ~/.codex/textlint/textlintrc-markdown.cjs --ignore-path /dev/null docs/usage.md docs/development.md
```
