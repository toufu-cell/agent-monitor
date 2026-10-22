---
type: "decision"
status: "proposed"
status_reason: ""
scope: "モバイル画面からの画像送信とPC側の画像保存"
created_at: "2026-10-22"
last_reviewed: "2026-10-22"
review_after: ""
verification: "test"
evidence:
  - "src/service.js"
  - "web/app.js"
  - "docs/usage.md"
  - "test/integration.test.js"
supersedes: []
superseded_by: ""
---

# 画像はPCに保存し、送信先に合わせて渡す

## Context

モバイル画面からCodexとClaude Codeの既存会話へ画像を送る必要がある。
待機中のCodexはqueue APIで画像を受け取り、処理中のCLIには端末入力を送る。
端末へ送る時点では画像の実体をPCから読める必要がある。

## Decision

画像を認証付きでPCの私有ディレクトリへ保存する。
待機中のCodexには`localImage`で渡し、処理中のCodexとClaude Codeには絶対パスを伝える。
送信結果が不明な画像は削除対象から保護し、PCで処理を確認してから手動で削除する。
通常の画像は送信時に有効期間を更新し、期限後の次のアップロードで削除する。

## Rationale

同じ画像を2つの方法で送るため、PC側のファイルを共通の受渡し点にした。
CLIへの入力結果が不明な時点でファイルを消すと、後から画像を読む処理が失敗する。
保護したファイルは自動削除されないため、利用ガイドに確認と削除の手順を残した。

## Revisit when

送信結果をCLI側から確実に確認できる仕組みを追加する場合は、保護解除の自動化を検討する。
