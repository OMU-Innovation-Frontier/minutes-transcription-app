// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateNormalizedEnglishWordErrorRate,
  calculateNormalizedJapaneseCharacterErrorRate,
  calculateRawCharacterErrorRate,
  calculateRealTimeFactor,
  rateRealTimeFactor,
} from '../src/providers/evaluationHarness';
import { inspectPcm16Mono16kWav, inspectPcm16Mono16kWavQuality } from '../src/providers/local/audioConverter';
import { runLocalSttBenchmark } from '../src/providers/local/benchmarkRunner';
import { classifyTermMatches, runLocalBenchmarkSuite } from '../src/providers/local/benchmarkSuite';
import { getLocalModelDefinition } from '../src/providers/local/localModelRegistry';
import { LocalProcessManager, validateExistingFile } from '../src/providers/local/localProcessManager';
import { LocalRealtimeMetricsRecorder } from '../src/providers/local/localRealtimeMetrics';
import type { LocalFileSpeechToTextProvider } from '../src/providers/local/localSttTypes';
import { WhisperCppProvider } from '../src/providers/local/whisperCppProvider';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local STT metrics and registry', () => {
  it('calculates and rates real-time factor at the documented boundaries', () => {
    expect(calculateRealTimeFactor(5_000, 10)).toBe(0.5);
    expect(rateRealTimeFactor(0.5)).toBe('fast');
    expect(rateRealTimeFactor(0.75)).toBe('realtime-candidate');
    expect(rateRealTimeFactor(1.01)).toBe('slower-than-realtime');
  });

  it('rejects invalid real-time factor inputs instead of inventing a value', () => {
    expect(() => calculateRealTimeFactor(1_000, 0)).toThrow(RangeError);
    expect(() => rateRealTimeFactor(-1)).toThrow(RangeError);
  });

  it('separates raw Japanese CER from NFKC/lowercase/punctuation/space normalized CER', () => {
    expect(calculateRawCharacterErrorRate('Ａ。 B', 'a b')).toBeGreaterThan(0);
    expect(calculateNormalizedJapaneseCharacterErrorRate('Ａ。 B', 'a b')).toBe(0);
  });

  it('normalizes punctuation and case before English WER tokenization', () => {
    expect(calculateNormalizedEnglishWordErrorRate('Today, ROBOTICS!', 'today robotics')).toBe(0);
  });

  it('registers multilingual, English-only, and Japanese-only models accurately', () => {
    expect(getLocalModelDefinition('whisper-base-q5_1')?.languages).toEqual(['ja', 'en']);
    expect(getLocalModelDefinition('whisper-base-en-q5_1')?.languages).toEqual(['en']);
    expect(getLocalModelDefinition('kotoba-whisper-v2-q5_0')?.languages).toEqual(['ja']);
  });
});

describe('local path and process safety', () => {
  it('writes transcript-free realtime metrics only when explicitly enabled', async () => {
    const root = await createTemporaryDirectory();
    const disabled = new LocalRealtimeMetricsRecorder(false, root);
    disabled.record({
      sessionId: 'disabled', utteranceId: 'u0', sequenceStart: 0, sequenceEnd: 0,
      audioDurationMs: 1_000, model: 'whisper-small-q5_1', language: 'ja', threadCount: 4,
      createdAt: new Date().toISOString(),
    });
    await disabled.close();
    const outputPath = resolve(root, 'results/realtime',
      `local-whisper-realtime-${new Date().toISOString().slice(0, 10)}.jsonl`);
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow();

    const enabled = new LocalRealtimeMetricsRecorder(true, root);
    enabled.record({
      sessionId: 'enabled', utteranceId: 'u1', sequenceStart: 0, sequenceEnd: 2,
      audioDurationMs: 2_000, processingTimeMs: 1_000, realTimeFactor: 0.5,
      model: 'whisper-small-q5_1', language: 'ja', threadCount: 4,
      createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });
    await enabled.close();
    const saved = await readFile(outputPath, 'utf8');
    expect(JSON.parse(saved.trim())).toMatchObject({ utteranceId: 'u1', realTimeFactor: 0.5 });
    expect(saved).not.toContain('rawTranscript');
  });

  it('rejects relative and out-of-root model or audio paths', async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const file = resolve(outside, 'model.bin');
    await writeFile(file, 'model');
    await expect(validateExistingFile('relative.bin', [root], 'invalid', 'safe')).rejects.toMatchObject({ code: 'invalid' });
    await expect(validateExistingFile(file, [root], 'invalid', 'safe')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('fails safely when the local executable is missing', async () => {
    const root = await createTemporaryDirectory();
    const manager = new LocalProcessManager();
    await expect(manager.run({
      executablePath: resolve(root, 'missing.exe'),
      allowedExecutableRoots: [root],
      arguments: [],
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: 'local_executable_missing' });
  });

  it('times out a child process without a shell command string', async () => {
    const manager = new LocalProcessManager();
    await expect(manager.run({
      executablePath: process.execPath,
      allowedExecutableRoots: [dirname(process.execPath)],
      arguments: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 100,
    })).rejects.toMatchObject({ code: 'local_process_timeout' });
  });

  it('terminates a child process when its cancellation signal is aborted', async () => {
    const manager = new LocalProcessManager();
    const controller = new AbortController();
    const run = manager.run({
      executablePath: process.execPath,
      allowedExecutableRoots: [dirname(process.execPath)],
      arguments: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 100));
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'local_process_cancelled' });
  });

  it('terminates active child processes when closed', async () => {
    const manager = new LocalProcessManager();
    const run = manager.run({
      executablePath: process.execPath,
      allowedExecutableRoots: [dirname(process.execPath)],
      arguments: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 5_000,
    });
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 100));
    await manager.close();
    await expect(run).rejects.toMatchObject({ code: 'local_process_failed' });
  });

  it('samples child CPU and peak memory on Windows without exposing process output', async () => {
    const manager = new LocalProcessManager();
    const result = await manager.run({
      executablePath: process.execPath,
      allowedExecutableRoots: [dirname(process.execPath)],
      arguments: ['-e', 'const end=Date.now()+2500; while(Date.now()<end){}'],
      timeoutMs: 5_000,
    });
    if (process.platform === 'win32') {
      expect(result.cpuAveragePercent).toBeGreaterThan(0);
      expect(result.cpuPeakPercent).toBeGreaterThan(0);
      expect(result.peakMemoryBytes).toBeGreaterThan(0);
      expect(result.logicalProcessorCount).toBeGreaterThan(0);
    }
  });
});

