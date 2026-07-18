# ローカルSTTオフライン評価

初回調査日: 2026-07-15 / 録音・評価スイート更新日: 2026-07-16

この段階は録音ファイルのオフライン評価専用です。Browser、Mock、WebSocketモックの経路には接続していません。音声認識中の外部通信は行わず、モデルの自動ダウンロード機能もありません。`STT_EXTERNAL_ENABLED=false`を維持してください。

## 確認したPC環境

- OS: `Microsoft Windows NT 10.0.26200.0`、DisplayVersion `25H2`、UBR `8875`。レジストリのProductNameは`Windows 10 Home`と表示されるため、製品名は推測で補正しません。
- アーキテクチャ: 64-bit OS、AMD64プロセス
- CPU: 13th Gen Intel Core i7-1360P
- 物理メモリ: 15.63 GiB。確認時の利用可能量は4.07 GiB。
- Cドライブ: 460.33 GiB、確認時の空き332.79 GiB。
- Python、CMake、`cl`、clang、gcc/g++、nmake、MSBuild、Visual Studio Build Tools、ffmpeg、Git、OpenVINO: コマンドまたは標準配置で確認できず。
- `Get-CimInstance`、`systeminfo`: この実行環境ではアクセス拒否。上記はレジストリと.NET APIから取得した値。

この状態ではwhisper.cppのソースビルドはできません。公式リリースにはWindows x64向けビルド済みzipがあるため、CPU基準測定はビルドツールなしでも実施可能です。最新版として確認したv1.9.1の`whisper-bin-x64.zip`は7,982,101 bytes、公開SHA-256は`7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539`です。取得後はハッシュを照合し、リポジトリ内の`server/data/local-stt/bin`へ展開します。システムにはインストールしません。

## 最初の比較候補

| 正式候補 | 配布元 | 形式と容量 | 参考RAM | 日本語 | 英語 | whisper.cpp | OpenVINO | ライセンス |
|---|---|---:|---:|---|---|---|---|---|
| Whisper base multilingual | OpenAI / ggerganov whisper.cpp | GGML 148 MB、Q5_1 59.7 MB | 約388 MB | 対応 | 対応 | 対応 | モデル系列は対応、Q5_1組合せは未確認 | MIT |
| Whisper small multilingual | OpenAI / ggerganov whisper.cpp | GGML 488 MB、Q5_1 190 MB | 約852 MB | 対応 | 対応 | 対応 | モデル系列は対応、Q5_1組合せは未確認 | MIT |
| Kotoba-Whisper v2.0 GGML | Kotoba Technologies | GGML 1.52 GB、Q5_0 538 MB | 公式資料で確認できず | 専用 | 対象外 | 対応 | 公式手順を確認できず | Apache-2.0 |
| Whisper base.en | OpenAI / ggerganov whisper.cpp | GGML 148 MB、Q5_1 59.7 MB | 約388 MB | 非対応 | 専用 | 対応 | モデル系列は対応、Q5_1組合せは未確認 | MIT |
| Whisper small.en | OpenAI / ggerganov whisper.cpp | GGML 488 MB、Q5_1 190 MB | 約852 MB | 非対応 | 専用 | 対応 | モデル系列は対応、Q5_1組合せは未確認 | MIT |

参考RAMはwhisper.cpp公式READMEの非量子化モデル表です。量子化版の実測ピークRAMではありません。Intel CPUでの実行はwhisper.cppのx86 CPU対応範囲です。実時間性能はこのPCと録音で測るまで未確認です。

確認元:

- OpenAI Whisper: https://github.com/openai/whisper
- whisper.cpp: https://github.com/ggml-org/whisper.cpp
- 変換済みGGMLモデル: https://huggingface.co/ggerganov/whisper.cpp/tree/main
- Windowsビルド済みリリース: https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1
- Kotoba GGML: https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml
- Kotoba v2.0モデルカード: https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0

## 最初の推奨モデル

最初の1つは`ggml-base-q5_1.bin`（Whisper base multilingual Q5_1、59.7 MB）です。16 GBメモリで余裕が大きく、日本語と英語を同じモデルで比較でき、公式のwhisper.cpp用変換済み量子化ファイルとして配布されています。公式配布ツリーにbase/smallのQ5_0はなくQ5_1があるため、存在しないQ5_0ファイル名は使用しません。

精度が不足した場合だけ`ggml-small-q5_1.bin`（190 MB）へ進みます。英語専用の公平比較では同じサイズの`base.en`または`small.en`を用います。Kotoba Q5_0は538 MBなので、500 MB超の承認停止対象です。

予定保存先:

```text
server/data/local-stt/bin/       whisper-cli.exeと同梱DLL
server/data/local-stt/models/    GGMLモデル
server/data/local-stt/input/     ユーザーが用意した音声
server/data/local-stt/tmp/       変換後の一時WAV
server/data/local-stt/results/   明示的な評価結果JSONL
```

`server/data/local-stt/`全体はGit対象外です。削除は、アプリ停止後にこのディレクトリ内の承認済み実行ファイル・モデル・入力・一時ファイル・結果だけを手動削除します。バックアップディレクトリには触れません。

