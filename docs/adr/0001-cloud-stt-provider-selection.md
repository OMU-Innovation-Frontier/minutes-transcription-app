# ADR 0001: Cloud STT provider selection

- Status: **Under evaluation**
- Date: 2026-07-19
- Decision owners: Undecided
- Contracting and billing owners: Undecided

## Context

The application already sends 16 kHz mono PCM16 from the browser to a Node.js server and routes transcription through a common `SttProvider`. Local Whisper and Mock are implemented; external STT is disabled by default. Partial text is temporary, while only final text is persisted and corrected.

The project needs a cloud candidate with Japanese realtime transcription, low bounded cost, a safe free trial, server-only credentials, predictable partial/final mapping, and acceptable international data handling. No production consent UI, cloud account owner, billing owner, budget, or DPA approval exists yet.

## Options evaluated

- Alibaba Cloud Fun-ASR Realtime, international Singapore
- Alibaba Cloud Qwen3-ASR-Flash Realtime, international Singapore
- OpenAI Realtime Transcription
- Google Cloud Speech-to-Text V2 `chirp_3`
- Azure AI Speech realtime
- Amazon Transcribe Streaming
- Existing Local Whisper `small-q5_1` as baseline/fallback

See `../CLOUD_STT_PROVIDER_EVALUATION.md` for official sources, prices, privacy constraints and weighted scoring.

## Proposed direction

If institutional account, billing and privacy approval is obtained, prototype **Alibaba Cloud Fun-ASR Realtime first**, using the Singapore international workspace and Free Quota Only. Retain **Qwen3-ASR-Flash Realtime as the second A/B candidate** on the same artificial Japanese corpus.

This is not an Accepted production decision. It authorizes neither provider implementation nor an API call by itself.

## Rationale

Fun-ASR has the strongest documented fit with the current boundary:

- 16 kHz PCM can pass through without changing browser or Local Whisper audio;
- direct WebSocket events expose interim/final sentence state and stable sentence identifiers;
- Japanese and custom vocabulary/hotwords are documented;
- the Singapore rate is USD 0.00009 per audio second (USD 0.324/hour), output free;
- the listed new-user quota is 10 hours for 90 days;
- Free Quota Only can block requests instead of moving to PAYG;
- the existing `ws` dependency is sufficient for a testable transport boundary.

Qwen realtime has the same price/quota and similarly direct protocol, but currently lacks hotword controls. Because official specifications cannot determine Japanese accuracy, it remains a necessary benchmark comparator rather than being rejected.

## Constraints

- Cloud STT remains opt-in and disabled by default and in ordinary CI/tests.
- Keys remain server-only and are never exposed through `VITE_`, WebSocket ready messages, health, logs, fixtures or Git.
- The international Singapore endpoint and pricing must not be mixed with mainland-China service details.
- No developer personal card/payment account is used.
- Free Quota Only, server-side audio caps and usage logging are required before a live test.
- Real meetings and personal information are prohibited in the benchmark.
- No automatic audio replay follows an uncertain disconnect.
- Audio and full transcripts are absent from normal logs.
- Local Whisper and Mock remain supported.
- Final only enters `rawText`, persistence and correction.

## Expected implementation shape if later approved

- Add a Fun-ASR `SttProvider` and a separate direct-WebSocket transport/parser.
- Add allow-listed provider/model/region configuration and factory selection.
- Keep shared browser protocol unchanged; pass existing 16 kHz PCM directly.
- Map `sentence_id` to stable `segmentId`, `sentence_end=false` to partial and `true` to exactly one final; maintain monotonic revisions.
- Preserve sequence/timestamps for ordering and wait with a bound for `task-finished` on stop.
- Cancel/dispose closes socket, listeners, timers, queue and partial state without emitting new finals.
- Use fake transport tests for all normal CI behavior. Any real test is explicitly opted in and quota-capped.

Qwen can share lifecycle concepts but needs its own protocol parser for `session.update`, audio-buffer events, `item_id`, transcription text/completed, and `session.finish`.

## Consequences

### Positive

- Lowest documented evaluated rate and strongest free-only billing control.
- No resampler and no mandatory new npm dependency for the first provider.
- Hotword support can be measured for university and technical terms.
- Qwen provides a second model-family comparison under the same account/region/rate structure.

### Negative and unresolved

- Exact operational/static-data retention, deletion and subprocessors for Singapore require written confirmation.
- Singapore cross-border processing and participant consent require institutional review.
- Japanese meeting quality, latency, VAD behavior and ordering are unknown until benchmarked.
- Account, contracting, billing, budget, data protection and incident owners are undecided.
- Production UI does not yet provide approved notice/consent for external audio transmission.
- Concurrent connection/rate quotas need confirmation for the selected workspace.

## Rejected for first prototype, not permanently rejected

- OpenAI: requires stateful 16→24 kHz resampling, has higher published cost, no hard project budget, and no Japan/Singapore data residency in the reviewed realtime documentation.
- Google: good 16 kHz/privacy documentation, but Chirp 3 uses US/EU multi-region, bidirectional gRPC and five-minute stream rotation.
- Azure: promising F0/Japan/16 kHz option, but exact regional paid rate was not captured from the dynamic official pricing page and an SDK adapter is likely.
- AWS: supports 16 kHz and Tokyo, but has a higher reference rate, SigV4/event-stream complexity, automatic PAYG after free quota, and requires organizational service-improvement opt-out.
- Local Whisper is not rejected; it remains the privacy/cost baseline and fallback.

## Conditions to change status to Accepted

1. Named institutional contract, billing, budget, technical, privacy and incident owners.
2. Approved DPA, region, subprocessors, retention/deletion and consent flow.
3. Verified Free Quota Only plus application session/day/month limits.
4. Fake-transport implementation and no-network CI tests pass.
5. Synthetic benchmark meets predeclared accuracy, latency, ordering and cost thresholds.
6. Human review approves external-audio UI and operational runbook.
7. Exact rate and quotas are rechecked on the approval date.

Until then, this ADR remains **Under evaluation** and no external provider is enabled.
