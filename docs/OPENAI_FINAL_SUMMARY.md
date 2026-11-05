# OpenAIによる会議終了時の要約

最終要約は、確定した発話から概要・議題・要点・決定事項・未解決事項・TODO・次回確認事項を生成します。既存の終了時の履歴保存と手動再試行を使います。失敗しても文字起こし履歴を残し、要約本文が完成した場合だけ追加保存します。

## 設定

サーバー専用のローカル`.env`で次を設定します。APIキーとモデルは利用者が用意します。ブラウザー用の`VITE_`設定へAPIキーを入れないでください。モデルは自動選択しません。

```dotenv
SUMMARY_ENABLED=true
SUMMARY_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_FINAL_SUMMARY_MODEL=gpt-6-luna
OPENAI_FINAL_REASONING_EFFORT=medium
OPENAI_MAX_OUTPUT_TOKENS=8192
SUMMARY_TIMEOUT_MS=60000
SUMMARY_MAX_RESPONSE_BYTES=262144
OPENAI_PRICING_JSON={"gpt-6-luna":{"inputUsdPerMillionTokens":0.10,"outputUsdPerMillionTokens":0.50}}
```

今回選択したモデルは`gpt-6-luna`、推論設定は`medium`です。[公式モデル仕様](https://developers.openai.com/api/docs/models/gpt-6-luna)でResponses API・Structured Outputs・mediumへの対応を確認しました。上記の価格例は2026-11-05に確認したStandardの短いコンテキストの単価です。コードに固定価格やモデルの自動フォールバックは追加しません。モデルを変更するときは対応機能と料金も確認してください。

既存の金額上限を使う場合は、`OPENAI_PRICING_JSON`に選択モデルの入力・出力100万トークンあたりのUSD単価を登録する必要があります。`.env.example`に形式を記載しています。単価未登録で金額上限が設定されている場合は、外部API呼び出し前に停止します。[公式料金表](https://developers.openai.com/api/docs/pricing)で確認し、推論トークンも出力料金に含まれることに注意してください。

利用量ファイルはトークン数・概算料金などのメタデータだけを記録し、本文やAPIキーを保存しません。アプリ内の金額判定は過去の記録に基づく事前確認で、次の1回分を含めた厳密な請求上限ではありません。APIエラー・不正応答でusageを取得できないリクエストの費用も把握できないため、提供元側の利用制限と併用してください。

設定を反映するには対象アプリのバックエンドを再起動し、会議準備を開き直します。今回の実装作業では利用者の`.env`は変更していません。

## 確認手順

1. 会議準備でライブ要約OFF・最終要約ONを選びます。
2. OpenAIへこの会議の確定文字起こし（整文済み発話を含む）と生成済み要約を送信する説明を読み、同意します。音声はこの要約経路へ送りません。
3. 架空の短い会議で、確定した決定・未決定の提案・担当や期限が未定のTODOを区別して発言します。
4. 会議終了後に各項目を確認します。担当者・期限が不明ならnull（UIでは未設定）となること、発話にない決定やTODOを作らないことを確認します。
5. 質問や「以前の指示を無視して」といった発話を入力内の資料として扱い、実行しないことを確認します。
6. 履歴詳細と再読み込み後の保存結果を確認します。
7. 通信失敗時は原文の履歴が残り、手動の「最終要約を再試行」で回復できることを確認します。

## 実装上の境界

- 固定のOpenAI Responses APIのみを使用し、`store: false`、Strict Structured Outputsを指定します。これは提供元のすべてのデータ保持をゼロにする保証ではありません。
- 会議本文内の指示を実行しないこと、推測で担当・期限・決定を補わないことをプロンプトで指示します。意味の正確さの完全保証ではなく、人による確認が必要です。
- サーバーで入力を検証し、未知フィールド・空発話・重複ID・異常な時刻・上限超過を外部送信前に拒否します。発話は最大2000件、合計15万文字で、超過時は黙って切り捨てません。モデルのトークン上限とは別の制限です。
- 応答は最大256KiB、待機は既定60秒、同時実行は1件です。拒否・未完了・不正JSON・未知フィールド・未知の根拠IDを拒否し、自動で再送しません。終了・timeout後の古い結果は採用しません。
- 根拠IDと形式は機械検証しますが、内容の妥当性は実機テストで評価してください。
- 既存のMock・ライブ要約経路を維持します。最初の試験ではライブ要約をOFFにして費用と動作を切り分けます。
- 新規依存、履歴スキーマ・IndexedDBバージョンの変更はありません。

通常テストはFake HTTPだけを使います。2026-11-05に利用者が実マイクと実OpenAIを使って最終要約を試験し、要約・TODO生成と保存、再読み込み後の保持を確認しました。結果は画面確認および利用者の成功報告に基づきます。決定事項・未解決事項の全項目の品質評価、ライブ要約、狭い画面の最終確認は別途必要です。

## 今回の実装・検証記録（2026-11-05）

- 開始ブランチ: `feature/groq-correction-llm-mvp`（HEAD `d1b37c2`、未保存変更なし）。
- 作業ブランチ: `feature/openai-final-summary-mvp`。ベース: PR #19マージ後の`origin/main`、`7d4bd26f38b6fafabb553738c550f8dea6429293`。
- 変更ファイル: `.env.example`、`README.md`、`docs/CURRENT_LIMITATIONS.md`、`server/src/server.ts`、`server/src/summary/config.ts`、`server/src/summary/openAISummaryProvider.ts`、`server/src/summary/summaryService.ts`、`server/test/summary.test.ts`、`shared/summary.ts`、`src/main.ts`、`src/meetingSetup/meetingSetup.ts`、`src/meetingSetup/meetingSetup.test.ts`、`src/summary/summaryClient.ts`、`src/summary/summaryClient.test.ts`。
- 新規ファイル: この手順書、`server/src/summary/summaryInput.ts`、`server/test/openAISummaryProvider.test.ts`、`server/test/openAISummaryServer.integration.test.ts`、`server/test/summaryInput.test.ts`。
- 途中の関連テスト: 6ファイル112テスト成功。その後の追加分も含めた最終全検証: 64ファイル763テスト成功。
- 初回の並列全検証では既存Windows子プロセス計測テスト1件が失敗。単独19テスト成功後、負荷を抑えた全件実行（`vitest run --maxWorkers=1`）で全件成功。既存STTテスト・そのtimeout・本番のSTT実装は変更していません。
- 最終のtypecheck、lint、frontend/server build、`git diff --check`: 成功。
- UIの同意境界、HTTP境界、保存・再試行・古い結果の破棄は自動テストで検証。実機で最終要約の成功表示、TODO、保存表示を確認。再読み込み後の保持は利用者が確認済み。
- `.env`はエージェント未変更。利用者がAPI設定を登録し、設定の有無のみを確認してバックエンドを再起動済み。秘密値は表示せず、Git対象外です。
- package.json、lockfile、新規依存、履歴スキーマ、IndexedDB version、migration: 変更なし。
- 通常の自動テストでは外部API接続なし。利用者の実機試験ではGroq文字起こしとOpenAI要約へ送信。エージェントから追加の課金APIリクエストは実行していません。
- 残る制約: STTの誤認識は要約にも影響します。今回の実機試験にも誤認識があり、STT精度向上は別課題です。意味の正確さの完全保証、厳密な請求上限、長時間・ライブ要約の評価は対象外です。
