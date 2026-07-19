# Cloud STT Provider Evaluation

## Status and scope

- Status: **Under evaluation**
- Confirmed: 2026-07-19 (JST)
- Target: the server-side `SttProvider` boundary in this repository
- Regions evaluated: Alibaba Cloud international service in Singapore, and the most suitable official region for each other provider
- Excluded: account creation, billing activation, API keys, live API calls, audio upload, SDK installation, and provider implementation

Prices and quotas can change. Recheck the linked official pricing page, the selected region, the billing account, and tax treatment immediately before any paid test. Japanese recognition quality cannot be established from model specifications; it requires the synthetic benchmark in `CLOUD_STT_BENCHMARK_PLAN.md`.

## Existing application boundary

The current application already has a `SttProvider` contract with session lifecycle, audio delivery, transcript, error, and status callbacks. Local Whisper and Mock implement it. External STT is disabled by default. Browser audio is normally 16 kHz, mono, signed little-endian PCM16. A partial result updates one `segmentId`; only final results enter `rawText`, persistence, correction, and later summary processing. API credentials belong only in the Node.js server.

Consequently, a cloud provider should normally require a provider file, a testable transport boundary, configuration and factory additions, and protocol-event mapping. A shared browser protocol change is not expected unless a provider cannot accept the existing audio or result semantics.

## Executive conclusion

The first prototype candidate is **Alibaba Cloud Fun-ASR Realtime in the international Singapore region**. It accepts the existing 16 kHz PCM16 stream directly, documents interim/final results, supports Japanese and hotwords, exposes a direct WebSocket protocol, costs USD 0.324 per audio hour, includes a 10-hour/90-day free quota, and offers a Free Quota Only control.

The second prototype candidate is **Alibaba Cloud Qwen3-ASR-Flash Realtime**. It has the same published rate and free quota and similarly fits 16 kHz PCM, but it does not currently provide hotword/accuracy-boosting controls. Its newer multilingual model and emotion metadata make it useful as an A/B comparison against Fun-ASR.

This is a recommendation to build a fake-transport implementation and then run a capped free-quota benchmark, not a production selection. Contract owner, billing owner, consent UI, DPA review, exact retention, and measured Japanese meeting accuracy remain approval gates.

## Candidate comparison

