---
type: "decision"
status: "proposed"
status_reason: ""
scope: "モバイルから受け取る画像の入力検証"
created_at: "2026-10-22"
last_reviewed: "2026-10-22"
review_after: ""
verification: "test"
evidence:
  - "src/service.js"
  - "test/integration.test.js"
supersedes: []
superseded_by: ""
---

# 画像を保存する前に全画素を読み取る

## Context

先頭の識別バイトだけを確認すると、途中で切れたJPEGやGIFも保存できた。
送信処理の成功後に画像を読み取れない可能性があった。

## Decision

アップロード時に`sharp`で画素を読み取り、宣言されたMIME型との一致を確認する。
GIFとWebPは全フレームを読み取る。
デコーダーが欠落を許すPNGのチャンクとGIFのブロックは、構造上の終端まで確認する。
展開時の画素数は6,400万画素を上限とし、GIFとWebPでは全フレームの合計に適用する。

## Rationale

形式ごとの構造だけを手作業で追っても、圧縮された画素の破損は確認できない。
実際にデコードすることで、保存前に読取り不能な画像を拒否できる。
デコードでメモリを使うため、ファイル容量とは別に画素数も制限する。