describe('local audio and provider safety', () => {
  it('accepts only 16 kHz mono 16-bit PCM WAV for direct evaluation', async () => {
    const root = await createTemporaryDirectory();
    const wavPath = resolve(root, 'valid.wav');
    await writeFile(wavPath, createPcmWav(16_000));
    await expect(inspectPcm16Mono16kWav(wavPath, [root])).resolves.toEqual({
      durationSeconds: 1,
      audioFormat: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
      dataBytes: 32_000,
    });
    await expect(inspectPcm16Mono16kWavQuality(wavPath, [root])).resolves.toMatchObject({
      riff: 'RIFF', wave: 'WAVE', byteRate: 32_000, blockAlign: 2,
      durationMs: 1_000, rms: 0, peak: 0, clippingRatio: 0,
      silentWarning: true, clippingWarning: false,
    });
  });

  it('rejects a WAV with an unsupported sample rate', async () => {
    const root = await createTemporaryDirectory();
    const wavPath = resolve(root, 'invalid.wav');
    await writeFile(wavPath, createPcmWav(8_000));
    await expect(inspectPcm16Mono16kWav(wavPath, [root])).rejects.toMatchObject({
      code: 'local_wav_format_unsupported',
    });
  });

  it('rejects a language that the selected model does not support before execution', async () => {
    const model = getLocalModelDefinition('whisper-base-en-q5_1');
    if (!model) throw new Error('test model missing');
    const provider = new WhisperCppProvider({
      executablePath: 'C:\\missing\\whisper-cli.exe',
      modelPath: 'C:\\missing\\model.bin',
      model,
      allowedBinaryRoots: ['C:\\missing'],
      allowedModelRoots: ['C:\\missing'],
      allowedAudioRoots: ['C:\\missing'],
      timeoutMs: 1_000,
    }, new LocalProcessManager());
    await expect(provider.transcribeFile({ audioPath: 'C:\\missing\\audio.wav', language: 'ja' }))
      .rejects.toMatchObject({ code: 'local_language_unsupported' });
  });

  it('fails safely when the selected model is not present', async () => {
    const model = getLocalModelDefinition('whisper-base-q5_1');
    if (!model) throw new Error('test model missing');
    const root = await createTemporaryDirectory();
    const provider = new WhisperCppProvider({
      executablePath: resolve(root, 'whisper-cli.exe'),
      modelPath: resolve(root, model.fileName),
      model,
      allowedBinaryRoots: [root],
      allowedModelRoots: [root],
      allowedAudioRoots: [root],
      timeoutMs: 1_000,
    }, new LocalProcessManager());
    await expect(provider.transcribeFile({ audioPath: resolve(root, 'audio.wav'), language: 'ja' }))
      .rejects.toMatchObject({ code: 'local_model_missing' });
  });
});

