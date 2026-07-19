# アーキテクチャ

## 全体経路

```text
Browser microphone
→ 16 kHz mono PCM16
→ PendingAudioQueue / IndexedDB audio buffer
→ WebSocket
→ server session
→ SttProvider
→ Local Whisper provider / VAD
→ rawText
→ independent correction queue
→ correctedText
→ UI / correction IndexedDB
```

各段階は別の責務です。整文や要約の失敗で録音・STT・WebSocketを止めない設計を維持します。

## 音声処理

ブラウザーの`AudioCapture`がマイク入力を取得します。Local Whisper経路では16 kHz、mono、PCM16へ変換し、sequence付きフレームとして送ります。送信前の音声は`PendingAudioQueue`へ保存し、`audio_ack`後だけ削除します。

`audio_ack`はサーバーがフレームを検証し、STT providerが受理したことを示し、文字起こし完了を意味しません。切断時は未ackフレームを保持し、同じsessionのresume後に必要分だけ順序どおり再送します。

## STT

サーバー上位層は`server/src/providers/types.ts`の`SttProvider`だけを扱います。共通境界は`SttSessionConfig`、`SttAudioChunk`、`SttTranscriptResult`、セッション停止、`dispose`を持ちます。生成は`server/src/providers/providerFactory.ts`へ集約しています。`STT_PROVIDER`未指定時は`local`、モデルなしのMock開発時だけ`mock`を明示します。未知の値は安全な設定エラーです。

現在の実装はMockと`LocalWhisperServerProvider`です。Local provider内部だけがサーバーPC内の`whisper-cli.exe`、モデル、PCM VAD、FIFO、一時WAVを知ります。停止時はVAD残音をflushして処理完了を待ち、cancel、異常切断後のTTL失効、サーバー停止ではproviderを破棄します。Whisperプロセスはcancel/サーバー停止で終了し、一時WAVは成功・失敗のどちらでも削除します。

共通結果は同じ`segmentId`のpartialをrevisionで更新でき、finalを一度だけ確定できます。Local Whisperのファイル認識はpartialを返さないため、疑似partialは生成せず全結果をfinalとして出します。partialは一時表示だけに使い、`TranscriptStore`、整文、要約、IndexedDBの確定起点にはしません。

外部STTアダプターは本運用されていません。外部STTは`STT_EXTERNAL_ENABLED=false`が既定です。クラウドSDK、実API接続、APIキー、クラウドモデル設定はありません。モデルや実行ファイルは`server/data/`へ置き、Gitへ含めません。

## transcript

STTの確定segmentは`SentenceAssembler`で発話単位にまとめられます。`rawText`はWhisper原文として保持し、整文で上書きしません。発話順序とセッション整合性は既存storeで管理します。

## 整文

整文はSTT FIFOとは別のキューです。現在実装されているproviderは外部通信しない決定論的Mockです。

```text
rawText保存・UI表示
→ correction要求
→ strict JSON検証
→ 保護トークン照合
→ correctedText保存
```

失敗、timeout、不正出力、cancelでは`correctedText=rawText`へフォールバックします。数字・URL等の保護は保守的な文字列規則であり、完全な自然言語理解ではありません。

## 要約

要約はtranscriptと別データです。UIにはライブ要約の表示領域がありますが、実AI要約は今回の運用対象ではありません。Mockと既存のprovider接続点はあります。`SUMMARY_ENABLED=false`が既定で、要約がなければ空状態を表示します。

## UI

`home`、`meeting`、`meeting-detail`の軽量な画面状態を持ちます。会議中画面は同じスクロール領域に要約と文字起こしを置き、最新位置を見ているときだけ自動追従します。発話詳細からrawText、correctedText、整文状態、uncertainPartsを確認できます。

UIの表示切替は録音・接続・transcript storeを暗黙に初期化しません。一時停止は既存のstop／flushを使い、同じ会議表示へ次のSTTセッションを追加します。

## 永続化

- 未ack音声: ブラウザーの音声バッファ用IndexedDB
- 整文レコード: rawTextとcorrectedTextを含むIndexedDB
- サーバーローカル評価・デバッグ: `server/data/`（Git対象外）

会議履歴全体の本格永続化、ページ再読込からの会議復元、共有データベースは未実装です。

## 将来の外部provider

外部STTを追加する場合は、新しい`SttProvider`を実装してprovider factoryへ登録します。WebSocket/session/store以降は変更せず、provider内部でクラウド固有の音声形式、SDKイベント、partial/final、cancelを共通型へ変換します。音声または文字起こしが外部送信されるため、UI表示、明示的opt-in、認証、予算、timeout、保持方針、利用規約、監査ログを別途設計する必要があります。現在のリポジトリがその要件を満たすとは扱いません。
