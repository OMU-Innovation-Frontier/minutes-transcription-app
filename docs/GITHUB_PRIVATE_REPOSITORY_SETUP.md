# GitHub非公開リポジトリの準備手順

この文書は人間が実施する手順です。現在の作業環境からリポジトリ作成、ログイン、remote追加、push、招待は自動実行しません。

## 開始前の合意

1. リポジトリを団体所有にするか個人所有にするか決める。
2. 管理者、バックアップ管理者、メンバー招待権限を決める。
3. 非公開開発でのコード所有権と利用範囲を決める。
4. 一般公開する可能性がある場合は、別途ライセンスを選定する。
5. 外部ライブラリのライセンス確認担当を決める。

このリポジトリにはLICENSEを追加していません。

## 共有前の共通確認

```powershell
pnpm.cmd run typecheck
pnpm.cmd run lint
pnpm.cmd test
pnpm.cmd run build
powershell -ExecutionPolicy Bypass -File scripts\check-share-readiness.ps1
```

次がコミット候補にないことを人間が確認します。

- `.env`、APIキー、password、secret、token、credential
- 実音声、文字起こし、要約、metadata、comparison
- `server/data/`、モデル、`whisper-cli.exe`、配布ZIP／DLL
- `node_modules/`、`dist/`、ログ、バックアップ

`.gitignore`は既に追跡されたファイルを外しません。Git初期化済みなら次も確認します。

```powershell
git status --short
git ls-files
git check-ignore -v --no-index server/data/local-stt/models/ggml-small-q5_1.bin
```

一覧に危険候補があれば、最初のcommit／publish前に原因を確認します。秘密を一度commitした場合、単に最新commitから消すだけでは履歴に残るため、管理者へ連絡して対応方針を決めます。

## 方法A：GitHub Desktop

1. GitHub上で所有者を確認し、Privateリポジトリを作成する。README、LICENSE、`.gitignore`の自動追加は、既存ファイルと衝突させない。
2. GitHub Desktopで`Add an Existing Repository from your Hard Drive`を選び、対象フォルダーを追加する。未初期化なら案内に従ってローカルリポジトリを作る。
3. 上記の共有前監査を実行し、GitHub DesktopのChangesで全差分を確認する。
4. 音声、モデル、`.env`、生成物がないことを確認して最初のcommitを作る。
5. `Publish repository`を選ぶ。
6. `Keep this code private`またはPrivate設定が有効であることを、publish前後に確認する。
7. GitHubのSettingsでvisibilityがPrivateであることを再確認する。
8. まず1人だけ、必要最小限の権限でメンバーを招待する。
9. 招待されたメンバーが別PCへcloneし、[SETUP_WINDOWS.md](SETUP_WINDOWS.md)のMock起動を確認する。
10. Local Whisperが必要なら、モデルと実行ファイルをGitHub以外の承認済み経路で配布し、SHA-256を照合する。

## 方法B：Gitコマンド

Gitが利用可能なPCで、人間がPrivateリポジトリを作成した後に実施する一般例です。`<PRIVATE_REPOSITORY_URL>`はGitHub画面から取得します。

```powershell
git init
git status --short
powershell -ExecutionPolicy Bypass -File scripts\check-share-readiness.ps1
git add .
git status --short
git diff --cached --stat
git diff --cached --check
git commit -m "chore: prepare private team repository"
git branch -M main
git remote add origin <PRIVATE_REPOSITORY_URL>
git remote -v
git push -u origin main
```

`git add .`の後は必ずstaged一覧を確認し、不明なファイルがあればcommitしません。実アクセストークン、ユーザー名、団体名を文書やコマンド履歴へ固定しません。強制pushや履歴書き換えはこの手順に含めません。

## 初回clone後

```powershell
git clone <PRIVATE_REPOSITORY_URL>
Set-Location <cloneしたフォルダー>
pnpm.cmd install --frozen-lockfile
Copy-Item .env.example .env
powershell -ExecutionPolicy Bypass -File scripts\verify-dev-environment.ps1
pnpm.cmd run typecheck
pnpm.cmd run lint
pnpm.cmd test
pnpm.cmd run build
```

最初はMockだけで起動します。別PCで再現できた後に、Local Whisper配布の必要性と管理方法を判断します。

## Privateでも必要な注意

Privateリポジトリは、録音や秘密情報を保存してよい場所という意味ではありません。メンバー権限、退会時対応、監査、2要素認証、バックアップ、インシデント連絡を団体ルールとして決めてください。