| Candidate | Current model | Evaluated region | Japanese | 16 kHz mono PCM16 | Partial | Final | Transport | Hotwords | Speaker separation | Pricing basis | 1-hour estimate | Free quota | After free quota | Free-only stop | Data retention | Implementation | Main advantage | Main drawback | Official check |
|---|---|---|---|---|---|---|---|---|---|---|---:|---|---|---|---|---|---|---|---|
| Alibaba Cloud Qwen3-ASR-Flash Realtime | `qwen3-asr-flash-realtime`; snapshots `2026-02-10`, `2025-10-27` | Singapore international | Yes | Yes, PCM at 16,000 Hz | `...transcription.text` | `...transcription.completed` | Direct WebSocket or SDK | No | No | USD 0.000090/audio second; output free | $0.324 | 36,000 s (10 h), 90 days after activation | Profile completed: PAYG automatically; incomplete profile: stops with 403 | Yes, if Free Quota Only is enabled | Transient inference-node data not persisted; request/result/static data stays in Singapore; exact log/static retention requires inquiry | Small | Direct audio fit, low price, newer multilingual model | No hotwords; Japanese meeting accuracy and exact retention unverified | 2026-07-19 |
| Alibaba Cloud Fun-ASR Realtime | `fun-asr-realtime` / `2025-11-07` | Singapore international | Yes | Yes, PCM at 16,000 Hz | `sentence_end=false` | `sentence_end=true` | Direct WebSocket or SDK | Yes, custom vocabulary | No | USD 0.00009/audio second; output free | $0.324 | 36,000 s (10 h), 90 days after activation | Same Alibaba account behavior | Yes | Same Singapore conditions; exact operational retention requires inquiry | Small | Existing audio fits, hotwords, timestamps, duration usage | Older event family; no diarization; accuracy unverified | 2026-07-19 |
| OpenAI Realtime Transcription | `gpt-realtime-whisper` | US; EU residency subject to eligibility/approval | Yes | No; realtime PCM requires 24 kHz mono | `...transcription.delta` | `...transcription.completed` | Server-to-server WebSocket | No for current GA realtime model | No in realtime transcription | USD 0.017/audio minute | $1.02 | No generally guaranteed recurring API free tier | Prepaid/PAYG balance is charged; delayed cutoff can exceed balance | No hard project cap; prepaid exhaustion rejects after possible delay | API data not trained by default; `/v1/realtime` abuse monitoring up to 30 days by default; ZDR eligible by approval | Medium | Clear realtime event model and server WebSocket | Stateful 16→24 kHz resampling, higher price, no Japan/Singapore residency | 2026-07-19 |
| Google Cloud Speech-to-Text V2 | `chirp_3` | US/EU multi-region for Chirp 3 | Yes (`ja-JP`) | Yes, LINEAR16; 16 kHz recommended | `isFinal=false` | `isFinal=true` | Bidirectional gRPC via official SDK | Phrase/adaptation biasing | Not in Chirp 3 streaming (batch only) | USD 0.016/audio minute, standard 0–500k min | $0.96 | New-customer USD 300/90 days; not a recurring V2 STT allowance | Trial stops unless account is manually upgraded; paid account is PAYG | Trial has a spending limit; paid budgets are alerts, not hard caps | Without data logging, streaming audio is processed in memory and not stored; metadata may be temporarily logged | Medium | Strong format fit and clear privacy controls | Five-minute stream limit, gRPC/SDK dependency, US/EU processing | 2026-07-19 |
| Azure AI Speech realtime | Current Speech-to-Text real-time model for selected Speech resource | Selectable Azure Speech region; Japan East is offered in region selector | Yes (`ja-JP`) | Yes, signed int16 mono at 8/16 kHz | `Recognizing` | `Recognized` | Official Speech SDK | Phrase list | Available in Speech features; exact Japanese realtime constraints require benchmark | F0 free; PAYG amount must be re-read from official calculator for region/contract | Unknown | F0: 5 audio h/month for real-time STT | F0 quota rejects until reset; moving to paid tier is explicit | F0 quota acts as a service limit; paid budgets are alerts only | Realtime audio is not retained by default; optional logging stores data for 30 days | Medium | Monthly F0 quota, 16 kHz fit, Japan-region option, clear no-storage default | Official PAYG table did not expose a stable USD value; SDK dependency | 2026-07-19 |
| Amazon Transcribe Streaming | Amazon Transcribe Streaming (`ja-JP`) | Tokyo (`ap-northeast-1`) available | Yes | Yes, raw signed 16-bit LE PCM; 16 kHz supported | `IsPartial=true` | `IsPartial=false` | HTTP/2 SDK or signed WebSocket event stream | Custom vocabulary | Streaming diarization available; validate Japanese test behavior | Regional PAYG; US East reference USD 0.024/min, 15 s minimum/request | $1.44 at US East reference rate | 60 min/month for 12 months from first request | Automatically PAYG after quota | No STT-specific hard free-only switch; budgets are delayed | Streaming session data is not separately stored at rest, but service-improvement use is enabled by default unless organization opts out | Medium | 16 kHz fit, Tokyo, mature partial/final and speaker features | Higher price, SigV4/binary framing, opt-out governance required | 2026-07-19 |
| Local Whisper baseline | `small-q5_1` local configuration | Local machine | Yes | Yes | No | Yes | Local child process | No | No | No cloud usage charge | $0 cloud fee | Not applicable | Not applicable | Not applicable | Audio remains local except application storage/log choices | Existing | Best privacy and no cloud billing | Final-only, local compute and observed accuracy/latency limits | 2026-07-19 |

### Normalization and punctuation

All cloud candidates document punctuation or formatted transcript output, but number/date normalization differs by language and model. Alibaba Fun-ASR exposes punctuation and word timestamps; Qwen returns a transcript and language metadata. Google provides automatic punctuation; Azure supports display formatting; AWS returns word/punctuation items; OpenAI returns model transcript text. None of these official capability statements guarantees correct Japanese date, numeral, or proper-noun formatting. Benchmark those cases rather than treating “punctuation supported” as accuracy proof.

