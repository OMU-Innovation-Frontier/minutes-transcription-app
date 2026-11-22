import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import type { WireLanguage } from '../../../../shared/protocol.js';
import { sha256File } from './chunkComparison.js';
import type { LocalWhisperEngine, LocalWhisperEngineInput, LocalWhisperEngineResult } from './localWhisperEngine.js';
import { validateExistingDirectory, validateExistingFile } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';

export const MLX_WHISPER_MODEL_ID = 'whisper-large-v3-turbo-mlx';
export const MLX_WHISPER_PACKAGE_VERSION = '0.4.3';
export const MLX_LARGE_V3_TURBO_WEIGHTS_SHA256 = '951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6';
const MAX_PROTOCOL_LINE_BYTES = 4 * 1024 * 1024;

export interface MlxWhisperEngineOptions {
  root: string;
  modelId: string;
  pythonPath?: string;
  pythonSha256?: string;
  modelPath?: string;
  modelSha256?: string;
  workerPath: string;
  startupTimeoutMs: number;
  platform?: NodeJS.Platform;
  architecture?: string;
  workerFactory?: (command: MlxWhisperWorkerCommand) => MlxWhisperWorkerClient;
}

export interface MlxWhisperWorkerCommand {
  executablePath: string;
  arguments: readonly string[];
  environment: NodeJS.ProcessEnv;
}

export interface MlxWhisperWorkerRequest {
  audioPath: string;
  language: WireLanguage;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface MlxWhisperWorkerClient {
  start(timeoutMs: number): Promise<void>;
  transcribe(request: MlxWhisperWorkerRequest): Promise<LocalWhisperEngineResult>;
  close(): Promise<void>;
}

interface WorkerSegment {
  startMs: number;
  endMs: number;
  text: string;
}

interface PendingRequest {
  id: string;
  startedAt: number;
  resolve(result: LocalWhisperEngineResult): void;
  reject(error: LocalSttError): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

export class MlxWhisperEngine implements LocalWhisperEngine {
  readonly descriptor = {
    id: 'mlx-whisper' as const,
    modelId: MLX_WHISPER_MODEL_ID,
    threadCount: null,
  };
  private worker?: MlxWhisperWorkerClient;
  private initialized?: Promise<void>;
  private closed = false;

  constructor(private readonly options: MlxWhisperEngineOptions) {}

  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(new LocalSttError('local_runtime_closed', 'MLX Whisper is shutting down.'));
    this.initialized ??= this.initializeOnce();
    return this.initialized;
  }

  async transcribe(input: LocalWhisperEngineInput): Promise<LocalWhisperEngineResult> {
    await this.initialize();
    if (!this.worker) throw new LocalSttError('local_process_start_failed', 'MLX Whisper worker is unavailable.');
    return await this.worker.transcribe(input);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.worker?.close();
    this.worker = undefined;
  }