## 評価音声をブラウザーで録音する

`pnpm dev`でフロントエンドを起動し、画面の「評価音声録音」を使用します。この画面は既存のBrowser・Mock・WebSocket文字起こしとは別の録音グラフです。マイク音声はSTT、バックエンド、外部APIのいずれにも送られません。

1. 「日本語録音を開始」を押し、表示された日本語文を読む。
2. 「録音停止」を押し、WAV形式検証が「合格」になったことを確認する。
3. 再生して音量と内容を確認し、「WAVダウンロード」で`ja.wav`を保存する。
4. 「英語録音を開始」から同じ手順で`en.wav`を保存する。
5. エクスプローラーで両ファイルを次へ手動配置する。

```text
server/data/local-stt/input/ja.wav
server/data/local-stt/input/en.wav
```

ブラウザーのセキュリティ制約により、アプリからリポジトリ内フォルダーへ直接書き込みません。既存の同名ファイルがある場合も自動上書きしません。内容を確認してからユーザーが置き換えてください。

録音はWeb Audio APIの`AudioContext`で取得し、入力チャンネルを平均してmono化し、入力コンテキストの実サンプルレートから16 kHzへリサンプリングします。Float32値をsigned 16-bit PCM little-endianへ変換し、RIFF/WAVEヘッダーを生成した後、そのArrayBufferを読み直して次を検証します。

- RIFF / WAVE / fmt / dataチャンク
- PCM format 1
- 16,000 Hz
- 1 channel
- 16 bits per sample
- byte rate 32,000、block align 2、偶数data長

簡易音質検査ではRMSが0.003未満を「無音の可能性あり」、絶対値0.99以上のサンプルが0.1%を超える場合を「音割れの可能性あり」と表示します。これは録音品質の警告であり、音響測定の保証ではありません。WAV形式が不合格ならダウンロードボタンを有効にせず、評価スイートもサーバー側の再検証で拒否します。

## 音声変換

評価入力はWAV、WebM Opus、OGG Opus、MP3を受け付けますが、ローカルSTTへ渡す前に16 kHz、mono、16-bit PCM WAVへ統一します。既にこの条件を満たすWAVはそのまま使用します。それ以外はffmpegが必要です。

現在ffmpegは見つかっていません。アプリは勝手にインストールせず、必要な場合は`LOCAL_STT_FFMPEG_PATH`未設定エラーで止まります。導入する場合は https://ffmpeg.org/download.html#build-windows からリンクされるWindows配布をユーザーが選び、ビルドごとの容量、ハッシュ、LGPL/GPL構成を確認して`server/data/local-stt/bin`へ展開します。

変換引数はshellを介さず次の配列相当です。`-n`により既存ファイルを上書きしません。

```text
-nostdin -hide_banner -loglevel error -n -i INPUT -ar 16000 -ac 1 -c:a pcm_s16le OUTPUT
```

一時WAVは評価終了時に削除します。変換失敗時に既存の録音・WebSocket機能へ影響はありません。

## 評価CLI

設定例:

```dotenv
STT_EXTERNAL_ENABLED=false
LOCAL_STT_EXECUTABLE=server/data/local-stt/bin/whisper-cli.exe
LOCAL_STT_MODEL_DIR=server/data/local-stt/models
LOCAL_STT_ALLOWED_INPUT_ROOTS=server/data/local-stt/input
LOCAL_STT_FFMPEG_PATH=
RUN_LOCAL_STT_TESTS=false
```

16 kHz mono PCM WAVでの例:

```powershell
pnpm benchmark:local -- --audio server/data/local-stt/input/ja.wav --model whisper-base-q5_1 --language ja --reference "本日はリアルタイム文字起こしシステムの動作確認を行います。"
```

CLIは「ローカル処理・外部送信なし」、モデル、言語、入力、音声時間、処理時間、RTF、CER/WER、ホットワード命中率、最初の標準出力までの時間、最終時間、保存先をJSON表示します。通常ログには音声や認識全文を出しません。認識全文を含む評価結果は`results/benchmarks.jsonl`へ明示的に保存します。

日本語・英語の両WAVをまとめて測る再現用コマンド:

```powershell
$env:STT_EXTERNAL_ENABLED='false'
$env:LOCAL_STT_THREADS='4'
pnpm run benchmark:local:suite
```

このスイートは`ja.wav`と`en.wav`の両方を実行前にサーバー側で再検証します。片方でも未配置または形式不正なら、whisper.cppを1回も起動せず安全に終了します。各言語をcold 1回、warm 3回、同じモデル・4 threads・`--no-gpu`で順番に実行します。ここでcoldは「その言語についてスイート内の最初のプロセス起動」を指し、WindowsのOSファイルキャッシュを強制消去しません。キャッシュ消去のための管理者操作や追加ソフトウェアは使用しません。

