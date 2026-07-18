# Streaming STT provider research

確認日: 2026-07-15 (Asia/Tokyo)

この資料は各社の公式ドキュメントと公式料金ページだけを参照した。確認できない値は推測していない。料金は税・為替・契約条件・リージョンで変わるため、実装時と本番有効化前に再確認する。

## Summary

| 候補 | 日本語 | Streaming | 暫定/確定 | ブラウザー音声 | 1時間概算 | 無料枠 | 実装難度 | 主な注意点 |
|---|---|---|---|---|---:|---|---|---|
| AmiVoice API | 対応、日本語E2E/会話向けあり | WebSocket | U/Aイベント | WebM Opusを公式対応 | ログ保存なし148.5円、あり99円（税込） | 各エンジン毎月60分、期限記載なし | 低 | 日本語の単語登録/強調が強い。ログ保存ありは提供データを性能向上に利用する場合あり |
| Alibaba Cloud Model Studio Fun-ASR | 対応 | WebSocket/SDK | sentence_end false/true | Opusは記載、WebMコンテナは記載なし | US$0.324 | 10時間、初回有効化から90日 | 中 | 日本からの国際デプロイはSingapore。コンテナ変換要否を実音声で確認する |
| Google Cloud Speech-to-Text V2 | 対応 | 双方向gRPC | interim/isFinal | WEBM_OPUSを公式対応 | US$0.96 | V2の無料枠は公式料金表で確認できず | 中 | 1ストリーム5分。継続会議はストリーム切替が必要 |
| Azure Speech to Text | 対応 | Speech SDK | Recognizing/Recognized | JavaScript SDKの圧縮入力非対応。PCM変換が必要 | 公式料金ページの動的表示で数値確認できず | F0は毎月5音声時間 | 中〜高 | F0同時1、S0既定100。日本東/西リージョンあり |
| OpenAI GPT-Realtime-Whisper | 多言語音声認識 | Realtime WebSocket/WebRTC | delta/completed | audio/pcm 24kHz monoが必要 | US$1.02 | Free tier非対応 | 高 | ライブモデルではプロンプト非対応。WebMからPCM変換が必要 |

## Capability details

| 項目 | AmiVoice API | Alibaba Fun-ASR realtime | Google Cloud STT V2 | Azure Speech | OpenAI GPT-Realtime-Whisper |
|---|---|---|---|---|---|
| 正式サービス/モデル | AmiVoice API、日本語E2E_汎用 `-a2-ja-general` / 会話_汎用 `-a-general` | Alibaba Cloud Model Studio `fun-asr-realtime` | Cloud Speech-to-Text V2 | Azure Speech in Foundry Tools, Speech to text | `gpt-realtime-whisper` |
| 日本語/英語 | 両方。英語は専用/多言語エンジン | 両方 | 両方 | 両方 | 多言語。日本語/英語の実音声評価が必要 |
| 句読点 | 日本語/英語とも自動句読点 | 句読点をword情報に保持 | 自動句読点オプション | Display形式/詳細出力 | 公式資料で保証条件を確認できず |
| タイムスタンプ | 発話start/end、結果にconfidence | 文/単語begin/end | result end offset、単語時刻オプション | Offset/Duration、詳細N-best | ライブ転写の単語時刻は公式資料で確認できず |
| ホットワード | 日本語はユーザー辞書。Hybridは単語登録、E2Eは単語強調。英語ユーザー辞書は非対応 | hot words対応 | SpeechAdaptation/PhraseSet | Phrase list、最大500、重み0.0〜2.0 | `gpt-realtime-whisper` GAはprompt非対応 |
| 接続 | `wss://acp-api.amivoice.com/v1/`、nologは`/v1/nolog/` | DashScope SDKまたはWebSocket | gRPC双方向ストリーミング | Speech SDK | Realtime transcription session over WebSocket/WebRTC |
| 音声形式 | PCM/A-law/mu-law、WAV、Ogg Opus、WebM Opus、MP3、FLAC等 | pcm,wav,mp3,opus,speex,aac,amr | WEBM_OPUS、OGG_OPUS、LINEAR16等 | SDK標準入力はsigned PCM 16-bit mono 8/16k。圧縮はSDK/言語依存 | `audio/pcm`, 24kHz mono |
| サンプルレート | 8/11.025/16/22.05/32/44.1/48kHz、エンジンは8k/16k系 | 例は16k。形式ごとの完全な要件はモデル資料参照 | Opusは8/12/16/24/48kHz | PCM 8kまたは16k | 24kHz |
| 認証 | APIキー。期限/IP制限付き発行可能 | Model Studio API key、リージョン別 | IAM/Application Default Credentials | Speech resource key+region、またはEntra ID | サーバー側Bearer API key |
| 同時接続/レート | 同じAppKeyの同時接続数制限なし。大量時は事前連絡推奨 | `fun-asr-realtime`の明示値は確認できず | 1リージョン300同時ストリーム | F0 1、S0既定100 | Free非対応、Tier 1は音声100分/分。接続数は確認できず |
| 連続時間 | WebSocket最大24時間。無発話600秒、無通信60秒、1発話15秒 | モデル表は音声長Unlimited。無音60秒はheartbeatが必要 | 1ストリーム5分 | 通常リアルタイムの上限は確認できず。リアルタイムdiarizationは240分 | 公式資料で確認できず |
| 日本からのリージョン | 物理データセンター所在地は確認できず | 国際デプロイはSingapore | global/us/eu等。日本国内処理は確認できず | Japan East / Japan West | 日本リージョン指定は確認できず |
| データ保持/学習 | nologは音声/結果を保存しない。loggingは提供に同意し性能向上に使う場合あり | 公式privacy noticeはモデル学習に使わない。保持期間は確認できず | 既定の同期/streamingはメモリ処理、data loggingはopt-in | real-timeはメモリ処理のみ、既定では保存なし。任意ログは30日 | APIは既定で学習不使用。Realtime固有の保持期間は確認できず |
| 個人利用 | Web登録と契約が必要。個人区分の明示条件は確認できず | Alibaba Cloudアカウント/課金設定が必要。個人区分は確認できず | Google Cloudアカウント/課金設定が必要。個人区分は確認できず | Azure subscriptionが必要。個人区分は確認できず | APIアカウント/課金設定が必要 |

