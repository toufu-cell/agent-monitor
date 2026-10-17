---
type: "decision"
status: "proposed"
status_reason: "通常の実装作業から記録した判断候補"
scope: "会話の閲覧と入力"
created_at: "2026-10-16"
last_reviewed: "2026-10-16"
review_after: ""
verification: "user-confirmed"
evidence: ["user-confirmed:2026-10-16", "README.md", "src/service.js", "web/app.js"]
supersedes: []
superseded_by: ""
---

# 履歴と端末の役割

## Context

利用者はPCで起動したCodex CLIをスマホから操作したい。
既存ツールでは、会話の探しにくさと、端末の現在表示から過去ログを読めなくなることが問題だった。
接続前の会話も読めることが、端末表示の再現より優先される。

## Decision

通常画面では永続化された会話を整形して表示し、同じ会話へ次の指示を送る。
承認、質問への回答、特殊キーが必要な場合は、別の端末画面を開いて操作する。
一覧、会話、入力欄を主な導線として維持する。

## Rationale

端末の現在表示だけでは、接続前の出力や表示領域から流れた出力を読めない。
会話履歴を中心にすれば、過去を読んでいる間にもPCで作業を続けられる。
承認や質問などCLI固有の操作には端末画面で対応する。
履歴と端末の両方を扱う負担はあるが、閲覧の継続とPCの操作機能を両立できる。

## Revisit when

Codex側に、既存CLIの承認や質問を同じ会話IDで操作できる公開APIが揃ったとき。