## Technical details by provider

### Alibaba Cloud Qwen3-ASR-Flash Realtime

- International Singapore endpoint: workspace-specific `wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?...`.
- Authentication is sent by the Node.js WebSocket handshake. It must never enter a browser variable, browser protocol, health response, or log.
- Client events include `session.update`, `input_audio_buffer.append`, optional manual `input_audio_buffer.commit`, and `session.finish`.
- Server transcript events include `conversation.item.input_audio_transcription.text` and `.completed`; `item_id` can map to stable `segmentId` and a provider-local monotonic revision.
- Server VAD and manual commit modes are documented. PCM at 16,000 Hz means no application-wide resampler is necessary.
- A single append is documented up to 15 MiB, but this application should use a much smaller bounded queue and chunk size.
- Hotword/accuracy boost is not supported for this current realtime family. Emotion recognition is available but not required by the shared protocol.
- The model guide lists no speaker diarization and an unlimited model audio duration; transport/workspace timeout and heartbeat still impose connection-management requirements.

### Alibaba Cloud Fun-ASR Realtime

- Uses the DashScope task WebSocket event family: `task-started`, repeated `result-generated`, `task-finished`, and `task-failed`.
- A sentence with `sentence_end=false` is interim and the same sentence with `sentence_end=true` is final. `sentence_id` and timestamps provide a natural stable segment/order key.
- PCM at 16,000 Hz and Japanese language hints are documented. The provider can send the current browser PCM without resampling.
- Custom vocabulary/hotwords can improve university names and technical terms. This is its largest functional advantage over Qwen realtime.
- VAD silence is configurable. Semantic punctuation mode changes segmentation behavior, so the first prototype should leave defaults and benchmark both only under a separate explicit case.
- `usage.duration` in the terminal event provides billable task duration without logging transcript text.
- Heartbeat should be enabled for long silence. Reconnect after audio transmission should fail safely rather than replay unacknowledged audio and risk duplicate transcripts.

### OpenAI Realtime Transcription

- Server WebSocket: `wss://api.openai.com/v1/realtime?model=...` with bearer authentication on the server.
- Current live transcription documentation identifies `gpt-realtime-whisper`; sessions use `type: "transcription"`.
- Input audio is 24 kHz mono PCM for `audio/pcm`. A stateful 16→24 kHz resampler is required inside this provider only.
- Events are `session.update`, `input_audio_buffer.append`, `input_audio_buffer.commit`, `conversation.item.input_audio_transcription.delta`, and `.completed`.
- Completion order across items is not guaranteed, so `item_id` plus creation/previous-item ordering must be maintained.
- Current GA realtime model does not support prompt/hotword steering and uses manual commit rather than server VAD in the documented setup.

### Google Cloud Speech-to-Text V2

- `chirp_3` supports Japanese and `StreamingRecognize` in US/EU multi-regions.
- `LINEAR16` signed PCM at 16 kHz can be sent directly. Streaming responses distinguish interim/final through `isFinal` and can include stability and voice-activity events.
- Bidirectional gRPC is the supported transport. Node.js normally uses the official Google client library, which would add a dependency.
- Each audio message is limited to 15 KB and a stream lasts at most five minutes. A provider must rotate streams without duplicating or reordering final results.
- Phrase adaptation is available. Streaming speaker diarization is not available for Chirp 3; official documentation lists diarization for batch.

### Azure AI Speech

- JavaScript/Node Speech SDK supports push streams of signed 16-bit mono PCM at 16 kHz.
- `Recognizing` is interim, `Recognized` is final, and `Canceled` carries failures. Stop/cancel/dispose map naturally to SDK lifecycle calls.
- Phrase lists and output formatting are documented. Realtime diarization exists in the service, but its exact Japanese meeting behavior needs an empirical test.
- The supported SDK boundary is testable only after wrapping it in an application transport adapter; adding that SDK would be a reviewed dependency change.
- The official pricing page exposes F0 but renders paid prices dynamically by region/agreement. No fixed paid USD amount is recorded here.

### Amazon Transcribe Streaming