## Recommendation

第一候補はAmiVoice API。日本語会議向けエンジン、日本語の単語登録/強調、WebM Opusの直接対応、24時間WebSocket、毎月60分無料、国内通貨の低い単価が現在のアプリに合う。`/v1/nolog/`を既定候補にし、末尾スラッシュを必ず固定・検証する。

第二候補はAlibaba Cloud Model Studio Fun-ASR。低単価、10時間試用、暫定/確定、文/単語時刻、ホットワードが揃う。一方で日本からはSingaporeで、現在のWebMコンテナを直接受ける公式根拠がない。

比較基準はGoogle Cloud Speech-to-Text V2。WEBM_OPUSを公式対応し、機能と制限が明確。ただし5分ごとのストリーム切替と単価が不利。

AmiVoiceを選ばない方がよい条件は、英語でユーザー辞書が必須、日本国外の指定リージョンが必須、または契約/データ処理条件が組織要件を満たさない場合。精度は録音環境、複数話者、専門語、発話速度に左右されるため、同一音声でCER、初回暫定遅延、確定遅延、専門語命中率を比較してから固定する。

## Official sources

### AmiVoice

- https://acp.amivoice.com/amivoice_api/price/
- https://acp.amivoice.com/faq/
- https://docs.amivoice.com/amivoice-api/manual/websocket-interface
- https://docs.amivoice.com/amivoice-api/manual/audio-format/
- https://docs.amivoice.com/amivoice-api/manual/engines
- https://docs.amivoice.com/en/amivoice-api/manual/supported-languages
- https://docs.amivoice.com/amivoice-api/manual/user-dictionary/
- https://docs.amivoice.com/amivoice-api/manual/log-retention/
- https://docs.amivoice.com/amivoice-api/manual/limitations/

### Alibaba Cloud

- https://www.alibabacloud.com/help/en/model-studio/model-pricing
- https://www.alibabacloud.com/help/en/model-studio/asr-model/
- https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide
- https://www.alibabacloud.com/help/en/model-studio/fun-asr-server-events
- https://www.alibabacloud.com/help/en/model-studio/improve-asr-accuracy
- https://www.alibabacloud.com/help/en/model-studio/new-free-quota
- https://www.alibabacloud.com/help/en/model-studio/privacy-notice

### Google Cloud

- https://docs.cloud.google.com/speech-to-text/docs/overview
- https://cloud.google.com/speech-to-text/pricing
- https://docs.cloud.google.com/speech-to-text/docs/encoding
- https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages
- https://docs.cloud.google.com/speech-to-text/docs/quotas
- https://docs.cloud.google.com/speech-to-text/docs/v1/adaptation
- https://docs.cloud.google.com/speech-to-text/docs/v1/data-usage-faq
- https://docs.cloud.google.com/speech-to-text/docs/libraries

### Microsoft Azure

- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-speech-to-text
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-use-audio-input-streams
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-use-codec-compressed-audio-input-streams
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
- https://azure.microsoft.com/en-us/pricing/details/speech/
- https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security

### OpenAI

- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/models/gpt-realtime-whisper
- https://developers.openai.com/api/docs/models/gpt-4o-transcribe
- https://help.openai.com/en/articles/5722486-api-data-usage-policies
