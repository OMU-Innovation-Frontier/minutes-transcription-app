import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WireLanguage } from '../../../../shared/protocol.js';
import { parseWhisperTimestampOutput, sha256File, assertSafeChildPath, type TimestampedSegment } from './chunkComparison.js';
import { LocalProcessManager, validateExistingFile } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';
import type { PcmUtterance } from './pcmUtteranceSegmenter.js';
import type { VadConfiguration } from './pcmUtteranceSegmenter.js';
import type { RealtimeDebugAudioStore } from './realtimeDebugAudio.js';

export const SMALL_Q5_1_SHA256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';
export const WHISPER_CLI_SHA256 = '58245314fb73b30fbd0cf0542c5c172e23f02b6eb7cad7b51e792439cf5e1755';
export const LOCAL_WHISPER_MODEL_ID = 'whisper-small-q5_1';

export interface LocalWhisperRuntimeOptions {
  enabled: boolean;
  modelId: string;
  root: string;
  threads: number;
  maxQueueSize: number;
  maxSessions: number;
  processTimeoutMs: number;
  debugAudioStore?: RealtimeDebugAudioStore;
}

export interface LocalWhisperJob {
  sessionId: string;
  utteranceId: string;
  language: WireLanguage;
  utterance: PcmUtterance;
  vadConfiguration: VadConfiguration;
  createdAt: number;
  onStarted(queueLength: number, queueWaitTimeMs: number): void;
  onCompleted(result: LocalWhisperRecognitionResult): void;
  onError(error: LocalSttError): void;
}

export interface LocalWhisperRecognitionResult {
  transcript: string;
  segments: TimestampedSegment[];
  audioDurationMs: number;
  processingTimeMs: number;
  realTimeFactor: number;
  queueWaitTimeMs: number;
  totalLatencyMs: number;
  processExitCode: number;
  processCpuAveragePercent?: number;
  processCpuPeakPercent?: number;
  peakWorkingSetBytes?: number;
  unparsedOutputLineCount: number;
  completedAt: number;
}

export interface TimestampedWhisperFileResult {
  transcript: string;
  segments: TimestampedSegment[];
  processingTimeMs: number;
  processExitCode: number;
  processCpuAveragePercent?: number;
  processCpuPeakPercent?: number;
  peakWorkingSetBytes?: number;
  unparsedOutputLineCount: number;
}

export class LocalWhisperRuntime {
  private readonly binaryRoot: string;
  private readonly modelRoot: string;
  private readonly temporaryRoot: string;
  private readonly executablePath: string;
  private readonly modelPath: string;
  private readonly processes = new LocalProcessManager(1);
  private readonly queue: LocalWhisperJob[] = [];
  private readonly activeSessions = new Set<string>();
  private readonly pendingBySession = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private availability?: Promise<void>;
  private running = false;
  private runningSessionId?: string;
  private runningAbortController?: AbortController;
  private closed = false;
  private cancelledSessions = new Set<string>();

  constructor(private readonly options: LocalWhisperRuntimeOptions) {
    this.binaryRoot = resolve(options.root, 'bin');
    this.modelRoot = resolve(options.root, 'models');
    this.temporaryRoot = resolve(options.root, 'temp/realtime');
    this.executablePath = resolve(this.binaryRoot, 'v1.9.1/Release/whisper-cli.exe');
    this.modelPath = resolve(this.modelRoot, 'ggml-small-q5_1.bin');
  }

