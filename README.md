# Minutes Transcription App

## サークル向けの限定公開

合言葉による入室と全員共通の利用上限を有効にし、Render Free + Supabase Freeで動かす設定を追加しました。参加者へ渡すのはURLと合言葉だけです。管理者による外部サービスの設定と実機確認は別途必要です。[限定公開の設定・起動・参加者向け手順](docs/LIMITED_PILOT.md)を参照してください。

## OpenAIで会議終了時の要約を生成する

既存の最終要約・決定事項・TODO表示と履歴保存に、サーバー側のOpenAI Responses APIを接続できます。会議準備画面で送信内容を説明し、同意後に使用します。既定は無効・Mockのままです。設定と実機テスト手順は[OpenAI最終要約](docs/OPENAI_FINAL_SUMMARY.md)を参照してください。

## Groqでも途中要約・最終要約を作る

要約先をサーバー設定で `SUMMARY_PROVIDER=groq` に切り替えられます。OpenAI設定・既定値は保持します。専用のサーバー設定とキーが必要で、画面でGroqへの送信を確認して同意します。保存・TODO・PDF出力は既存の経路を使います。

[Groq要約の設定・制限・比較手順](docs/GROQ_SUMMARY.md)を参照してください。実API・品質・無料枠内での長時間利用は未検証です。

## Groq Whisper STT MVP

「新規会議」を押すとGroq Whisperで録音が始まります。ブラウザーで16 kHz mono PCM16へ変換した音声をWebSocket経由でサーバーへ送り、VADで確定した発話だけをGroqへ送信します。結果は発話終了後に表示します。

セットアップ:

1. Groqで利用者自身がAPIキーを作成し、ローカルの`.env`へ`GROQ_API_KEY`として設定します。
2. `.env`で`STT_EXTERNAL_ENABLED=true`を設定し、サーバーとフロントエンドを起動します。
3. モデルを比較する場合は、ホームの設定でWhisper Large V3 TurboかWhisper Large V3を選びます。「サーバーの既定モデル」は`GROQ_STT_MODEL`に従い、未設定時はWhisper Large V3 Turboを使います。
4. 会議終了時に「文字起こしだけ保存」または「最終要約を作って保存」を選びます。最終要約にはサーバーの要約機能を有効にする必要があります。
5. 無料枠とrate limitは変更される可能性があるため、利用前後にGroq Consoleで確認します。

`GROQ_API_KEY`を`VITE_*`へ置かず、`.env`をcommitしないでください。音声は文字起こしのためGroqへ送信されます。APIキー、音声、会議内容、応答本文はログへ出しません。通常テストは注入したFake HTTPのみを使い、外部APIへ接続しません。

MVPでは、利用量カウンターはサーバープロセスのメモリ内だけにあり、再起動で消えます。partial transcript、永続的な利用量ダッシュボード、複数外部STTへの同時送信は対象外です。1発話は最大20秒、同時リクエストは2、待機queueは8、リクエストtimeoutは30秒、停止待機は最大120秒です。

## Fun-ASR Phase 1a (live-capable transport, not live-validated)

The server contains a Fun-ASR provider behind the existing `SttProvider` boundary. Phase 0 validates protocol events, maps partial/final results, preserves `sentence_id` order, and applies in-memory audio usage limits. Phase 1a adds a server-only `ws` transport with a Singapore workspace-dedicated hostname derived from a validated server-only Workspace ID, a fixed path, bounded frames/backpressure, safe close behavior, and server-side handshake authentication. The existing `dashscope-intl.aliyuncs.com` domain remains documented by Alibaba Cloud, but this implementation does not use it or fall back to it. Tests inject Fake Transport and Fake WebSocket implementations and remain fully offline.

No Alibaba account, API key, Workspace ID, Free Quota Only setting, payment method, live connection, or external audio transmission has been used. External STT remains disabled by default. A live connection is possible only after all server-only settings, including `STT_WORKSPACE_ID`, and usage limits are explicitly configured; arbitrary endpoints are rejected. Fun-ASR is not exposed to general users, has not been benchmarked, and is not a production adoption decision. Local Whisper and Mock remain unchanged.

ブラウザーマイクの音声をリアルタイムに文字起こしし、会議中の発話を読みやすく確認するための議事録アプリです。Vite + TypeScriptのフロントエンドと、Node.js + TypeScript + WebSocketのバックエンドで構成されています。