- Tokyo supports streaming and `ja-JP`. Raw PCM is signed 16-bit little-endian, and 16 kHz is accepted directly.
- Each result has a stable result ID and `IsPartial`; partial-result stabilization is configurable. Final results carry timestamps/confidence.
- Direct WebSocket requires SigV4 signing and AWS event-stream binary frames; the official SDK reduces protocol work but adds a dependency.
- The stream ends with an empty audio event. A provider must serialize result IDs and avoid automatic audio replay after a mid-stream disconnect.
- The documented rate has a 15-second minimum for each request, which matters for many short sessions.

## Price comparison

USD, excluding tax, exchange, support plans, network charges, and local hardware/electricity. Alibaba and OpenAI amounts are exact conversions of the published rate. Google uses the first V2 standard tier. AWS uses the official US East reference rate because Tokyo's current amount must be confirmed in the regional calculator. Azure paid values are intentionally not estimated.

| Candidate | Per minute | Per hour | 10 hours | 100 hours | Output charge | Minimum/fixed fee | Meter |
|---|---:|---:|---:|---:|---|---|---|
| Alibaba Cloud Qwen3-ASR-Flash Realtime | $0.0054 | $0.324 | $3.24 | $32.40 | Free | No published fixed fee | Input audio seconds |
| Alibaba Cloud Fun-ASR Realtime | $0.0054 | $0.324 | $3.24 | $32.40 | Free | No published fixed fee | Input audio seconds |
| OpenAI `gpt-realtime-whisper` | $0.017 | $1.02 | $10.20 | $102.00 | Included in duration rate | No published fixed fee | Audio duration |
| Google STT V2 standard | $0.016 | $0.96 | $9.60 | $96.00 | Included | No fixed fee | Audio seconds, rounded per second |
| Azure AI Speech PAYG | Unknown | Unknown | Unknown | Unknown | Unknown/contract-dependent | F0 has no fixed fee | Audio seconds; verify calculator |
| AWS Transcribe Streaming | $0.024 | $1.44 | $14.40 | $144.00 | Included | 15-second minimum/request | Audio seconds, US East reference |
| Local Whisper | $0 cloud | $0 cloud | $0 cloud | $0 cloud | None | Local hardware/energy not quantified | Local compute |

### Free quota and billing behavior

| Candidate | Free use | Expiry | Payment setup | Exhaustion behavior | Hard free-only control |
|---|---|---|---|---|---|
| Alibaba Qwen/Fun | 10 audio hours/model | 90 days after activation for the listed Singapore models | Incomplete profile can use quota but cannot continue; PAYG requires completed account/profile and supported payment | Completed profile automatically moves to PAYG unless guarded; incomplete profile stops with 403 | **Free Quota Only** stops calls with 403 after quota |
| OpenAI | No generally guaranteed recurring API quota | Not applicable; any promotional credit is account-specific | Individual/team API commonly uses prepaid card balance or auto billing; enterprise may invoice | Requests eventually fail when prepaid quota is exhausted, but cutoff can be delayed and produce negative balance | No hard project budget; auto-recharge can be disabled |
| Google | New customer $300 credit | 90 days | Payment method is required for identity verification; not charged during trial unless manually upgraded | Trial stops/closes resources unless manually upgraded; upgraded billing account becomes PAYG | Trial spending limit only; paid budgets do not cap |
| Azure | F0 5 audio h/month | Resets monthly while F0 terms remain | Azure subscription/account required; free account may require payment verification | F0 throttles/rejects over quota; paid tier is an explicit resource/tier choice | F0 quota; PAYG has no spending limit |
| AWS | 60 min/month | 12 months from first transcription request | AWS account normally requires a valid payment method | Automatically bills PAYG beyond free usage | No Transcribe free-only switch; budgets/actions are delayed |

## Privacy and regional processing