  private async initializeOnce(): Promise<void> {
    const platform = this.options.platform ?? process.platform;
    const architecture = this.options.architecture ?? process.arch;
    if (platform !== 'darwin' || architecture !== 'arm64') {
      throw new LocalSttError('local_engine_unsupported', 'MLX Whisper requires Apple Silicon macOS.');
    }
    if (this.options.modelId !== 'large-v3-turbo') {
      throw new LocalSttError('local_model_unsupported', 'MLX Whisper requires the large-v3-turbo model.');
    }

    const pythonRoot = resolve(this.options.root, 'mlx');
    const modelRoot = resolve(this.options.root, 'models');
    const pythonPath = resolve(this.options.pythonPath ?? resolve(pythonRoot, 'venv/bin/python3'));
    const modelPath = resolve(this.options.modelPath ?? resolve(modelRoot, 'mlx/whisper-large-v3-turbo'));
    const pythonSha256 = requireSha256(
      this.options.pythonSha256,
      'local_executable_hash_missing',
      'LOCAL_STT_MLX_PYTHON_SHA256 is required for the MLX Python executable.',
    );
    const modelSha256 = requireSha256(
      this.options.modelSha256 ?? MLX_LARGE_V3_TURBO_WEIGHTS_SHA256,
      'local_model_hash_missing',
      'LOCAL_STT_MLX_MODEL_SHA256 is required for the MLX model weights.',
    );

    const [verifiedPython, verifiedModel, verifiedWorker] = await Promise.all([
      validateExistingFile(
        pythonPath,
        [pythonRoot],
        'local_executable_missing',
        'The MLX Python executable is missing or outside the Local STT MLX directory.',
      ),
      validateExistingDirectory(
        modelPath,
        [modelRoot],
        'local_model_missing',
        'The MLX Whisper model directory is missing or outside the Local STT model directory.',
      ),
      validateExistingFile(
        resolve(this.options.workerPath),
        [dirname(resolve(this.options.workerPath))],
        'local_worker_missing',
        'The MLX Whisper worker script is missing.',
      ),
    ]);
    const [weightsPath] = await Promise.all([
      // The pinned mlx-whisper loader prefers this exact filename; hash that file,
      // not a differently named artifact the loader may ignore.
      validateExistingFile(
        resolve(verifiedModel, 'weights.safetensors'),
        [verifiedModel],
        'local_model_missing',
        'The MLX Whisper weights.safetensors file is missing or invalid.',
      ),
      validateExistingFile(
        resolve(verifiedModel, 'config.json'),
        [verifiedModel],
        'local_model_missing',
        'The MLX Whisper model config is missing.',
      ),
    ]);
    const [actualPythonSha256, actualModelSha256] = await Promise.all([
      sha256File(verifiedPython),
      sha256File(weightsPath),
    ]);
    if (actualPythonSha256 !== pythonSha256) {
      throw new LocalSttError('local_executable_hash_mismatch', 'The MLX Python executable failed integrity verification.');
    }
    if (actualModelSha256 !== modelSha256) {
      throw new LocalSttError('local_model_hash_mismatch', 'The MLX Whisper model failed integrity verification.');
    }

    if (this.closed) throw new LocalSttError('local_runtime_closed', 'MLX Whisper is shutting down.');
    const command: MlxWhisperWorkerCommand = {
      executablePath: verifiedPython,
      arguments: [
        '-I', '-u', verifiedWorker,
        '--model', verifiedModel,
        '--package-version', MLX_WHISPER_PACKAGE_VERSION,
      ],
      environment: {
        // Keep server-side API credentials and Python overrides out of the local worker.
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PATH: '/usr/bin:/bin',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONUNBUFFERED: '1',
      },
    };
    this.worker = this.options.workerFactory?.(command) ?? new PersistentMlxWhisperWorkerClient(command);
    await this.worker.start(this.options.startupTimeoutMs);
  }
}

export class PersistentMlxWhisperWorkerClient implements MlxWhisperWorkerClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = Buffer.alloc(0);
  private pending?: PendingRequest;
  private readyPromise?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: LocalSttError) => void;
  private requestSequence = 0;
  private closed = false;

  constructor(private readonly command: MlxWhisperWorkerCommand) {}

  start(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.reject(new LocalSttError('local_runtime_closed', 'MLX Whisper is shutting down.'));
    if (this.child && this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    const child = spawn(this.command.executablePath, [...this.command.arguments], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.command.environment,
    });
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    const startupTimer = setTimeout(() => {
      this.failWorker(new LocalSttError('local_process_timeout', 'MLX Whisper worker startup timed out.'));
    }, timeoutMs);
    startupTimer.unref();
    this.readyPromise.finally(() => clearTimeout(startupTimer)).catch(() => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child === child) this.handleStdout(chunk);
    });
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => {
      if (this.child !== child) return;
      this.failWorker(new LocalSttError('local_process_start_failed', 'MLX Whisper worker could not be started.', { cause: error }));
    });
    child.stdin.on('error', () => {
      if (this.child !== child) return;
      this.failWorker(new LocalSttError('local_process_failed', 'MLX Whisper worker input closed unexpectedly.'));
    });
    child.once('close', (code) => {
      if (this.child !== child) return;
      this.failWorker(new LocalSttError(
        'local_process_failed',
        code === 0 ? 'MLX Whisper worker stopped unexpectedly.' : 'MLX Whisper worker failed.',
      ), false);
    });
    return this.readyPromise;
  }

  async transcribe(request: MlxWhisperWorkerRequest): Promise<LocalWhisperEngineResult> {
    await this.start(request.timeoutMs);
    if (!this.child?.stdin.writable) throw new LocalSttError('local_process_start_failed', 'MLX Whisper worker is unavailable.');
    if (this.pending) throw new LocalSttError('local_queue_limit', 'MLX Whisper accepts one recognition request at a time.');
    if (request.signal?.aborted) throw new LocalSttError('local_process_cancelled', 'MLX Whisper processing was cancelled.');
    const id = `request-${++this.requestSequence}`;
    return await new Promise<LocalWhisperEngineResult>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        this.failWorker(new LocalSttError('local_process_timeout', 'MLX Whisper recognition timed out.'));
      }, request.timeoutMs);
      timer.unref();
      const pending: PendingRequest = {
        id,
        startedAt: performance.now(),
        resolve: resolveResult,
        reject: rejectResult,
        timer,
        signal: request.signal,
      };
      if (request.signal) {
        pending.abort = () => this.failWorker(new LocalSttError('local_process_cancelled', 'MLX Whisper processing was cancelled.'));
        request.signal.addEventListener('abort', pending.abort, { once: true });
      }
      this.pending = pending;
      const child = this.child!;
      child.stdin.write(`${JSON.stringify({
        type: 'transcribe', id, audioPath: request.audioPath, language: request.language,
      })}\n`, (error) => {
        if (error && this.child === child) this.failWorker(new LocalSttError('local_process_failed', 'MLX Whisper request could not be sent.', { cause: error }));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failWorker(new LocalSttError('local_runtime_closed', 'MLX Whisper is shutting down.'));
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.byteLength > MAX_PROTOCOL_LINE_BYTES) {
      this.failWorker(new LocalSttError('local_output_limit', 'MLX Whisper produced too much protocol output.'));
      return;
    }
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline).toString('utf8').trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.failWorker(new LocalSttError('local_process_failed', 'MLX Whisper returned invalid protocol data.', { cause: error }));
      return;
    }
    if (!isRecord(value) || typeof value.type !== 'string') {
      this.failWorker(new LocalSttError('local_process_failed', 'MLX Whisper returned invalid protocol data.'));
      return;
    }
    if (value.type === 'ready') {
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    const pending = this.pending;
    if (!pending || value.id !== pending.id) {
      this.failWorker(new LocalSttError('local_process_failed', 'MLX Whisper returned an unexpected response.'));
      return;
    }
    if (value.type === 'error') {
      this.finishPending(undefined, new LocalSttError('local_recognition_failed', 'MLX Whisper recognition failed.'));
      return;
    }
    if (value.type !== 'result' || typeof value.text !== 'string'
      || typeof value.processingTimeMs !== 'number' || !Number.isFinite(value.processingTimeMs)
      || !Array.isArray(value.segments)) {
      this.failWorker(new LocalSttError('local_process_failed', 'MLX Whisper returned an invalid recognition result.'));
      return;
    }
    const segments = parseSegments(value.segments);
    if (!segments) {
      this.failWorker(new LocalSttError('local_process_failed', 'MLX Whisper returned invalid timestamp segments.'));
      return;
    }
    this.finishPending({
      transcript: value.text.trim(),
      segments,
      processingTimeMs: performance.now() - pending.startedAt,
      unparsedOutputLineCount: 0,
    });
  }

  private finishPending(result?: LocalWhisperEngineResult, error?: LocalSttError): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort);
    if (error) pending.reject(error);
    else if (result) pending.resolve(result);
  }

  private failWorker(error: LocalSttError, terminate = true): void {
    const child = this.child;
    this.child = undefined;
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.readyPromise = undefined;
    this.finishPending(undefined, error);
    if (terminate && child && !child.killed) child.kill();
  }
}

function requireSha256(value: string | undefined, code: string, message: string): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) throw new LocalSttError(code, message);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new LocalSttError(code, message);
  return normalized;
}

function parseSegments(value: unknown[]): WorkerSegment[] | undefined {
  const segments: WorkerSegment[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isFinite(item.startMs) || !Number.isFinite(item.endMs)
      || typeof item.text !== 'string' || (item.startMs as number) < 0 || (item.endMs as number) < (item.startMs as number)) {
      return undefined;
    }
    segments.push({
      startMs: Math.round(item.startMs as number),
      endMs: Math.round(item.endMs as number),
      text: item.text.trim(),
    });
  }
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