  get queueLength(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  async registerSession(sessionId: string): Promise<void> {
    if (!this.options.enabled) throw new LocalSttError('local_stt_disabled', 'Local Whisper is disabled by server configuration.');
    if (this.closed) throw new LocalSttError('local_runtime_closed', 'Local Whisper is shutting down.');
    if (!this.activeSessions.has(sessionId) && this.activeSessions.size >= this.options.maxSessions) {
      throw new LocalSttError('local_session_limit', 'The Local Whisper session limit has been reached.');
    }
    await this.ensureAvailable();
    this.activeSessions.add(sessionId);
    this.cancelledSessions.delete(sessionId);
  }

  unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  enqueueMany(jobs: readonly LocalWhisperJob[]): void {
    if (jobs.length === 0) return;
    if (this.closed || this.queueLength + jobs.length > this.options.maxQueueSize) {
      throw new LocalSttError('local_queue_limit', 'The Local Whisper recognition queue is full.');
    }
    for (const job of jobs) {
      if (!this.activeSessions.has(job.sessionId) || this.cancelledSessions.has(job.sessionId)) {
        throw new LocalSttError('local_session_inactive', 'The Local Whisper session is no longer active.');
      }
      this.queue.push(job);
      this.pendingBySession.set(job.sessionId, (this.pendingBySession.get(job.sessionId) ?? 0) + 1);
    }
    void this.drain();
  }

  waitForSession(sessionId: string): Promise<void> {
    if ((this.pendingBySession.get(sessionId) ?? 0) === 0) return Promise.resolve();
    return new Promise<void>((resolveWaiter) => {
      const waiters = this.waiters.get(sessionId) ?? [];
      waiters.push(resolveWaiter);
      this.waiters.set(sessionId, waiters);
    });
  }

  cancelSession(sessionId: string): void {
    this.cancelledSessions.add(sessionId);
    if (this.runningSessionId === sessionId) this.runningAbortController?.abort();
    const removed = this.queue.filter((job) => job.sessionId === sessionId);
    for (const job of removed) this.completePending(job.sessionId);
    this.queue.splice(0, this.queue.length, ...this.queue.filter((job) => job.sessionId !== sessionId));
    this.activeSessions.delete(sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) this.completePending(job.sessionId);
    this.activeSessions.clear();
    await this.processes.close();
  }

  private ensureAvailable(): Promise<void> {
    this.availability ??= this.verifyFiles();
    return this.availability;
  }

  private async verifyFiles(): Promise<void> {
    if (this.options.modelId !== 'small-q5_1') {
      throw new LocalSttError('local_model_unsupported', 'The configured Local Whisper model is not supported.');
    }
    if (this.options.threads !== 4) throw new LocalSttError('local_threads_invalid', 'Local Whisper requires four CPU threads.');
    const [model, executable] = await Promise.all([
      validateExistingFile(this.modelPath, [this.modelRoot], 'local_model_missing', 'The Local Whisper model is not available.'),
      validateExistingFile(this.executablePath, [this.binaryRoot], 'local_executable_missing', 'The whisper.cpp executable is not available.'),
    ]);
    const [modelHash, executableHash] = await Promise.all([sha256File(model), sha256File(executable)]);
    if (modelHash !== SMALL_Q5_1_SHA256) throw new LocalSttError('local_model_hash_mismatch', 'The Local Whisper model failed integrity verification.');
    if (executableHash !== WHISPER_CLI_SHA256) throw new LocalSttError('local_executable_hash_mismatch', 'The whisper.cpp executable failed integrity verification.');
    await mkdir(this.temporaryRoot, { recursive: true });
  }

  private async drain(): Promise<void> {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed) {
        const job = this.queue.shift();
        if (!job) break;
        if (this.cancelledSessions.has(job.sessionId)) {
          this.completePending(job.sessionId);
          continue;
        }
        const queueWaitTimeMs = Date.now() - job.createdAt;
        const abortController = new AbortController();
        this.runningSessionId = job.sessionId;
        this.runningAbortController = abortController;
        job.onStarted(this.queueLength, queueWaitTimeMs);
        try {
          const result = await this.recognize(job, queueWaitTimeMs, abortController.signal);
          if (!this.cancelledSessions.has(job.sessionId)) job.onCompleted(result);
        } catch (error) {
          if (!this.cancelledSessions.has(job.sessionId)) job.onError(toLocalSttError(error));
        } finally {
          this.runningSessionId = undefined;
          this.runningAbortController = undefined;
          this.completePending(job.sessionId);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0 && !this.closed) void this.drain();
    }
  }

