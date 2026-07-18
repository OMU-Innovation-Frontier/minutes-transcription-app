# 開発ガイド

## ディレクトリ構造

```text
src/                  フロントエンド、音声取得、STTクライアント、UI
src/ui/               画面状態、文字起こし、要約、スクロール表示
server/src/           WebSocketサーバー、VAD、Local Whisper、整文、要約
shared/               フロント／サーバー共通の型と検証
server/test/          バックエンドと統合テスト
docs/                 設計、運用、評価手順
scripts/              読み取り専用の環境・共有監査
server/data/          ローカル実行物と実データ。Git対象外
```

## 開発コマンド

```powershell
pnpm.cmd run dev:server
pnpm.cmd run dev
pnpm.cmd run typecheck
pnpm.cmd run lint
pnpm.cmd test
pnpm.cmd run build
```

ローカル評価・比較コマンドは`package.json`と[LOCAL_STT_EVALUATION.md](LOCAL_STT_EVALUATION.md)を確認してください。実音声や評価結果は`server/data/`から外へ出しません。

## 変更の原則

- 1 Issueにつき、関連する1つの目的と完了条件を定義する。
- UI変更で録音セッション、発話順、rawText、correctedText、uncertainPartsを失わない。
- STT変更でWebSocket protocol、audio_ack、PendingAudioQueue、resume、stop flushを不用意に変えない。
- correction変更ではrawTextを不変にし、失敗時のフォールバックと保護トークン検証を維持する。
- 要約更新とtranscript追加を同じデータとして扱わない。
- 外部provider、API、有料サービスは実装前に送信対象、料金、利用規約、保持方針を合意する。

## ログとテストデータ

通常ログへ次を出しません。

- 音声、rawText、correctedText、要約の全文
- LLM入力／出力全文、APIキー、用語集全文
- メールアドレス、個人名、会議固有情報

テストは架空の短い例と`.test`ドメインを使用します。実録音や実文字起こしをfixtureへコピーしません。

## UI変更時の回帰確認

- home → meeting → meeting-detail → home
- rawText即時表示とcorrectedText更新
- 発話順、最新／1つ前／過去の表示
- 手動スクロール時の自動追従停止
- Whisper原文とuncertainParts
- 一時停止／再開、終了確認、下部操作
- 狭い画面、キーボード、focus-visible、reduced motion

## STT・通信変更時の回帰確認

- Browser recognition、Mock recognition、WebSocket Mock、Local Whisper
- PCM16、VAD、FIFO、PendingAudioQueue、audio_ack
- 切断中の蓄積、resume／reconnect、重複拒否
- stop flush、cancel、デバッグWAV上限、同一WAV比較
- 外部STTが既定無効であること

## correction変更時の回帰確認

- rawText不変、correctedText別保存
- disabled／pending／completed／failed／skipped
- JSON、reason、長さ、数字、URL、用語集の検証
- FIFO、重複防止、timeout後の継続、cancel後の古い結果破棄
- IndexedDB保存とログ本文非出力
- 外部送信が既定無効であること

## 完了条件

1. Issueの目的と対象外を満たす。
2. 差分に秘密、録音、モデル、生成物がない。
3. `typecheck`、`lint`、`test`、`build`が成功する。
4. 関連する手動確認を実施し、未確認項目を明記する。
5. 共有前監査を実行し、候補を人間が確認する。
6. Pull Requestへ変更理由、テスト結果、リスク、ロールバック方針を書く。
