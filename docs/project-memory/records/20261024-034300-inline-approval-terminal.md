---
type: "decision"
status: "proposed"
status_reason: ""
scope: "承認操作と端末表示"
created_at: "2026-10-24"
last_reviewed: "2026-10-24"
review_after: ""
verification: "test"
evidence: ["web/app.js", "src/service.js", "test/ui.test.js"]
supersedes: ["docs/project-memory/records/20261016-023600-history-and-terminal.md"]
superseded_by: ""
---

# 確認済み端末による承認操作

## Context

既存の判断候補では、承認と特殊キーの操作に別の端末画面を使う。
スマホで会話を読んでいるとき、承認待ちのたびに画面を切り替える必要があった。
端末との対応が曖昧な会話もあり、表示と入力の対象を一致させる必要がある。

## Decision

選択したCodex会話が承認待ちで、対応する端末が1つに確定したとき、端末表示とEnter操作を会話画面に置く。
既存の端末関連付け、表示ID、送信結果の管理を共有する。
表示から25秒を過ぎたらEnterを止め、利用者が表示を更新してから操作する。
対応端末が確定しない場合や別のキーが必要な場合は、端末画面を使う。

## Rationale

端末表示をそのまま示すと、利用者は選択中の項目を確認してからEnterを送れる。
関連付けと表示IDの検証を共有すれば、会話や端末が切り替わった後の誤送信を防げる。
選択肢の文言を解析して承認種別を推測する方法は、CLIの表示変更で対応先を誤るおそれがある。
短い有効期間と手動更新により、古い表示を見たまま操作する時間を制限できる。

## Revisit when

Codexが、既存CLIの承認を会話IDで操作できる公開APIを提供したとき。