describe('offline benchmark connection', () => {
  it('reuses CER, WER, hotword, latency, and RTF metrics without external access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider: LocalFileSpeechToTextProvider = {
      id: 'local-whisper',
      model: getLocalModelDefinition('whisper-base-q5_1')!,
      async transcribeFile(input) {
        return {
          provider: 'local-whisper',
          model: 'whisper-base-q5_1',
          language: input.language,
          transcript: 'Today we test robotics',
          totalProcessingMs: 500,
          firstResultLatencyMs: 250,
          finalLatencyMs: 500,
          executionArguments: ['--no-gpu'],
          threads: 4,
        };
      },
      async close() {},
    };
    const result = await runLocalSttBenchmark({
      provider,
      converter: { async prepare() {
        return {
          wavPath: 'mock.wav', durationSeconds: 2, converted: false, deleteAfterUse: false,
          format: { durationSeconds: 2, audioFormat: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16, dataBytes: 64_000 },
        };
      } },
      audioPath: 'mock.wav',
      language: 'en',
      groundTruthTranscript: 'Today we test robotics',
      hotwords: ['robotics'],
    });
    expect(result).toMatchObject({
      realTimeFactor: 0.25,
      realTimeFactorRating: 'fast',
      wordErrorRate: 0,
      hotwordAccuracy: 1,
      processingLocation: 'local',
      audioSentExternally: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps model binaries outside Git tracking', async () => {
    const gitignore = await readFile(resolve(process.cwd(), '.gitignore'), 'utf8');
    expect(gitignore).toContain('server/data/local-stt/');
  });

  it('records one cold and three warm runs per language without external access', async () => {
    const root = await createTemporaryDirectory();
    const modelPath = resolve(root, 'model.bin');
    const jaPath = resolve(root, 'ja.wav');
    const enPath = resolve(root, 'en.wav');
    await Promise.all([
      writeFile(modelPath, 'model'),
      writeFile(jaPath, createPcmWav(16_000)),
      writeFile(enPath, createPcmWav(16_000)),
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider: LocalFileSpeechToTextProvider = {
      id: 'local-whisper',
      model: getLocalModelDefinition('whisper-base-q5_1')!,
      async describeFileInvocation(input) {
        return { arguments: ['--model', modelPath, '--file', input.audioPath, '--threads', '4', '--no-gpu'], threads: 4 };
      },
      async transcribeFile(input) {
        return {
          provider: 'local-whisper', model: 'whisper-base-q5_1', language: input.language,
          transcript: input.language === 'ja' ? '試験です' : 'test robotics',
          totalProcessingMs: 1_000, finalLatencyMs: 1_000, firstResultLatencyMs: undefined,
          executionArguments: ['--no-gpu'], threads: 4, logicalProcessorCount: 16,
        };
      },
      async close() {},
    };
    const converter = { async prepare(audioPath: string) {
      return {
        wavPath: audioPath, durationSeconds: 2, converted: false, deleteAfterUse: false,
        format: { durationSeconds: 2, audioFormat: 1 as const, channels: 1 as const, sampleRate: 16_000 as const, bitsPerSample: 16 as const, dataBytes: 64_000 },
      };
    } };
    const suite = await runLocalBenchmarkSuite({
      provider,
      converter,
      modelPath,
      cases: [
        { language: 'ja', testCaseId: 'natural-ja-test', audioPath: jaPath, reference: '試験です。', spokenReference: null, hotwords: ['試験'] },
        { language: 'en', testCaseId: 'natural-en-test', audioPath: enPath, reference: 'Test robotics.', spokenReference: null, hotwords: ['robotics'] },
      ],
      resultsJsonlPath: resolve(root, 'results.jsonl'),
      metadataPath: resolve(root, 'metadata.json'),
      warmRuns: 3,
    });
    expect(suite.records).toHaveLength(8);
    expect(suite.records.filter((record) => record.runType === 'cold')).toHaveLength(2);
    expect(suite.records.filter((record) => record.runType === 'warm')).toHaveLength(6);
    expect(suite.records.every((record) => record.firstResultTimeMs === null)).toBe(true);
    expect(suite.records.every((record) => record.threadCount === 4)).toBe(true);
    expect(suite.records.every((record) => record.modelSha256.length === 64)).toBe(true);
    expect(suite.records.every((record) => record.audioSha256.length === 64)).toBe(true);
    expect(suite.records.every((record) => record.whisperArguments.includes('--no-gpu'))).toBe(true);
    expect(suite.records.filter((record) => record.language === 'ja').every((record) => record.rawCer === record.cerRaw)).toBe(true);
    expect(suite.records.filter((record) => record.language === 'ja').every((record) => record.normalizedCer === record.cerNormalized)).toBe(true);
    expect(suite.records.every((record) => record.rawTranscript === record.transcript)).toBe(true);
    expect(suite.records.every((record) => record.spokenReference === null)).toBe(true);
    expect(suite.records.every((record) => record.spokenBasedNormalizedCer === null && record.spokenBasedWer === null)).toBe(true);
    expect(suite.metadata.cases.every((item) => item.spokenReferenceStatus === 'unverified')).toBe(true);
    expect(classifyTermMatches(['WebSocket', 'Whisper base', 'OpenVINO'], 'web socket and Whisper-based only')).toEqual([
      { term: 'WebSocket', status: 'normalizedMatch' },
      { term: 'Whisper base', status: 'failed' },
      { term: 'OpenVINO', status: 'failed' },
    ]);
    expect((await readFile(resolve(root, 'results.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(8);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'minutes-local-stt-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createPcmWav(sampleRate: number): Buffer {
  const dataBytes = sampleRate * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  return output;
}
