// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { LocalWhisperRuntime, buildLocalWhisperArguments, type LocalWhisperJob } from '../src/providers/local/localWhisperRuntime';
import { LOCAL_PCM_MIME_TYPE, LocalWhisperServerProvider } from '../src/providers/local/localWhisperServerProvider';
import { LocalSttError } from '../src/providers/local/localSttTypes';
import { PcmUtteranceSegmenter, calculatePcm16Rms } from '../src/providers/local/pcmUtteranceSegmenter';

describe('PCM16 energy VAD and utterance boundaries', () => {
  it('calculates normalized PCM16 RMS as a pure function', () => {
    expect(calculatePcm16Rms(new Int16Array([16_384, -16_384]))).toBeCloseTo(0.5, 5);
    expect(calculatePcm16Rms(new Int16Array())).toBe(0);
  });

  it('finalizes speech after 1300 ms of silence and preserves the sequence range', () => {
    const segmenter = new PcmUtteranceSegmenter();
    expect(segmenter.accept(4, pcm([...samples(500, 0.2), ...samples(1_000, 0)]))).toEqual([]);
    const utterances = segmenter.accept(5, pcm(samples(300, 0)));
    expect(utterances).toHaveLength(1);
    expect(utterances[0]).toMatchObject({ reason: 'silence', sequenceStart: 4, sequenceEnd: 5 });
    expect(utterances[0]!.audioDurationMs).toBeGreaterThanOrEqual(1_780);
  });

  it('does not send silence-only or shorter-than-minimum audio to Whisper', () => {
    const silence = new PcmUtteranceSegmenter();
    expect(silence.accept(0, pcm(samples(2_000, 0)))).toEqual([]);
    expect(silence.flush()).toEqual([]);
    const short = new PcmUtteranceSegmenter();
    expect(short.accept(0, pcm(samples(100, 0.2)))).toEqual([]);
    expect(short.flush()).toEqual([]);
  });

  it('forces a boundary at twenty seconds and flushes the remaining voiced audio on stop', () => {
    const segmenter = new PcmUtteranceSegmenter();
    const first = segmenter.accept(0, pcm(samples(21_000, 0.2)));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ reason: 'max_duration', audioDurationMs: 20_000 });
    const remaining = segmenter.flush();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ reason: 'session_stop', audioDurationMs: 1_000 });
  });

  it('rejects incomplete PCM16 frames', () => {
    expect(() => new PcmUtteranceSegmenter().accept(0, new Uint8Array(3))).toThrow(/complete/u);
  });
});

describe('Local Whisper invocation and provider boundary', () => {
  it('builds only timestamp-enabled CPU arguments with four threads', () => {
    const args = buildLocalWhisperArguments('model.bin', 'audio.wav', 'ja', 4);
    expect(args).toEqual([
      '--model', 'model.bin', '--file', 'audio.wav', '--language', 'ja', '--threads', '4', '--no-prints', '--no-gpu',
    ]);
    expect(args).not.toContain('--no-timestamps');
  });

  it('rejects unsupported thread and language values before spawning', () => {
    expect(() => buildLocalWhisperArguments('model', 'audio', 'ja', 8)).toThrow(/four CPU threads/u);
    expect(() => buildLocalWhisperArguments('model', 'audio', 'fr' as 'ja', 4)).toThrow(/language/u);
  });

  it('accepts PCM into the FIFO service, emits final-only transcript metrics, and keeps text out of logs', async () => {
    const jobs: LocalWhisperJob[] = [];
    const runtime = fakeRuntime(jobs);
    const provider = new LocalWhisperServerProvider(runtime, { vad: {} });
    const transcripts = vi.fn();
    const statuses = vi.fn();
    provider.onTranscript(transcripts);
    provider.onStatus(statuses);
    await provider.startSession({ sessionId: 'session-1', language: 'ja', mimeType: LOCAL_PCM_MIME_TYPE });
    await provider.sendAudio({
      sessionId: 'session-1', sequence: 0,
      audio: pcm([...samples(500, 0.2), ...samples(1_300, 0)]),
      metadata: { capturedAt: 1, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 28_800 },
    });
    expect(jobs).toHaveLength(1);
    jobs[0]!.onStarted(1, 10);
    jobs[0]!.onCompleted({
      transcript: 'テストです', segments: [{ startMs: 0, endMs: 1_000, text: 'テストです' }],
      audioDurationMs: 1_500, processingTimeMs: 750, realTimeFactor: 0.5,
      queueWaitTimeMs: 10, totalLatencyMs: 760, processExitCode: 0,
      unparsedOutputLineCount: 0, completedAt: Date.now(),
    });
    expect(transcripts).toHaveBeenCalledWith(expect.objectContaining({
      text: 'テストです', isFinal: true, provider: 'local-whisper', model: 'whisper-small-q5_1',
      processingTimeMs: 750, audioDurationMs: 1_500, realTimeFactor: 0.5,
    }));
    expect(statuses).toHaveBeenCalledWith(expect.objectContaining({ state: 'recognizing' }));
    expect(statuses).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' }));
  });

  it('rejects missing PCM metadata and maps local availability errors to safe provider errors', async () => {
    const jobs: LocalWhisperJob[] = [];
    const provider = new LocalWhisperServerProvider(fakeRuntime(jobs), { vad: {} });
    await provider.startSession({ sessionId: 'session-1', language: 'ja', mimeType: LOCAL_PCM_MIME_TYPE });
    await expect(provider.sendAudio({ sessionId: 'session-1', sequence: 0, audio: pcm(samples(500, 0.2)) }))
      .rejects.toMatchObject({ code: 'local_pcm_invalid' });

    const unavailable = fakeRuntime([]);
    unavailable.registerSession = async () => { throw new LocalSttError('local_model_hash_mismatch', 'private path omitted'); };
    const failed = new LocalWhisperServerProvider(unavailable, { vad: {} });
    await expect(failed.startSession({ sessionId: 'session-2', language: 'ja', mimeType: LOCAL_PCM_MIME_TYPE }))
      .rejects.toMatchObject({ code: 'local_model_hash_mismatch', safeMessage: 'Local Whisperモデルの整合性を確認できません。' });
  });
});

function fakeRuntime(jobs: LocalWhisperJob[]): LocalWhisperRuntime {
  return {
    queueLength: 0,
    async registerSession() {},
    unregisterSession() {},
    enqueueMany(next: readonly LocalWhisperJob[]) { jobs.push(...next); },
    async waitForSession() {},
    cancelSession() {},
    async close() {},
  } as unknown as LocalWhisperRuntime;
}

function samples(durationMs: number, amplitude: number): number[] {
  const value = Math.round(amplitude * 32_767);
  return Array.from({ length: Math.round(durationMs * 16) }, () => value);
}

function pcm(values: number[]): Uint8Array {
  const output = new Uint8Array(values.length * 2);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return output;
}
