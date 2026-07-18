# Windows開発環境セットアップ

この文書は、非公開リポジトリを取得した新規メンバーがWindowsで開発を始めるための手順です。モデル、実行ファイル、録音、`.env`はリポジトリに含まれません。

## 1. 前提ソフトウェア

- Windows 10または11
- Git（リポジトリ取得に使用。導入方法は団体の管理者に確認）
- Node.js 20.19以上、または22.12以上
- pnpm 11系（現在の確認環境は11.9.0）
- Local Whisperを使う場合だけ、承認済みの`whisper-cli.exe`とモデル

確認します。

```powershell
node --version
npm.cmd --version
pnpm.cmd --version
git --version
```

PowerShellの実行ポリシーにより`npm.ps1`や`pnpm.ps1`が拒否される場合、システム全体のポリシーを変更せず、同梱される`npm.cmd`／`pnpm.cmd`を使います。リポジトリの確認スクリプトは、その実行時だけ次のように起動できます。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-dev-environment.ps1
```

組織管理PCで実行ポリシー変更が必要と言われた場合は、独断で変更せず管理者へ相談してください。

## 2. リポジトリ取得後

```powershell
Set-Location <cloneしたフォルダー>
pnpm.cmd install --frozen-lockfile
Copy-Item .env.example .env
```

`.env`はGit対象外です。実APIキー、個人情報、録音由来の用語集を共有設定へ書かないでください。

## 3. Mockだけで起動する

モデルやWhisper実行ファイルがなくても、次の安全な既定値でUIとMock経路を開発できます。

```dotenv
STT_EXTERNAL_ENABLED=false
STT_PROVIDER=mock
LOCAL_STT_ENABLED=false
LOCAL_STT_DEBUG_AUDIO=false
LLM_CORRECTION_ENABLED=false
LLM_CORRECTION_PROVIDER=mock
SUMMARY_ENABLED=false
SUMMARY_PROVIDER=mock
```

バックエンドを起動します。

```powershell
pnpm.cmd run dev:server
```

別のPowerShellでフロントエンドを起動します。

```powershell
pnpm.cmd run dev
```

ブラウザーで`http://127.0.0.1:5173`を開きます。healthは次で確認します。

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

## 4. Local Whisperを使う

モデルと実行ファイルはGitHubへコミットせず、団体が承認した入手元・版・SHA-256を別の安全な連絡経路で共有します。

配置先:

```text
server/data/local-stt/models/ggml-small-q5_1.bin
server/data/local-stt/bin/v1.9.1/Release/whisper-cli.exe
```

SHA-256確認:

```powershell
Get-FileHash -Algorithm SHA256 server\data\local-stt\models\ggml-small-q5_1.bin
Get-FileHash -Algorithm SHA256 server\data\local-stt\bin\v1.9.1\Release\whisper-cli.exe
```

表示された値を、団体管理者が別経路で提示した期待値と比較します。このリポジトリはモデルや実行ファイルを自動ダウンロードしません。

`.env`で次を設定します。

```dotenv
STT_EXTERNAL_ENABLED=false
LOCAL_STT_ENABLED=true
LOCAL_STT_MODEL=small-q5_1
LOCAL_STT_DEBUG_AUDIO=false
```

起動後、`/health`で`localSttEnabled`を確認し、UIの開発者向け設定から「Local Whisper small」を選択します。

## 5. 外部送信しないMock整文

```dotenv
LLM_CORRECTION_ENABLED=true
LLM_CORRECTION_PROVIDER=mock
LLM_CORRECTION_REMOVE_FILLERS=false
```

現在の整文Mockは決定論的で、外部APIを呼びません。未実装のprovider名を指定した場合は原文へフォールバックします。

## 6. 検証

```powershell
pnpm.cmd run typecheck
pnpm.cmd run lint
pnpm.cmd test
pnpm.cmd run build
```

共有前には次も実行します。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-dev-environment.ps1
powershell -ExecutionPolicy Bypass -File scripts\check-share-readiness.ps1
```

## 7. よくあるエラー

### `pnpm.ps1 cannot be loaded`

`pnpm.cmd`を使用します。システム全体の実行ポリシー変更は推奨しません。

### `node_modules`がない

リポジトリ直下で`pnpm.cmd install --frozen-lockfile`を実行します。lockfileを勝手に再生成しないでください。

### 5173または8787が使用中

```powershell
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 5173,8787
```

無関係なプロセスを停止せず、所有者を確認してから対応します。

### Local Whisperが利用不可

モデル、`whisper-cli.exe`、SHA-256、配置先、`LOCAL_STT_ENABLED`を確認します。解決までMockで開発できます。モデルを自動ダウンロードしないでください。

### マイクが使えない

Windowsとブラウザーのマイク権限、利用中デバイス、localhostで開いていることを確認します。権限拒否を成功扱いにしません。

### `.env`が反映されない

フロント／バックエンドを停止し、`.env`保存後に再起動します。秘密値を画面共有やIssueへ貼らないでください。
