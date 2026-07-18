// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectPcm16Mono16kWavQuality } from '../src/providers/local/audioConverter';
import { sha256File } from '../src/providers/local/chunkComparison';
import {
  classifyRealtimeComparison,
  compareRealtimeDebugAudio,
  includeTranscriptWhenRequested,
  type RealtimeAudioComparisonResult,
} from '../src/providers/local/realtimeAudioComparison';
import {
  RealtimeDebugAudioStore,
  type RealtimeDebugCaptureInput,
} from '../src/providers/local/realtimeDebugAudio';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('realtime debug WAV storage', () => {
  it('does not create a copy while debug audio is disabled', async () => {
    const root = await createRoot();
    const input = await createInput(root);
    const store = createStore(root, false);
    await expect(store.capture(input)).resolves.toBeUndefined();
    await expect(stat(resolve(root, 'debug/realtime-audio'))).rejects.toThrow();
  });

  it('copies only when enabled, verifies SHA-256, saves transcript-free metadata, and keeps the source', async () => {
    const root = await createRoot();
    const input = await createInput(root);
    const store = createStore(root, true);
    const capture = await store.capture(input);
    expect(capture).toBeDefined();
    if (!capture) throw new Error('capture missing');
    expect(capture.fileName).toMatch(/^realtime-[0-9TZ-]+-[0-9a-f-]+\.wav$/u);
    expect(await sha256File(capture.wavPath)).toBe(await sha256File(input.temporaryWavPath));
    await expect(stat(input.temporaryWavPath)).resolves.toMatchObject({ size: 32_044 });
    await store.finalize(capture, {
      processingTimeMs: 250,
      realTimeFactor: 0.25,
      segmentCount: 2,
      transcript: 'private recognized phrase',
      errorCode: null,
    });
    const metadataText = await readFile(capture.metadataPath, 'utf8');
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      provider: 'local-whisper',
      model: 'whisper-small-q5_1',
      silenceDurationMs: 1_300,
      preSpeechBufferMs: 300,
      realtimeProcessingTimeMs: 250,
      realtimeRtf: 0.25,
      realtimeSegmentCount: 2,
      realtimeErrorCode: null,
      humanErrorClassification: 'unknown',
    });
    expect(metadataText).not.toContain('private recognized phrase');
    expect(metadata.realtimeTranscriptSha256).toBeTypeOf('string');
  });

  it('records complete PCM diagnostics without modifying audio', async () => {
    const root = await createRoot();
    const input = await createInput(root);
    const before = await sha256File(input.temporaryWavPath);
    const quality = await inspectPcm16Mono16kWavQuality(input.temporaryWavPath, [root]);
    expect(quality).toMatchObject({
      riff: 'RIFF', wave: 'WAVE', audioFormat: 1, sampleRate: 16_000,
      channels: 1, bitsPerSample: 16, byteRate: 32_000, blockAlign: 2,
      incompletePcmFrame: false,
    });
    expect(quality.rms).toBeGreaterThan(0);
    expect(quality.peak).toBeGreaterThan(0);
    expect(quality.clippingRatio).toBe(0);
    expect(quality.dcOffset).not.toBe(0);
    expect(quality.first300MsRms).toBeGreaterThan(0);
    expect(quality.last300MsRms).toBeGreaterThan(0);
    expect(await sha256File(input.temporaryWavPath)).toBe(before);
  });

  it('rejects configured paths outside local data and stops saving at file and byte limits', async () => {
    const root = await createRoot();
    const outside = await createRoot();
    expect(() => new RealtimeDebugAudioStore({
      enabled: true, localRoot: root, directory: outside, maxFiles: 1, maxBytes: 100_000,
    })).toThrowError(expect.objectContaining({ code: 'local_temp_path_invalid' }));

    const input = await createInput(root);
    const warning = vi.fn();
    const oneFile = createStore(root, true, { maxFiles: 1, onWarning: warning });
    expect(await oneFile.capture(input)).toBeDefined();
    expect(await oneFile.capture(input)).toBeUndefined();
    expect(warning).toHaveBeenCalledWith('debug_audio_limit_reached');
    expect(oneFile.getSavedCaptures()).toHaveLength(1);

    const byteRoot = await createRoot();
    const byteInput = await createInput(byteRoot);
    const byteWarning = vi.fn();
    const byteLimited = createStore(byteRoot, true, { maxBytes: 100, onWarning: byteWarning });
    expect(await byteLimited.capture(byteInput)).toBeUndefined();
    expect(byteWarning).toHaveBeenCalledWith('debug_audio_limit_reached');
  });

  it('turns copy failures into safe warnings instead of throwing recognition errors', async () => {
    const root = await createRoot();
    const warning = vi.fn();
    const store = createStore(root, true, { onWarning: warning });
    const input = await createInput(root);
    input.temporaryWavPath = resolve(root, 'temp/missing.wav');
    await expect(store.capture(input)).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith('debug_audio_save_failed');
  });
});