現在は一般公開前の開発段階です。団体内の少人数試験では、上記の限定公開設定を有効にし、RenderのHTTPS公開先を使用します。入室状態ごとに録音の再接続と要約利用量を分離します。個別アカウント・共有履歴・組織単位の権限管理は今回の対象外です。

## 現在できること

- home / meeting / meeting-detailの3画面
- 日本語・英語のリアルタイム文字起こし
- ブラウザー認識、決定論的Mock、WebSocket Mock、Local Whisper
- 16 kHz mono PCM16、VAD、audio_ack、PendingAudioQueue、resume / reconnect、stop flush
- Whisper原文の`rawText`と、安全検証後の`correctedText`の分離保持
- 外部送信しないMock整文、整文状態、`uncertainParts`
- Whisper原文の確認、最新発話中心のスクロールUI
- ブラウザーIndexedDBへの未ack音声と整文レコードの保存
- ライブ要約と会議終了時の最終要約・決定事項・TODO表示（Mock／明示設定したOpenAI）

## 現在できないこと

- 実LLMによる整文品質の提供
- 要約AIの本運用
- 会議履歴の完全な永続化とページ再読込復元
- 認証、権限管理、複数利用者・複数会議の分離
- エクスポート、高度な検索、発言者識別
- HTTPSや外部公開を前提とした運用

詳細は[現在の制限](docs/CURRENT_LIMITATIONS.md)を参照してください。

## クイックスタート

### 前提

- Node.js 20.19以上、または22.12以上
- pnpm（この環境で確認した版は11.9.0）
- Windowsでは`pnpm.ps1`が拒否される場合に`pnpm.cmd`を利用できます

### Mockだけで起動する

Local Whisperのモデルや実行ファイルがなくても、UI・WebSocket・Mock整文の開発はできます。

```powershell
Copy-Item .env.example .env
pnpm.cmd install --frozen-lockfile
pnpm.cmd run dev:server
```

別のPowerShellで次を実行します。

```powershell
pnpm.cmd run dev
```

- フロントエンド: `http://127.0.0.1:5173`
- health: `http://127.0.0.1:8787/health`
- WebSocket: `ws://127.0.0.1:8787/transcription`

`.env`はローカル専用です。内容をIssue、Pull Request、チャット、コミットへ貼らないでください。

### Local Whisperを使う

モデルと`whisper-cli.exe`はリポジトリに含めません。各メンバーが承認済みの配布元から別途取得し、SHA-256を確認して次へ配置します。

```text
server/data/local-stt/models/ggml-small-q5_1.bin
server/data/local-stt/bin/<version>/Release/whisper-cli.exe
```

`.env`で次を明示します。

```dotenv
STT_PROVIDER=local
STT_EXTERNAL_ENABLED=false
LOCAL_STT_ENABLED=true
LOCAL_STT_DEBUG_AUDIO=false
```

サーバー側の`STT_PROVIDER`を未指定にした場合も`local`が既定です。モデルなしでMockだけを使う開発環境では、`.env.example`のように`STT_PROVIDER=mock`を明示してください。未知の値は外部接続へフォールバックせず、設定エラーとして起動を中止します。

### STT provider境界

Node.jsサーバーの上位処理は`SttProvider`だけを扱います。セッション設定、sequence付き音声チャンク、partial/finalを含む共通結果、停止、破棄がこの境界です。Local Whisperは`LocalWhisperServerProvider`内でVADを行い、既定のwhisper.cppまたは明示設定されたApple Silicon向けMLX Whisperへ渡し、実在するfinalだけを共通結果へ変換します。

将来クラウドSTTを追加する場合は`server/src/providers/providerFactory.ts`へ新しい`SttProvider`実装を登録します。WebSocket、`TranscriptStore`、整文、要約、IndexedDB、UIはprovider固有SDKを直接参照しません。クラウド接続、APIキー、モデル、課金パッケージは現在追加されていません。

詳しい手順は[Windowsセットアップ](docs/SETUP_WINDOWS.md)と[macOSセットアップ](docs/SETUP_MACOS.md)、Local Whisperの構成は[LOCAL_WHISPER_REALTIME.md](docs/LOCAL_WHISPER_REALTIME.md)を参照してください。

