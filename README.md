# Minutes Transcription App

ブラウザーマイクの音声をリアルタイムに文字起こしし、会議中の発話を読みやすく確認するための議事録アプリです。Vite + TypeScriptのフロントエンドと、Node.js + TypeScript + WebSocketのバックエンドで構成されています。

現在は一般公開前の開発段階です。団体内での少人数試験を検討していますが、認証、利用者分離、HTTPS、公開サーバー向け防御はまだありません。現在のバックエンドをそのままインターネットへ公開しないでください。

## 現在できること

- home / meeting / meeting-detailの3画面
- 日本語・英語のリアルタイム文字起こし
- ブラウザー認識、決定論的Mock、WebSocket Mock、Local Whisper small
- 16 kHz mono PCM16、VAD、audio_ack、PendingAudioQueue、resume / reconnect、stop flush
- Whisper原文の`rawText`と、安全検証後の`correctedText`の分離保持
- 外部送信しないMock整文、整文状態、`uncertainParts`
- Whisper原文の確認、最新発話中心のスクロールUI
- ブラウザーIndexedDBへの未ack音声と整文レコードの保存
- ライブ要約を差し込める表示領域（Mock／既存データのみ）

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
VITE_TRANSCRIPTION_PROVIDER=local-whisper
STT_PROVIDER=local
STT_EXTERNAL_ENABLED=false
LOCAL_STT_ENABLED=true
LOCAL_STT_DEBUG_AUDIO=false
```

サーバー側の`STT_PROVIDER`を未指定にした場合も`local`が既定です。モデルなしでMockだけを使う開発環境では、`.env.example`のように`STT_PROVIDER=mock`を明示してください。未知の値は外部接続へフォールバックせず、設定エラーとして起動を中止します。

### STT provider境界

Node.jsサーバーの上位処理は`SttProvider`だけを扱います。セッション設定、sequence付き音声チャンク、partial/finalを含む共通結果、停止、破棄がこの境界です。Local Whisperは`LocalWhisperServerProvider`内でVADと`whisper-cli.exe`実行を行い、実在するfinalだけを共通結果へ変換します。

将来クラウドSTTを追加する場合は`server/src/providers/providerFactory.ts`へ新しい`SttProvider`実装を登録します。WebSocket、`TranscriptStore`、整文、要約、IndexedDB、UIはprovider固有SDKを直接参照しません。クラウド接続、APIキー、モデル、課金パッケージは現在追加されていません。

詳しいWindows手順は[SETUP_WINDOWS.md](docs/SETUP_WINDOWS.md)、Local Whisperの構成は[LOCAL_WHISPER_REALTIME.md](docs/LOCAL_WHISPER_REALTIME.md)を参照してください。

### 外部送信しないMock整文を使う

```dotenv
LLM_CORRECTION_ENABLED=true
LLM_CORRECTION_PROVIDER=mock
```

Mockは単純な決定論的処理です。実LLMの品質を示すものではありません。クラウドLLMを将来追加して有効化すると、確定文字起こしと短い参考文脈が外部送信対象になります。

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