describe('realtime/offline comparison safety and classification', () => {
  it('classifies equivalent, changed, and configuration-different results', () => {
    const common = { audioMatches: true, audioValid: true, runtimeSucceeded: true, configurationMatches: true };
    expect(classifyRealtimeComparison({ ...common, transcriptMatches: true })).toBe('identical');
    expect(classifyRealtimeComparison({ ...common, transcriptMatches: false })).toBe('text-different');
    expect(classifyRealtimeComparison({ ...common, configurationMatches: false, transcriptMatches: true }))
      .toBe('configuration-different');
    expect(classifyRealtimeComparison({ ...common, audioMatches: false, transcriptMatches: true }))
      .toBe('audio-mismatch');
  });

  it('keeps transcript text out of normal output and includes it only on explicit request', () => {
    const result = {
      schemaVersion: 1,
      wavFileName: 'safe.wav',
      classification: 'identical',
      explanation: 'safe',
    } as RealtimeAudioComparisonResult;
    expect(JSON.stringify(includeTranscriptWhenRequested(result, 'private transcript', false)))
      .not.toContain('private transcript');
    expect(includeTranscriptWhenRequested(result, 'private transcript', true).offlineTranscript)
      .toBe('private transcript');
  });

  it('rejects a path outside the debug directory before model execution', async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const wavPath = resolve(outside, 'outside.wav');
    await writeFile(wavPath, createPcmWav());
    await expect(compareRealtimeDebugAudio({
      wavPath,
      localRoot: root,
      debugAudioDirectory: resolve(root, 'debug/realtime-audio'),
      timeoutMs: 1_000,
      saveResult: false,
    })).rejects.toMatchObject({ code: 'local_audio_invalid' });
  });

  it('detects metadata SHA mismatch and invalid WAV without starting Whisper', async () => {
    const root = await createRoot();
    const input = await createInput(root);
    const store = createStore(root, true);
    const capture = await store.capture(input);
    if (!capture) throw new Error('capture missing');
    await writeFile(capture.wavPath, 'changed');
    const mismatch = await compareRealtimeDebugAudio({
      wavPath: capture.wavPath,
      localRoot: root,
      debugAudioDirectory: resolve(root, 'debug/realtime-audio'),
      timeoutMs: 1_000,
      saveResult: false,
    });
    expect(mismatch.classification).toBe('audio-mismatch');
    expect(mismatch.offlineTranscript).toBeUndefined();

    const invalidRoot = await createRoot();
    const invalidInput = await createInput(invalidRoot);
    const invalidStore = createStore(invalidRoot, true);
    const invalidCapture = await invalidStore.capture(invalidInput);
    if (!invalidCapture) throw new Error('invalid capture missing');
    await writeFile(invalidCapture.wavPath, 'not a wav');
    invalidCapture.metadata.wavSha256 = await sha256File(invalidCapture.wavPath);
    await writeFile(invalidCapture.metadataPath, `${JSON.stringify(invalidCapture.metadata)}\n`);
    const invalid = await compareRealtimeDebugAudio({
      wavPath: invalidCapture.wavPath,
      localRoot: invalidRoot,
      debugAudioDirectory: resolve(invalidRoot, 'debug/realtime-audio'),
      timeoutMs: 1_000,
      saveResult: false,
    });
    expect(invalid.classification).toBe('invalid-audio');
    expect(invalid.offlineTranscript).toBeUndefined();
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'minutes-debug-audio-'));
  temporaryDirectories.push(root);
  return root;
}

async function createInput(root: string): Promise<RealtimeDebugCaptureInput> {
  const temporaryWavPath = resolve(root, 'temporary-input.wav');
  await writeFile(temporaryWavPath, createPcmWav());
  return {
    temporaryWavPath,
    sessionId: '../private-session',
    utteranceId: '../private-session:utterance-0001',
    language: 'ja',
    utterance: {
      pcm: createPcmWav().subarray(44),
      startFrame: 0,
      endFrame: 16_000,
      audioDurationMs: 1_000,
      sequenceStart: 2,
      sequenceEnd: 4,
      reason: 'silence',
      adaptiveNoiseFloor: 0.004,
    },
    vad: {
      sampleRate: 16_000,
      analysisWindowMs: 20,
      silenceDurationMs: 1_300,
      maxUtteranceDurationMs: 20_000,
      minimumUtteranceDurationMs: 300,
      preSpeechBufferMs: 300,
      rmsThreshold: 0.012,
      noiseFloorMultiplier: 3,
      speechStartWindows: 2,
    },
    modelSha256: 'model-hash',
    whisperCliSha256: 'cli-hash',
  };
}

function createStore(
  root: string,
  enabled: boolean,
  overrides: Partial<ConstructorParameters<typeof RealtimeDebugAudioStore>[0]> = {},
): RealtimeDebugAudioStore {
  return new RealtimeDebugAudioStore({
    enabled,
    localRoot: root,
    directory: resolve(root, 'debug/realtime-audio'),
    maxFiles: 20,
    maxBytes: 100_000_000,
    ...overrides,
  });
}

function createPcmWav(): Buffer {
  const frames = 16_000;
  const pcm = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    const sample = Math.round(Math.sin(index / 20) * 4_000 + 200);
    pcm.writeInt16LE(sample, index * 2);
  }
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, 44);
  return wav;
}
