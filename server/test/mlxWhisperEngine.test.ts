// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '../src/config';
import { createLocalWhisperEngine } from '../src/providers/local/localWhisperEngineFactory';
import {
  MLX_WHISPER_MODEL_ID,
  MlxWhisperEngine,
  PersistentMlxWhisperWorkerClient,
  type MlxWhisperWorkerClient,
  type MlxWhisperWorkerCommand,
} from '../src/providers/local/mlxWhisperEngine';
import type { LocalWhisperEngine } from '../src/providers/local/localWhisperEngine';
import { LocalWhisperRuntime, type LocalWhisperRecognitionResult } from '../src/providers/local/localWhisperRuntime';
import { DEFAULT_VAD_CONFIGURATION } from '../src/providers/local/pcmUtteranceSegmenter';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('MLX Whisper engine', () => {
  it('keeps whisper.cpp as the default and selects MLX only by explicit configuration', () => {
    const root = resolve('server/data/local-stt');
    expect(createLocalWhisperEngine(loadServerConfig({}), root).descriptor.id).toBe('whisper-cpp');
    expect(createLocalWhisperEngine(loadServerConfig({ LOCAL_STT_ENGINE: 'mlx-whisper' }), root).descriptor.id)
      .toBe('mlx-whisper');
  });

  it('is explicitly limited to Apple Silicon macOS', async () => {
    const engine = new MlxWhisperEngine({
      root: resolve('server/data/local-stt'),
      modelId: 'large-v3-turbo',
      workerPath: resolve('server/scripts/mlx_whisper_worker.py'),
      startupTimeoutMs: 1_000,
      platform: 'win32',
      architecture: 'x64',
    });
    await expect(engine.initialize()).rejects.toMatchObject({ code: 'local_engine_unsupported' });
  });

  it('verifies a local copied Python and model weights before starting an offline worker', async () => {
    const root = await createTemporaryDirectory();
    const pythonPath = resolve(root, 'mlx/venv/bin/python3');
    const modelPath = resolve(root, 'models/mlx/whisper-large-v3-turbo');
    const workerPath = resolve(root, 'scripts/mlx_whisper_worker.py');
    await mkdir(dirname(pythonPath), { recursive: true });
    await mkdir(modelPath, { recursive: true });
    await mkdir(dirname(workerPath), { recursive: true });
    await writeFile(pythonPath, 'copied python fixture');
    await writeFile(resolve(modelPath, 'config.json'), '{}');
    await writeFile(resolve(modelPath, 'weights.safetensors'), 'mlx weights fixture');
    await writeFile(workerPath, '# worker fixture');
    const pythonSha256 = hash('copied python fixture');
    const modelSha256 = hash('mlx weights fixture');
    let command: MlxWhisperWorkerCommand | undefined;
    const client: MlxWhisperWorkerClient = {
      start: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => ({
        transcript: 'テスト', segments: [{ startMs: 0, endMs: 500, text: 'テスト' }],
        processingTimeMs: 100, unparsedOutputLineCount: 0,
      })),
      close: vi.fn(async () => undefined),
    };
    const engine = new MlxWhisperEngine({
      root,
      modelId: 'large-v3-turbo',
      pythonPath,
      pythonSha256,
      modelPath,
      modelSha256,
      workerPath,
      startupTimeoutMs: 1_000,
      platform: 'darwin',
      architecture: 'arm64',
      workerFactory: (createdCommand) => {
        command = createdCommand;
        return client;
      },
    });

    await engine.initialize();
    expect(engine.descriptor).toMatchObject({
      id: 'mlx-whisper', modelId: MLX_WHISPER_MODEL_ID, threadCount: null,
    });
    expect(command?.executablePath).toBe(await realpath(pythonPath));
    expect(command?.arguments).toContain(await realpath(modelPath));
    expect(Object.keys(command?.environment ?? {}).sort()).toEqual([
      'HF_HUB_OFFLINE', 'HOME', 'PATH', 'PYTHONNOUSERSITE', 'PYTHONUNBUFFERED', 'TMPDIR', 'TRANSFORMERS_OFFLINE',
    ]);
    expect(command?.environment).toMatchObject({
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONNOUSERSITE: '1',
    });
    await expect(engine.transcribe({
      audioPath: resolve(root, 'audio.wav'), language: 'ja', timeoutMs: 1_000,
    })).resolves.toMatchObject({ transcript: 'テスト' });
    await engine.close();
    expect(client.close).toHaveBeenCalledOnce();
    await expect(engine.initialize()).rejects.toMatchObject({ code: 'local_runtime_closed' });
  });

  it('fails closed when the configured model hash does not match', async () => {
    const root = await createTemporaryDirectory();
    const pythonPath = resolve(root, 'mlx/venv/bin/python3');
    const modelPath = resolve(root, 'models/mlx/whisper-large-v3-turbo');
    const workerPath = resolve(root, 'scripts/worker.py');
    await mkdir(dirname(pythonPath), { recursive: true });
    await mkdir(modelPath, { recursive: true });
    await mkdir(dirname(workerPath), { recursive: true });
    await writeFile(pythonPath, 'python');
    await writeFile(resolve(modelPath, 'config.json'), '{}');
    await writeFile(resolve(modelPath, 'weights.safetensors'), 'weights');
    await writeFile(workerPath, 'worker');
    const engine = new MlxWhisperEngine({
      root, modelId: 'large-v3-turbo', pythonPath, pythonSha256: hash('python'), modelPath,
      modelSha256: '0'.repeat(64), workerPath, startupTimeoutMs: 1_000,
      platform: 'darwin', architecture: 'arm64',
    });
    await expect(engine.initialize()).rejects.toMatchObject({ code: 'local_model_hash_mismatch' });
  });
});

