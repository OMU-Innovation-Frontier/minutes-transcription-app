# Cloud STT Benchmark Plan

## Status and purpose

- Status: **Proposed; no API test has been run**
- Confirmed: 2026-07-19
- First comparison: Local Whisper `small-q5_1`, Alibaba Cloud Fun-ASR Realtime, Alibaba Cloud Qwen3-ASR-Flash Realtime
- Later comparators: Azure, Google, OpenAI and AWS only after separate cost/privacy approval

The benchmark determines actual Japanese recognition quality, latency, ordering, and measured usage cost. Official model support does not establish meeting accuracy.

## Safety preconditions

No live cloud test may begin until all of the following are true:

1. The contracting party, account owner, billing owner, budget approver and data protection reviewer are decided.
2. Participant/external-transmission consent wording is approved, even though the benchmark uses synthetic content.
3. For Alibaba Cloud, the account is international, the workspace is Singapore, and **Free Quota Only is visibly enabled**.
4. No personal payment method is used.
5. The API key exists only in a local server secret store or approved CI secret for an explicitly opt-in job; it is never committed or exposed to the browser.
6. External tests require an explicit flag, external STT enablement, a key, and a selected allow-listed model. The ordinary test suite and CI remain offline.
7. The application enforces maximum audio seconds per session/day/month and one concurrent test session.
8. No retry automatically resends audio after an uncertain delivery.
9. Logs contain metrics and safe error codes, never audio or full transcripts.

## Test corpus

Use only newly written, artificial Japanese sentences read by project volunteers who consent specifically to the benchmark, or locally generated synthetic speech whose license permits testing. Do not reuse real meetings, production transcripts, names, phone numbers, email addresses, student IDs, medical data, or confidential research content.

Create versioned scripts with normalized reference text. Proper nouns should be fictional or public institutional/technical terms. Record locally as 16 kHz, mono, signed PCM16, then keep the raw corpus outside Git. Store only corpus metadata, reference text that contains no personal information, and checksums in a controlled benchmark workspace.

### Required categories

| Category | Example design | Minimum cases | Purpose |
|---|---|---:|---|
| Quiet Japanese | Neutral, ordinary sentences in a quiet room | 5 | Baseline CER/WER and latency |
| Moderate noise | Same content mixed locally with licensed room/cafe noise at declared SNR | 5 | Noise robustness |
| Short utterance | 1–5 Japanese words with natural silence | 10 | VAD and finalization loss |
| Long utterance | 30–90 seconds with clauses and punctuation | 5 | Buffering, stability and long final latency |
| Numbers | Integers, decimals, percentages, room numbers | 8 | Numeric normalization |
| Dates and times | Japanese era/Western dates, weekdays and times | 8 | Formatting and homophone handling |
| Japanese with English | Common technical terms embedded in Japanese | 8 | Code-switch behavior |
| Proper nouns | Public university and technology names; no personal names | 10 | Hotword/adaptation comparison |
| Self-correction | Deliberate correction such as “火曜、ではなく水曜” | 5 | Partial revision and final truth |
| Fillers | “えー”, “あの”, pauses and repetition | 5 | Verbatim behavior and segmentation |
| Two-utterance order | Two distinct utterances close together | 10 pairs | Ordering, duplicates and loss |

Use at least two consented voices and report the aggregate; do not identify speakers in published results. Multi-speaker overlap is a later, separately approved dataset because diarization support differs.

## Test matrix

Run each exact audio file through every candidate under test. Randomize provider order to reduce network/time bias. Record the model alias, resolved snapshot if exposed, provider region, UTC timestamp, connection/session ID generated locally, VAD/hotword settings, and source audio checksum.

For Alibaba:

- Fun-ASR: first run default VAD and Japanese language hint, with no hotword list; second proper-noun run uses the approved custom vocabulary.
- Qwen: use the current stable alias and default server VAD. Do not simulate hotword support.
- Do not mix Singapore and mainland-China endpoints or pricing.

For Local Whisper, use the current repository configuration and the same 16 kHz files. Local results are a privacy/cost baseline, not a cloud free-quota consumer.

## Metrics

| Metric | Definition |
|---|---|
| Character error rate (CER) | Levenshtein substitutions + deletions + insertions divided by normalized reference characters |
| Word error rate (WER) | Same calculation after a documented Japanese tokenization method; preserve tokenizer version |
| First-partial latency | Server audio start to first non-empty partial for the relevant segment |
| Final latency | End of utterance/reference audio to one accepted final |
| Ordering accuracy | Percentage of two-utterance pairs whose finals are presented in source order |
| Duplicate rate | Extra final segments divided by expected segments |
| Omission rate | Missing expected final segments divided by expected segments |
| Proper-noun accuracy | Exact normalized match per target term, with/without supported hotword control |
| Revision behavior | Revision sequence is monotonic and one `segmentId` is updated rather than appended |
| Measured hourly cost | Provider-reported billable duration/cost normalized to one audio hour; do not infer from connection time |
| Disconnect outcome | No silent success, no automatic duplicate replay, bounded cleanup and safe error code |