実行前メタデータは`results/whisper-base-q5_1-cpu-<timestamp>.metadata.json`、各実行は同名の`.jsonl`へ保存します。メタデータには利用可能メモリ、論理CPU数、threads、実際のwhisper.cpp引数、モデルSHA-256、各音声SHA-256、WAV形式、音声時間を記録します。JSONLには要求されたcold/warm区分、時間、RTF、CPU平均／ピーク、最大Working Set、raw／正規化CER、正規化WER、ホットワード命中率、認識全文を保存します。認識全文は通常のコンソールへ表示しません。

日本語の正規化CERはUnicode NFKC、英字小文字化、Unicode句読点除去、空白除去を適用し、数字の読み替えはしません。raw CERも別フィールドへ保存します。英語WERはNFKC、英字小文字化、Unicode句読点除去後に空白単位で比較します。ファイル実行から最初の標準出力を観測できない場合、`firstResultTimeMs`は`null`です。

Windowsでは、検証済み固定パスの標準PowerShellをshellなしで起動し、認識子プロセスの累積CPU時間とWorking Setを250 ms間隔で取得します。CPU使用率は論理プロセッサ数で正規化した処理全体の平均、メモリは観測された最大Working Setです。短すぎる処理や非Windows環境で取得できない場合は`null`と理由を表示し、推測値を補いません。サンプラーへ音声、認識文、APIキーは渡しません。

RTFは`処理時間 ÷ 音声時間`です。表示上の目安は0.5以下を「十分速い」、0.5超から1.0以下を「リアルタイム候補」、1.0超を「現状では追いつかない」とします。性能保証ではありません。

## テスト文

日本語:

```text
本日はリアルタイム文字起こしシステムの動作確認を行います。
音声認識の速度、精度、専門用語の認識結果を比較します。
大阪公立大学では人工知能とロボット技術について研究しています。
WebSocketとOpenVINOについても確認します。
```

英語:

```text
Today, we are testing a real-time transcription system.
We will compare recognition speed, accuracy, and technical vocabulary.
Artificial intelligence and robotics are important fields of research.
We will also test WebSocket, OpenVINO, and transcription.
```

専門用語: 大阪公立大学、人工知能、音声認識、WebSocket、OpenVINO、transcription、artificial intelligence、robotics。

## OpenVINO

先にCPUのみを`--no-gpu`で測定します。whisper.cpp公式対応はencoder推論だけで、x86 CPUとIntelの内蔵・単体GPUを対象にできます。WindowsではPython 3.10推奨の変換環境、`requirements-openvino.txt`、OpenVINO 2024.6推奨、CMakeとC++ビルド環境、`-DWHISPER_OPENVINO=1`での専用ビルド、encoderのXML/BINが必要です。初回はデバイス向けコンパイルとキャッシュのため遅くなります。

現在これらは未配置なので導入しません。容量と全依存関係を確定し、CPU基準結果を保存した後に承認を得て、同じ音声・モデル・設定で別結果として比較します。Iris Xeの利用可能性は公式上の「Intel integrated GPU」範囲ですが、このPCのドライバーと実測による確認が必要で、高速化は保証しません。

## Kotoba-Whisper v2.0

- 正式配布: `kotoba-tech/kotoba-whisper-v2.0-ggml`
- 通常版: `ggml-kotoba-whisper-v2.0.bin`、1.52 GB
- 量子化版: `ggml-kotoba-whisper-v2.0-q5_0.bin`、538 MB
- ライセンス: Apache-2.0
- 対象: 日本語ASR。英語比較用モデルとしては扱いません。
- 入力: 16-bit WAV。公式例は16 kHz mono PCMへffmpeg変換。
- whisper.cpp: `-m <model> -l ja -f <wav>`で実行。
- 長時間: whisper.cppとfaster-whisperは逐次long-form decoding。Hugging Face pipelineのみchunked long-formにも対応し、モデルカードは用途ごとの精度・速度差を説明しています。
- このPCでの注意: Q5_0でも500 MB超、756M parameters、CPU速度とピークRAMの公式Windows値なし。最初のモデルにはしません。
- 公平比較: 同一の日本語16 kHz mono PCM WAV、同じスレッド数、CPUのみ、同じ言語指定、同じ正解文と正規化、初回とウォーム実行を分離し、CER・処理時間・RTFを比較します。

## Qwen3-ASR-0.6B（将来候補のみ）

- 公式重み: `Qwen/Qwen3-ASR-0.6B`、1.88 GB、Apache-2.0。
- 日本語・英語を含む30言語と22方言、offline/streamingを表明。
- vLLMなしのオフライン推論: 公式`qwen-asr`のTransformers backendで可能。
- ストリーミング: 現在の公式READMEではvLLM backend限定。
- CPU実行可否: Transformersの`device_map`機構上の可能性はあるが、Qwen公式例はCUDA指定で、このWindows CPU構成での正式サポートと性能は未確認。
- Windows対応: 公式資料で明示確認できず。
- 必要RAM: 公式資料で確認できず。
- Intel Iris Xe: 公式資料で確認できず。
- 公式資料: https://github.com/QwenLM/Qwen3-ASR 、https://huggingface.co/Qwen/Qwen3-ASR-0.6B

今回はPython、PyTorch、Qwen3-ASR、vLLM、CUDAをインストールしません。
