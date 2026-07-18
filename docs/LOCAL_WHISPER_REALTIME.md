# Local Whisper実験統合

この経路は実験用です。Browser認識、フロントMock、WebSocketモックを既定動作のまま残し、`LOCAL_STT_ENABLED=false`ではLocal Whisperを起動しません。`STT_EXTERNAL_ENABLED=false`を維持し、音声認識時の外部通信、モデル取得、外部API呼び出しは行いません。

## 起動

PowerShellでサーバーだけに明示設定を渡します。

```powershell
$env:STT_EXTERNAL_ENABLED='false'
$env:LOCAL_STT_ENABLED='true'
$env:LOCAL_STT_MODEL='small-q5_1'
$env:LOCAL_STT_THREADS='4'
pnpm run dev:server
```

別のターミナルで`pnpm run dev`を実行し、認識方式から「Local Whisper small」を選びます。サーバーは既存の`server/data/local-stt/models/ggml-small-q5_1.bin`と`server/data/local-stt/bin/v1.9.1/Release/whisper-cli.exe`だけを使用し、初回セッション開始時に配置場所とSHA-256を検証します。

## 音声と発話確定

ブラウザー内でWeb Audio APIの入力をmonoへダウンミックスし、16 kHzへリサンプリングしてsigned 16-bit little-endian PCMを生成します。WebSocketにはWAVヘッダーではなく、PCM payloadとsample rate、channel、encoding、frame countを分けて送ります。サーバーは20 ms窓のRMSを用います。現在の推奨設定は連続2窓で発話開始、300 msのpre-speech、1,300 msの無音、最大20,000 ms、最短300 msです。確定後にだけ正しいPCM WAVを一時生成します。

`audio_ack`は、サーバーがsequenceを検証し、PCMを発話バッファまたは上限付きFIFOへ安全に格納した時点を意味します。Whisper完了は待ちません。同じsequenceの再送は再処理せず再ackします。切断中に完成したfinal/status/errorはセッションTTL中だけメモリに保留し、`resumed`の後に元の順序で配送します。

通常時は計測JSONLも作りません。`LOCAL_STT_DEBUG_METRICS=true`を明示した場合だけ、Git対象外の`server/data/local-stt/results/realtime/`へ発話時間、処理時間、RTF、待ち時間、segment数、終了コードなどを保存します。音声と認識全文は含めません。

## Whisper実行

発話ごとに`whisper-cli.exe`を安全な引数配列で起動します。引数は`--model`、`--file`、`--language ja|en`、`--threads 4`、`--no-prints`、`--no-gpu`です。`--no-timestamps`は指定せず、Whisperのタイムスタンプ行だけを認識segmentとして解析します。同時実行は1、処理はFIFO、一時WAVは終了時に削除します。通常ログへ音声や認識全文を出しません。

## 明示スモークテスト

```powershell
$env:STT_EXTERNAL_ENABLED='false'
pnpm run smoke:local:realtime
```

既存`server/data/local-stt/input/ja.wav`の先頭10秒をメモリ上でPCMチャンク化し、実WebSocketプロバイダーと同じLocal Whisperサービス層で、VAD、WAV生成、Whisper起動、タイムスタンプ解析、final生成を確認します。認識全文は出力せず、そのSHA-256と件数、処理指標だけを表示します。

## 制限

- ファイル単位CLIなので真のinterimはありません。UIは録音中、認識待ち、認識中、完了を区別します。
- Whisperプロセスとモデルは発話ごとに読み込みます。常駐化はしていません。
- エネルギーベースVADの閾値はマイクや環境音に応じた実機調整が必要です。
- PCMのリサンプリングは入力callback単位の線形補間です。AudioWorkletによる連続位相リサンプラーは今後の候補です。
- 通常オーバーラップ、話者分離、辞書、initial prompt、フィラー除去、要約AIは未実装です。

## Whisper入力WAVの開発用保存

通常は無効です。サーバー環境変数で明示した場合だけ、Whisperへ渡す一時WAVとバイト単位で同一のコピーをGit対象外のローカル領域へ保存します。クライアントやUIから保存先を指定したり、有効化したりはできません。

```powershell
$env:STT_EXTERNAL_ENABLED='false'
$env:LOCAL_STT_DEBUG_AUDIO='true'
$env:LOCAL_STT_DEBUG_AUDIO_DIR='server/data/local-stt/debug/realtime-audio'
$env:LOCAL_STT_DEBUG_AUDIO_MAX_FILES='20'
$env:LOCAL_STT_DEBUG_AUDIO_MAX_BYTES='500000000'
pnpm run dev:server
```

保存前後のWAVはSHA-256で照合します。同名のmetadata JSONには音声形式、RMS、Peak、clipping率、DC offset、低振幅率、先頭・末尾300 msのRMS、VAD設定、モデルと実行ファイルのSHA-256、処理時間、RTF、segment数、認識結果のSHA-256を保存します。認識全文は保存しません。上限到達時は既存音声を削除せず、新しい保存だけを停止して安全な警告を記録します。Whisper入力用の一時WAVは、保存設定に関係なく従来どおり処理後に削除します。

保存音声には個人情報が含まれる可能性があります。不要になったらサーバーを停止し、内容を確認した上で `server/data/local-stt/debug/realtime-audio/` 配下の対象WAV、metadata、comparison JSONを手動削除してください。自動クラウド同期や外部送信は行いません。

## 同一WAVのオフライン再認識

保存WAVだけを許可する比較CLIです。通常実行は認識全文を表示せず、SHA-256、文字数、segment数、処理時間、RTF、診断、判定だけを出力し、同じGit対象外ディレクトリへcomparison JSONを保存します。

```powershell
pnpm run compare:local:realtime -- "server/data/local-stt/debug/realtime-audio/realtime-....wav"
```

人間が明示的に全文を確認する場合だけ `--show-transcript` を追加します。

```powershell
pnpm run compare:local:realtime -- "server/data/local-stt/debug/realtime-audio/realtime-....wav" --show-transcript
```

- `identical`: 同一最終WAVで同じ認識SHAが再現したため、WebSocket配送やUI表示が原因である可能性は低くなります。ただし、ブラウザー側リサンプリングやVAD境界はまだ除外できません。
- `text-different`: 同じWAVでも結果が異なるため、実行引数、環境変数、provider経路、stdout解析、timestamp解析、テキスト結合、並行処理やcancelの差を確認します。
- `configuration-different`: model、language、threads、timestamp、CPU引数などが一致していません。
- `audio-mismatch` / `invalid-audio`: Whisperを起動せず停止します。
- `runtime-error`: 実行失敗を安全なエラーコードで記録します。

## 実マイクでの切り分け手順

1. `LOCAL_STT_ENABLED=true`、`LOCAL_STT_DEBUG_AUDIO=true`、`STT_EXTERNAL_ENABLED=false`でサーバーを起動します。
2. Local Whisper smallを選び、「今日はローカル音声認識の動作確認を行います。人工知能と音声認識について話しています。」と話します。
3. 文章途中で約1秒だけ間を空け、1300 ms未満では発話が分割されないか確認します。
4. 話し終わって2秒黙り、final transcriptを確認します。
5. 保存されたWAVとmetadataを確認し、比較CLIを実行します。
6. 追加確認では「最初の発言です。今日は天気について話します。」の後に約1秒待ち、「次の発言です。明日の予定について確認します。」と続けます。