  private async recognize(
    job: LocalWhisperJob,
    queueWaitTimeMs: number,
    signal: AbortSignal,
  ): Promise<LocalWhisperRecognitionResult> {
    const temporaryPath = resolve(this.temporaryRoot, `utterance-${randomUUID()}.wav`);
    assertSafeChildPath(this.temporaryRoot, temporaryPath);
    await writeFile(temporaryPath, createPcm16Wav(job.utterance.pcm), { flag: 'wx', mode: 0o600 });
    const debugCapture = await this.options.debugAudioStore?.capture({
      temporaryWavPath: temporaryPath,
      sessionId: job.sessionId,
      utteranceId: job.utteranceId,
      language: job.language,
      utterance: job.utterance,
      vad: job.vadConfiguration,
      modelSha256: SMALL_Q5_1_SHA256,
      whisperCliSha256: WHISPER_CLI_SHA256,
    });
    let recognition: LocalWhisperRecognitionResult | undefined;
    let failure: unknown;
    try {
      const result = await runTimestampedWhisperFile({
        processes: this.processes,
        executablePath: this.executablePath,
        binaryRoot: this.binaryRoot,
        modelPath: this.modelPath,
        audioPath: temporaryPath,
        language: job.language,
        threads: this.options.threads,
        timeoutMs: this.options.processTimeoutMs,
        signal,
      });
      const completedAt = Date.now();
      recognition = {
        transcript: result.transcript,
        segments: result.segments,
        audioDurationMs: job.utterance.audioDurationMs,
        processingTimeMs: result.processingTimeMs,
        realTimeFactor: result.processingTimeMs / job.utterance.audioDurationMs,
        queueWaitTimeMs,
        totalLatencyMs: completedAt - job.createdAt,
        processExitCode: result.processExitCode,
        processCpuAveragePercent: result.processCpuAveragePercent,
        processCpuPeakPercent: result.processCpuPeakPercent,
        peakWorkingSetBytes: result.peakWorkingSetBytes,
        unparsedOutputLineCount: result.unparsedOutputLineCount,
        completedAt,
      };
    } catch (error) {
      failure = error;
    }
    await this.options.debugAudioStore?.finalize(debugCapture, {
      processingTimeMs: recognition?.processingTimeMs ?? null,
      realTimeFactor: recognition?.realTimeFactor ?? null,
      segmentCount: recognition?.segments.length ?? null,
      transcript: recognition?.transcript ?? null,
      errorCode: failure instanceof LocalSttError ? failure.code : failure ? 'local_recognition_failed' : null,
    });
    try {
      await rm(temporaryPath, { force: true });
    } catch (error) {
      failure ??= new LocalSttError(
        'local_temp_cleanup_failed',
        'Local Whisper temporary audio cleanup failed.',
        { cause: error },
      );
    }
    if (failure) throw failure;
    if (!recognition) throw new LocalSttError('local_recognition_failed', 'Local Whisper recognition failed.');
    return recognition;
  }

  private completePending(sessionId: string): void {
    const next = Math.max(0, (this.pendingBySession.get(sessionId) ?? 1) - 1);
    if (next > 0) {
      this.pendingBySession.set(sessionId, next);
      return;
    }
    this.pendingBySession.delete(sessionId);
    for (const waiter of this.waiters.get(sessionId) ?? []) waiter();
    this.waiters.delete(sessionId);
  }
}

export async function runTimestampedWhisperFile(options: {
  processes: LocalProcessManager;
  executablePath: string;
  binaryRoot: string;
  modelPath: string;
  audioPath: string;
  language: WireLanguage;
  threads: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<TimestampedWhisperFileResult> {
  const result = await options.processes.run({
    executablePath: options.executablePath,
    allowedExecutableRoots: [options.binaryRoot],
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    arguments: buildLocalWhisperArguments(
      options.modelPath,
      options.audioPath,
      options.language,
      options.threads,
    ),
  });
  const segments = parseWhisperTimestampOutput(result.stdout);
  const outputLines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (segments.length === 0 && outputLines.length > 0) {
    throw new LocalSttError('local_timestamp_parse_failed', 'Local Whisper returned an unrecognized timestamp format.');
  }
  return {
    transcript: segments.map((segment) => segment.text).join(' ').trim(),
    segments,
    processingTimeMs: result.totalProcessingMs,
    processExitCode: result.exitCode,
    processCpuAveragePercent: result.cpuAveragePercent,
    processCpuPeakPercent: result.cpuPeakPercent,
    peakWorkingSetBytes: result.peakMemoryBytes,
    unparsedOutputLineCount: Math.max(0, outputLines.length - segments.length),
  };
}

export function buildLocalWhisperArguments(
  modelPath: string,
  audioPath: string,
  language: WireLanguage,
  threads: number,
): string[] {
  if (language !== 'ja' && language !== 'en') throw new LocalSttError('local_language_unsupported', 'Local Whisper language is invalid.');
  if (threads !== 4) throw new LocalSttError('local_threads_invalid', 'Local Whisper requires four CPU threads.');
  return [
    '--model', modelPath,
    '--file', audioPath,
    '--language', language,
    '--threads', String(threads),
    '--no-prints',
    '--no-gpu',
  ];
}

function createPcm16Wav(pcm: Buffer): Buffer {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new LocalSttError('local_pcm_invalid', 'Local Whisper received invalid PCM16 audio.');
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
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

function toLocalSttError(error: unknown): LocalSttError {
  return error instanceof LocalSttError
    ? error
    : new LocalSttError('local_recognition_failed', 'Local Whisper recognition failed.', { cause: error });
}