| Candidate | Processing region | Training/service improvement | Default storage/retention | Required pre-production action |
|---|---|---|---|---|
| Alibaba Qwen/Fun | Singapore international; global inference nodes excluding mainland China, with request/result/static data associated with Singapore | Model Studio states customer data is not used for model training | Transient inference-node data is not persisted; exact static/operational log retention and deletion is not stated clearly | Obtain DPA/retention/subprocessor answer and meeting-participant consent; use workspace endpoint |
| OpenAI | US; approved EU data residency option | API data is not used for training unless opted in | Realtime endpoint has default abuse-monitoring retention up to 30 days; ZDR is eligibility/approval based | Confirm organization eligibility, DPA and residency; consent UI |
| Google | Chirp 3 US/EU multi-region | Not used for improvement unless data logging is explicitly opted in | With logging disabled, streaming audio is processed in memory and not stored; metadata may be temporarily logged | Keep data logging off; select endpoint; review DPA/subprocessors |
| Azure | Selected Speech resource region, including Japan options | Customer content is not used outside configured service terms | Realtime/fast transcription not retained by default; optional logging retains for 30 days | Keep logging off; validate region/DPA/subprocessors and consent |
| AWS | Selected AWS region, including Tokyo | Content may be stored/used for service improvement by default | Current service card says streaming input/output is not separately stored at rest beyond the session; improvement-use policy is a separate control | Apply AWS Organizations AI-services opt-out, confirm account organization/DPA and consent |
| Local Whisper | User device/server | No provider training | Application-controlled local files/logs only | Maintain local retention/deletion policy |

All cloud services still generate account, security, usage, and billing metadata. “Audio not retained” does not mean “no operational logs.” Exact retention, deletion, subprocessors, cross-border processing, and the legal basis for meeting-participant consent must be reviewed under the contract chosen by the university/team. Where the public product page is incomplete, the answer is **要問い合わせ**.

## Fit with `SttProvider`

| Candidate | Provider + transport | Shared protocol | Resampler | Partial/final mapping | Ordering/stop | Fake transport | New npm dependency | Effort |
|---|---|---|---|---|---|---|---|---|
| Alibaba Qwen | New provider and direct-WS transport | None expected | No | `item_id`, text/completed | Track item creation/previous IDs; finish and bounded final wait | Yes | No; existing `ws` fits | Small |
| Alibaba Fun | New provider and task-event WS transport | None expected | No | `sentence_id`, sentence_end | Sequence IDs; finish and task-finished wait | Yes | No; existing `ws` fits | Small |
| OpenAI | New provider, WS transport, protocol parser, resampler | None expected | Stateful 16→24 kHz | `item_id`, delta/completed | Explicit item order; commit and bounded wait | Yes | No; existing `ws` fits | Medium |
| Google | New provider and gRPC adapter | None expected | No | result identity must be synthesized per stream/result index | Five-minute rotation and cross-stream order | Yes | Likely official Google SDK | Medium |
| Azure | New provider and Speech SDK adapter | None expected | No | SDK event IDs/revisions | SDK stop/final wait; adapter-owned order | Yes | Likely Speech SDK | Medium |
| AWS | New provider and AWS event-stream adapter | None expected | No | stable ResultId and IsPartial | one stream; empty audio end; no replay | Yes | Likely AWS SDK; otherwise SigV4/framing | Medium |
| Local | Existing | Existing | No | Final only | Existing implementation | Existing tests | None | Existing baseline |

For every cloud implementation, acknowledgment must still mean the server has safely accepted or bounded-queued the chunk, not that cloud recognition is final. Unbounded audio queues and transparent replay after an uncertain disconnect are prohibited.

## Weighted assessment

Weights: Japanese meeting fit 25, pricing/free quota 20, realtime behavior 15, current 16 kHz fit 10, privacy/region 10, implementation effort 10, billing stop/control 5, official-document clarity 5.

Scores measure documented fit, not recognition accuracy. Unknown or contract-dependent fields are deliberately penalized.

| Candidate | Japanese /25 | Price /20 | Realtime /15 | 16 kHz /10 | Privacy /10 | Effort /10 | Billing /5 | Docs /5 | Total /100 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Alibaba Cloud Fun-ASR Realtime | 20 | 20 | 14 | 10 | 6 | 9 | 5 | 5 | **89** |
| Alibaba Cloud Qwen3-ASR-Flash Realtime | 18 | 20 | 14 | 10 | 6 | 9 | 5 | 5 | **87** |
| Local Whisper baseline | 17 | 20 | 7 | 10 | 10 | 10 | 5 | 4 | **83** |
| Azure AI Speech realtime | 19 | 13 | 14 | 10 | 9 | 6 | 4 | 3 | **78** |
| Google Cloud STT V2 | 20 | 13 | 12 | 10 | 8 | 5 | 2 | 5 | **75** |
| Amazon Transcribe Streaming | 17 | 9 | 13 | 10 | 5 | 5 | 2 | 4 | **65** |
| OpenAI Realtime Transcription | 18 | 10 | 13 | 4 | 6 | 6 | 1 | 5 | **63** |