Normalization must be defined before scoring. Keep two views: strict verbatim and readability-normalized (punctuation/space/numeral differences). Never change reference text after seeing provider output.

## Execution proposal

### Phase 0: offline harness

Implementation status: **offline skeleton added; still under evaluation**.

1. At the Phase 0 milestone, the provider was implemented behind a Fake Transport only; no live transport, endpoint, credential, or external audio transmission existed.
2. Automated tests cover partial updates, stable IDs, monotonic revisions, exactly-once final, out-of-order events, stop flush, cancel, disposal, timeouts and safe error redaction.
3. At the Phase 0 milestone, the normal runtime had no network transport factory and failed safely before connecting.
4. Session/day/month/concurrent counters use integer PCM frames and a fake clock. They are process-memory safeguards and reset on server restart.

### Phase 1a: live-capable transport, offline validation only

Implementation status: **transport code added; no live connection has been run**.

1. The server transport uses the existing `ws` dependency and accepts only the Singapore workspace-dedicated hostname derived from a validated server-only Workspace ID plus the fixed `/api-ws/v1/inference` path. It does not use or fall back to the older `dashscope-intl.aliyuncs.com` domain.
2. Authentication is server-side only; credentials are absent from URLs, control messages, health, logs, safe errors, browser code, and fixtures.
3. Connection, control text, binary PCM, inbound JSON, backpressure, close races, and cleanup are tested with a Fake WebSocket constructor. Ordinary tests create no network socket.
4. The runtime remains disabled by default and requires explicit provider/external flags, credential, region, model, and session/day/month/concurrency limits.
5. No account, key, Workspace ID, Free Quota Only setting, payment configuration, API request, or audio upload was created, configured, or performed in Phase 1a.

### Phase 1: connection-only validation

1. Human resolves the institutional account/workspace owner and verifies Free Quota Only and remaining quota.
2. Explicitly set one approved provider/model/region.
3. Connect without sending audio; validate session setup and close.
4. Record no key, headers, raw response or transcript in logs.

### Phase 2: tiny synthetic smoke

1. Send one 5–10 second artificial sentence.
2. Confirm partial/final mapping, usage seconds, cleanup and local quota accounting.
3. Check provider console usage before any second request.
4. Stop immediately on billing/profile, residency, unexpected log, or quota-guard discrepancy.

### Phase 3: capped benchmark

1. Run one provider at a time, one connection at a time.
2. Maximum initial session: 10 audio minutes.
3. Maximum initial day: 30 audio minutes across cloud providers.
4. Maximum initial month: **undecided; must be approved and lower than remaining free quota**.
5. Do not retry a request after audio transmission unless a human confirms the provider did not accept it.
6. Recheck local and provider usage counters after every batch.

### Phase 4: failure tests

Use synthetic audio only. Deliberately close the fake transport first; a real network interruption test requires separate approval. Validate no duplicate resend, a retryable safe error, closed timers/socket and no partial persistence. Keep the external call count below the same caps.

## Local usage record

Store metrics locally outside Git as structured records. A suggested schema:

```text
run_id
corpus_version
audio_sha256
category
provider
model_alias
model_snapshot_if_reported
region
settings_profile
audio_seconds
provider_billable_seconds
started_at_utc
first_partial_ms
final_ms
expected_segment_count
final_segment_count
duplicate_count
omission_count
order_correct
cer_strict
cer_normalized
wer_strict
wer_normalized
proper_noun_correct
safe_error_code
estimated_usd_from_current_rate
console_usage_verified_at
reviewer_notes_without_transcript
```

Transcript text and audio remain in the controlled benchmark directory and are not written to ordinary application logs, Git, GitHub Actions artifacts, or shared telemetry. Published results should contain aggregate metrics and non-sensitive artificial reference phrases only.

## Acceptance thresholds

Thresholds are undecided and must be set before the live benchmark. At minimum, require:

- zero duplicate finals and zero ordering reversals in the standard two-utterance set;
- zero persisted partials;
- all sessions, sockets and timers released after stop/cancel/failure;
- no API key, Authorization header, audio or full transcript in logs/errors;
- usage-counter difference explainable within provider reporting delay;
- acceptable Japanese CER, final latency and proper-noun accuracy approved by users;
- no charge when Free Quota Only should have blocked usage.

## Result review

Review quality and operational risk separately. A provider with the best CER is not acceptable if its billing cannot be bounded, its region/DPA is unapproved, or it duplicates speech on disconnect. Record model snapshots because stable aliases can change. Re-run a small control corpus after any model alias change.

## Exit criteria

A provider may move from prototype to production design only when:

- the benchmark is reproducible and reviewed;
- billing, privacy and account owners approve it;
- participant consent and external-audio UI are implemented;
- server-enforced budgets and no-network CI tests pass;
- retention/deletion and incident handling are documented;
- Local Whisper remains available as an approved fallback where appropriate.
