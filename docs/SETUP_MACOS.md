# macOS開発環境セットアップ

この文書は、macOSでMock開発とLocal Whisperを使う手順です。モデル、実行ファイル、録音、`.env`はリポジトリへコミットしません。

## 1. 前提ソフトウェア

- Node.js 20.19以上、または22.12以上
- pnpm
- Git
- Local Whisperを使う場合のみ、CMakeとC/C++ビルド環境

確認します。

```bash
node --version
npm --version
pnpm --version
git --version
```

## 2. Mockで起動する

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run verify:environment
pnpm run dev:server
```

別のターミナルで次を実行します。

```bash
pnpm run dev
```

ブラウザーで`http://127.0.0.1:5173`を開きます。初回のマイク利用時は、ブラウザーとmacOSの両方で権限を許可してください。Mock経路だけならWhisperのモデルや実行ファイルは不要です。

## 3. whisper.cpp互換経路を使う

このアプリは実行ファイルを自動ダウンロードしません。団体が承認したwhisper.cppの版を別の作業ディレクトリでビルドします。公式の基本手順は`cmake -B build`、`cmake --build build -j --config Release`で、生成されるCLIは`build/bin/whisper-cli`です。

生成物を、リポジトリ内のGit対象外ディレクトリへ配置します。`<version>`は実際に承認した版へ置き換えます。

```bash
mkdir -p server/data/local-stt/bin/<version>
cp /path/to/whisper.cpp/build/bin/whisper-cli server/data/local-stt/bin/<version>/whisper-cli
chmod 700 server/data/local-stt/bin/<version>/whisper-cli
shasum -a 256 server/data/local-stt/bin/<version>/whisper-cli
```

モデルは次へ配置し、団体が別経路で提示したSHA-256と照合します。

```text
server/data/local-stt/models/ggml-small-q5_1.bin
```

`.env`へ、実ファイルのリポジトリ相対パスと、上で確認した64文字のSHA-256を設定します。

```dotenv
VITE_TRANSCRIPTION_PROVIDER=local-whisper
STT_PROVIDER=local
STT_EXTERNAL_ENABLED=false
LOCAL_STT_ENABLED=true
LOCAL_STT_ENGINE=whisper-cpp
LOCAL_STT_MODEL=small-q5_1
LOCAL_STT_EXECUTABLE=server/data/local-stt/bin/<version>/whisper-cli
LOCAL_STT_EXECUTABLE_SHA256=<verified sha256>
LOCAL_STT_DEBUG_AUDIO=false
```

実行ファイルは`server/data/local-stt/bin/`配下に置く必要があります。起動時にパス境界、ファイル種別、モデルと実行ファイルのSHA-256を検証し、一致しない場合はLocal Whisperを開始しません。

```bash
pnpm run verify:environment
pnpm run dev:server
```

フロントエンドの開発サーバーも再起動します。

## 4. Apple SiliconでMLX Whisperを使う

MLX経路はwhisper.cppとは別の推論実装です。VAD、FIFO、16 kHz PCM WAV、WebSocket、UIの結果形式だけを共有し、Windowsの既定経路は変更しません。`darwin/arm64`以外では設定されていても起動前に拒否します。

専用venvをコピー形式で作成し、固定した`mlx-whisper`を入れます。venvのPythonは`server/data/local-stt/mlx/`配下の実ファイルである必要があります。

```bash
python3 -m venv --copies server/data/local-stt/mlx/venv
server/data/local-stt/mlx/venv/bin/python3 -m pip install -r server/requirements-mlx-whisper.txt
server/data/local-stt/mlx/venv/bin/python3 -c "import mlx_whisper; print('mlx-whisper ready')"
shasum -a 256 server/data/local-stt/mlx/venv/bin/python3
```

モデルはアプリの外部通信ではなく、セットアップ作業として固定revisionから取得します。取得後の認識処理はオフライン固定です。

```bash
HF_HUB_DISABLE_XET=1 server/data/local-stt/mlx/venv/bin/python3 -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='mlx-community/whisper-large-v3-turbo', revision='a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb', local_dir='server/data/local-stt/models/mlx/whisper-large-v3-turbo')"
shasum -a 256 server/data/local-stt/models/mlx/whisper-large-v3-turbo/weights.safetensors
```

このrevisionの`weights.safetensors`の期待値は`951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6`です。異なる場合は有効化しません。

`.env`を次のように設定します。

```dotenv
VITE_TRANSCRIPTION_PROVIDER=local-whisper
STT_PROVIDER=local
STT_EXTERNAL_ENABLED=false
LOCAL_STT_ENABLED=true
LOCAL_STT_ENGINE=mlx-whisper
LOCAL_STT_MODEL=large-v3-turbo
LOCAL_STT_MLX_PYTHON=server/data/local-stt/mlx/venv/bin/python3
LOCAL_STT_MLX_PYTHON_SHA256=<verified python sha256>
LOCAL_STT_MLX_MODEL_DIR=server/data/local-stt/models/mlx/whisper-large-v3-turbo
LOCAL_STT_DEBUG_AUDIO=false
```

実行する前にサーバーとフロントエンドの両方を再起動します。MLXワーカーの起動前にPythonとモデル重みのSHA-256、モデル設定ファイルの存在を、起動時にパッケージ版を検証し、モデルを一度だけロードします。発話ごとに同じ常駐プロセスを再利用します。入力WAVはPython標準機能で読み込むため、この経路にffmpegは不要です。現在、保存デバッグ音声の再比較機能はwhisper.cpp専用なので、MLXでは`LOCAL_STT_DEBUG_AUDIO=false`を維持してください。文字列を含まない`LOCAL_STT_DEBUG_METRICS`は利用できます。

## 5. 検証

```bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm run check:share
```

`verify:environment`と`check:share`は読み取り専用です。後者は候補を列挙する監査であり、秘密情報の完全検出を保証しません。

既存のLocal STT評価CLIはwhisper.cpp専用で、互換CLIでは`LOCAL_STT_EXECUTABLE`を指定し、実行ファイルの検証に対応したCLIでは`LOCAL_STT_EXECUTABLE_SHA256`も指定します。通常評価、スイート、自然音声、チャンク比較、再現性確認、保存デバッグ音声比較の詳細は[Local STT評価](LOCAL_STT_EVALUATION.md)を参照してください。MLXはモデル配置後にアプリの実音声経路で別途評価します。

## 6. よくあるエラー

### `LOCAL_STT_EXECUTABLE_SHA256 is required`

実行ファイルのSHA-256を`shasum -a 256`で取得し、`.env`へ設定します。値をIssueやチャットへ貼る前に、対象が秘密情報ではなく承認済みバイナリのハッシュであることを確認します。

### Local Whisper実行ファイルが利用不可

実行ファイルが`server/data/local-stt/bin/`配下にあること、実行権限、`.env`のパス、SHA-256を確認します。解決まではMockで開発できます。

### MLX Whisperを開始できない

`uname -m`が`arm64`であること、venvを`--copies`で作成したこと、Pythonとモデル重みのSHA-256、`mlx-whisper==0.4.3`、モデルの`config.json`と`weights.safetensors`を確認します。アプリは不足ファイルやモデルを自動取得しません。

### マイクが使えない

「システム設定 → プライバシーとセキュリティ → マイク」とブラウザーのサイト権限を確認します。権限変更後はブラウザーの再起動が必要な場合があります。