Interpretation:

- Fun-ASR leads because it combines the lowest documented rate, a hard free-quota guard, direct 16 kHz PCM, interim/final events, and hotwords. Its privacy score is capped until retention/subprocessor terms are answered.
- Qwen is nearly equal but loses Japanese-meeting points because it has no hotword control. It remains important because model-family accuracy may outperform Fun-ASR despite that specification difference.
- Local Whisper remains the privacy and billing baseline, not the preferred cloud candidate.
- Azure is promising because of F0, 16 kHz and regional options, but paid cost is not recorded until the official calculator is checked for the actual subscription.
- Google is well documented but requires five-minute stream rotation and US/EU processing for Chirp 3.
- AWS fits the audio and Tokyo region but costs more and needs explicit service-improvement opt-out governance.
- OpenAI has a clean WebSocket design but needs resampling, has no hard free-only control, and is materially more expensive than Alibaba.

## Recommendation

### First candidate: Alibaba Cloud Fun-ASR Realtime

Build only after account/billing/privacy approval. Start with a fake transport, then a strictly capped Free Quota Only trial. Use Singapore international, 16 kHz PCM, Japanese language hint, heartbeat, default VAD, and no transcript logging. Benchmark hotwords for university and technical names.

### Second candidate: Alibaba Cloud Qwen3-ASR-Flash Realtime

Implement or test against the same synthetic corpus as a model-family A/B comparison. Use the current stable alias and separately record a snapshot only when reproducibility is needed. Do not assume its newer generation is more accurate than Fun-ASR for Japanese meetings.

### Hold

- Azure: retain as the strongest non-Alibaba fallback; resolve paid regional price and SDK dependency first.
- Google: retain for a quality/privacy comparator; accept gRPC dependency and five-minute stream rotation only after design review.
- OpenAI: hold because of 24 kHz conversion, cost, no hard cap, and residency constraints.
- AWS: hold until service-improvement opt-out is organizationally enforced and Tokyo price is rechecked.
- Local Whisper: keep as the offline baseline and fallback; do not remove it.

## Open questions and approval gates

1. Who is the contracting party, billing owner, budget approver, data controller, and incident contact? All are currently undecided.
2. Will Alibaba Cloud confirm exact retention/deletion and subprocessors for international Singapore realtime ASR in writing?
3. Does the university/team approve Singapore processing and participant consent wording?
4. Does Fun-ASR or Qwen produce better Japanese WER/CER, latency, ordering, and proper nouns on the synthetic benchmark?
5. Can Free Quota Only be enabled and independently verified before any API key is issued to the application team?
6. What are the current concurrent-connection and rate quotas for the chosen workspace?
7. What server-side daily/monthly audio limits and emergency credential revocation procedure are approved?

## Official source register

All links were checked on 2026-07-19. “No page date” means the official page did not expose a stable update date in the retrieved content.