### 外部送信しないMock整文を使う

```dotenv
LLM_CORRECTION_ENABLED=true
LLM_CORRECTION_PROVIDER=mock
```

Mockは単純な決定論的処理です。実LLMの品質を示すものではありません。

### Groq LLM整文を使う

Groq整文は、確定した発話だけを`openai/gpt-oss-20b`で保守的に整えます。要約、TODO抽出、質問への回答は行いません。利用時は、確定した文字起こし、直前の発話（最大2件）、設定した用語集がGroqへ送信されます。APIキーは`GROQ_CORRECTION_API_KEY`としてNode.jsサーバーだけに設定し、ブラウザーへ渡しません。

```dotenv
LLM_CORRECTION_ENABLED=true
LLM_CORRECTION_PROVIDER=groq
GROQ_CORRECTION_API_KEY=
GROQ_CORRECTION_MODEL=openai/gpt-oss-20b
```

出力にはStrict Structured Outputsを使用し、すべての結果を既存の`validateCorrectionOutput`でも再検証します。検証失敗、通信失敗、timeout、cancel時は原文へ安全に戻り、自動retryは行いません。実会議データを使う前に、会議設定画面で外部送信内容を確認して利用者の同意を得てください。無料枠、利用上限、提供条件は変更される可能性があるため、利用前にGroqの最新の条件とData Controlsを確認してください。

## 検証コマンド

```powershell
pnpm.cmd run typecheck
pnpm.cmd run lint
pnpm.cmd test
pnpm.cmd run build
```

環境と共有準備を読み取り専用で確認できます。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-dev-environment.ps1
powershell -ExecutionPolicy Bypass -File scripts\check-share-readiness.ps1
```

共有前監査は危険候補を列挙するだけで、削除や修正は行いません。また、秘密情報の完全検出を保証しません。

## 共有してはいけないもの

- `.env`、APIキー、token、password、credential
- 実際の会議音声、文字起こし全文、要約全文
- デバッグWAV、metadata、comparison結果、IndexedDBエクスポート
- Whisperモデル、`whisper-cli.exe`、配布ZIPやDLL
- `server/data/`、`node_modules/`、`dist/`、ログ、バックアップ

共有前に[PRIVACY.md](docs/PRIVACY.md)と[GitHub非公開リポジトリ手順](docs/GITHUB_PRIVATE_REPOSITORY_SETUP.md)を読み、`check-share-readiness.ps1`の結果を人間が確認してください。既に追跡されたファイルは`.gitignore`追加だけでは外れないため、Git利用可能環境で`git ls-files`と`git check-ignore -v --no-index <path>`を確認します。

## 開発文書

- [Windowsセットアップ](docs/SETUP_WINDOWS.md)
- [macOSセットアップ](docs/SETUP_MACOS.md)
- [開発ガイド](docs/DEVELOPMENT.md)
- [アーキテクチャ](docs/ARCHITECTURE.md)
- [プライバシー](docs/PRIVACY.md)
- [チーム開発フロー](docs/TEAM_WORKFLOW.md)
- [団体内配備の選択肢](docs/DEPLOYMENT_OPTIONS.md)
- [現在の制限](docs/CURRENT_LIMITATIONS.md)
- [GitHub非公開リポジトリ手順](docs/GITHUB_PRIVATE_REPOSITORY_SETUP.md)
- [手動UIスモークテスト](docs/MANUAL_UI_SMOKE_TEST.md)
- [Local Whisperリアルタイム](docs/LOCAL_WHISPER_REALTIME.md)
- [Local STT評価](docs/LOCAL_STT_EVALUATION.md)

## 共同開発の基本

```text
Issue
→ 作業ブランチ
→ Codexまたは手作業で変更
→ typecheck / lint / test / build
→ Pull Request
→ 別メンバー確認
→ mainへ統合
```

AI生成コードも人間が差分と安全性をレビューします。API、有料サービス、データ送信、破壊的変更は実装前にチームで合意してください。

## ライセンスと所有権

この準備作業ではLICENSEを選択していません。団体所有か個人所有か、非公開開発でのコード所有権と利用範囲、一般公開時のライセンス、外部ライブラリのライセンス確認方法を、共有開始前に決める必要があります。