describe('shared Local Whisper runtime boundary', () => {
  it('feeds the same private PCM WAV queue into a selected engine', async () => {
    const root = await createTemporaryDirectory();
    const initialize = vi.fn(async () => undefined);
    const transcribe = vi.fn(async ({ audioPath }: { audioPath: string }) => {
      const wav = await readFile(audioPath);
      expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      return {
        transcript: '共通ランタイム',
        segments: [{ startMs: 0, endMs: 500, text: '共通ランタイム' }],
        processingTimeMs: 20,
        unparsedOutputLineCount: 0,
      };
    });
    const engine: LocalWhisperEngine = {
      descriptor: { id: 'mlx-whisper', modelId: MLX_WHISPER_MODEL_ID, threadCount: null },
      initialize,
      transcribe,
      close: vi.fn(async () => undefined),
    };
    const runtime = new LocalWhisperRuntime({
      enabled: true, modelId: 'large-v3-turbo', root, threads: 4,
      maxQueueSize: 2, maxSessions: 1, processTimeoutMs: 1_000, engine,
    });
    await runtime.registerSession('session');
    const completed = new Promise<LocalWhisperRecognitionResult>((resolveCompleted, rejectCompleted) => {
      runtime.enqueueMany([{
        sessionId: 'session', utteranceId: 'utterance', language: 'ja',
        utterance: {
          pcm: Buffer.alloc(16_000, 1), startFrame: 0, endFrame: 8_000,
          audioDurationMs: 500, sequenceStart: 0, sequenceEnd: 0,
          reason: 'session_stop', adaptiveNoiseFloor: 0,
        },
        vadConfiguration: DEFAULT_VAD_CONFIGURATION,
        createdAt: Date.now(),
        onStarted: () => undefined,
        onCompleted: resolveCompleted,
        onError: rejectCompleted,
      }]);
    });
    await expect(completed).resolves.toMatchObject({ transcript: '共通ランタイム', audioDurationMs: 500 });
    expect(initialize).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledOnce();
    await runtime.close();
  });
});

describe('persistent MLX worker protocol', () => {
  it('reuses one process for multiple timestamped requests', async () => {
    const root = await createTemporaryDirectory();
    const fixturePath = resolve(root, 'worker-fixture.mjs');
    await writeFile(fixturePath, `
      import readline from 'node:readline';
      const lines = readline.createInterface({ input: process.stdin });
      process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
      lines.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.type === 'close') process.exit(0);
        const respond = () => process.stdout.write(JSON.stringify({
            type: 'result', id: request.id, text: request.language === 'ja' ? '日本語' : 'English',
            segments: [{ startMs: 0, endMs: 250, text: 'segment' }], processingTimeMs: 12,
          }) + '\\n');
        if (request.audioPath === 'slow.wav') setTimeout(respond, 500);
        else respond();
      });
    `);
    const client = new PersistentMlxWhisperWorkerClient({
      executablePath: process.execPath,
      arguments: [fixturePath],
      environment: process.env,
    });
    await client.start(2_000);
    await expect(client.transcribe({ audioPath: 'one.wav', language: 'ja', timeoutMs: 2_000 }))
      .resolves.toMatchObject({ transcript: '日本語', segments: [{ startMs: 0, endMs: 250 }] });
    await expect(client.transcribe({ audioPath: 'two.wav', language: 'en', timeoutMs: 2_000 }))
      .resolves.toMatchObject({ transcript: 'English', processingTimeMs: expect.any(Number) });
    const controller = new AbortController();
    const cancelled = client.transcribe({
      audioPath: 'slow.wav', language: 'ja', timeoutMs: 2_000, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(cancelled).rejects.toMatchObject({ code: 'local_process_cancelled' });
    await expect(client.transcribe({ audioPath: 'after-cancel.wav', language: 'en', timeoutMs: 2_000 }))
      .resolves.toMatchObject({ transcript: 'English' });
    await client.close();
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'minutes-mlx-whisper-'));
  temporaryDirectories.push(directory);
  return directory;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