| Provider | Official document | Provider page date | Region/scope | URL |
|---|---|---|---|---|
| Alibaba Cloud | Model inference pricing | 2026-07-15 | Singapore international | https://www.alibabacloud.com/help/en/model-studio/model-pricing |
| Alibaba Cloud | Speech recognition model guide | July 2026 | Singapore international | https://www.alibabacloud.com/help/en/model-studio/asr-model/ |
| Alibaba Cloud | Real-time speech recognition user guide | July 2026 | Singapore international | https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide |
| Alibaba Cloud | Qwen-ASR Realtime interaction process | 2026-07-02 | Singapore international | https://www.alibabacloud.com/help/en/model-studio/qwen-asr-realtime-interaction-process |
| Alibaba Cloud | Qwen-ASR Realtime client/server events | 2026-03-15 / current | Singapore international | https://www.alibabacloud.com/help/en/model-studio/qwen-asr-realtime-client-events |
| Alibaba Cloud | Fun-ASR client/server events | 2026-07-03 for server events | Singapore international | https://www.alibabacloud.com/help/en/model-studio/fun-asr-server-events |
| Alibaba Cloud | Improve speech recognition accuracy | July 2026 | Singapore international | https://www.alibabacloud.com/help/en/model-studio/improve-asr-accuracy |
| Alibaba Cloud | Free quota for new users | 2026-06-23 | Singapore international | https://www.alibabacloud.com/help/en/model-studio/new-free-quota |
| Alibaba Cloud | Model Studio regions | 2026-06-30 | Singapore international | https://www.alibabacloud.com/help/en/model-studio/regions/ |
| Alibaba Cloud | Model Studio privacy notice | 2026-05-15 | International | https://www.alibabacloud.com/help/en/model-studio/privacy-notice |
| Alibaba Cloud | Billing and Costs / Fund account / Payment management | 2026-06-21 to 2026-07-02 | International | https://www.alibabacloud.com/help/en/user-center/product-overview/billings-and-costs-product-introduction/ |
| Alibaba Cloud | Model usage statistics | 2026-06-11 | International | https://www.alibabacloud.com/help/en/model-studio/model-usage-statistics |
| OpenAI | Realtime transcription guide | No page date | API | https://developers.openai.com/api/docs/guides/realtime-transcription |
| OpenAI | Realtime WebSocket guide | No page date | API | https://developers.openai.com/api/docs/guides/realtime-websocket |
| OpenAI | API pricing | No page date | API | https://developers.openai.com/api/docs/pricing |
| OpenAI | Data controls in the OpenAI platform | No page date | API | https://developers.openai.com/api/docs/guides/your-data |
| OpenAI | Prepaid billing / project management / usage dashboard | No stable page date | API accounts | https://help.openai.com/en/articles/8264644-what-is-prepaid-billing |
| Google Cloud | Speech-to-Text pricing | No page date | V2 | https://cloud.google.com/speech-to-text/pricing |
| Google Cloud | Chirp 3: Transcription and Model Adaptation | No page date | US/EU | https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3 |
| Google Cloud | StreamingRecognitionResult / RPC reference | No page date | V2 | https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/StreamingRecognitionResult |
| Google Cloud | Audio encodings | No page date | STT | https://docs.cloud.google.com/speech-to-text/docs/encoding |
| Google Cloud | Data usage FAQ | 2026-07-10 UTC | STT | https://docs.cloud.google.com/speech-to-text/docs/v1/data-usage-faq |
| Google Cloud | Free cloud features | No page date | New accounts | https://docs.cloud.google.com/free/docs/free-cloud-features |
| Google Cloud | Cloud Billing budgets | No page date | Billing | https://docs.cloud.google.com/billing/docs/how-to/budgets |
| Microsoft Azure | Speech service pricing | No page date; dynamic rates | Region-dependent | https://azure.microsoft.com/en-us/pricing/details/speech/ |
| Microsoft Azure | Recognize speech / audio input streams | No page date | Speech SDK | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-recognize-speech |
| Microsoft Azure | Speech-to-text language support | No page date | `ja-JP` | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support |
| Microsoft Azure | Speech-to-text data privacy and security | No page date | Speech | https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security |
| Microsoft Azure | Azure spending limit / budgets | No page date | Billing | https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit |
| AWS | Amazon Transcribe pricing | No page date | Regional; US East rate reference | https://aws.amazon.com/transcribe/pricing/ |
| AWS | Streaming partial results | No page date | Streaming | https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html |
| AWS | Setting up a streaming transcription | No page date | Streaming | https://docs.aws.amazon.com/transcribe/latest/dg/streaming-setting-up.html |
| AWS | Supported languages | No page date | Includes `ja-JP` | https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html |
| AWS | Transcribe AI Service Card | 2026-05-26 scope | Batch and streaming | https://docs.aws.amazon.com/ai/responsible-ai/transcribe-speech-recognition/overview.html |
| AWS | Opting out of service improvement | No page date | Organizations | https://docs.aws.amazon.com/transcribe/latest/dg/opt-out.html |
| AWS | AWS Budgets best practices | No page date | Billing | https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html |
