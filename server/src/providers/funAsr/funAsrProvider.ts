import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { MAX_AUDIO_CHUNK_BYTES, type TranscriptWireSegment, type WireLanguage } from '../../../../shared/protocol.js';
import {
  createFunAsrFinishTask,
  createFunAsrRunTask,
  FUN_ASR_REALTIME_MODEL,
  FUN_ASR_SAMPLE_RATE,
  FunAsrProtocolError,
  parseFunAsrServerEvent,
  type FunAsrServerEvent,
} from './funAsrProtocol.js';
import type { FunAsrTransport, FunAsrTransportFactory } from './funAsrTransport.js';
import type { FunAsrUsageGuard } from './funAsrUsageGuard.js';
import {
  ServerProviderError,
  type ServerRecognitionStatus,
  type SttAudioChunk,
  type SttProvider,
  type SttSessionConfig,
  type SttTranscriptResult,
} from '../types.js';

const PCM_MIME_TYPE = 'audio/pcm;rate=16000;channels=1;format=s16le';
const MAX_FINAL_BUFFER_SIZE = 256;
const MAX_TRACKED_SENTENCES = 4_096;

type Lifecycle = 'idle' | 'starting' | 'active' | 'stopping' | 'stopped' | 'cancelled' | 'failed' | 'disposed';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: ServerProviderError): void;
}

export interface FunAsrProviderOptions {
  externalEnabled: boolean;
  transportFactory?: FunAsrTransportFactory;
  usageGuard?: FunAsrUsageGuard;
  model?: string;
  startTimeoutMs?: number;
  sendTimeoutMs?: number;
  finishTimeoutMs?: number;
  now?: () => number;
  randomUUID?: () => string;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface BufferedFinal {
  result?: SttTranscriptResult;
}

export class FunAsrProvider implements SttProvider {
  readonly id = 'fun-asr';
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly setTimer: NonNullable<FunAsrProviderOptions['setTimer']>;
  private readonly clearTimer: NonNullable<FunAsrProviderOptions['clearTimer']>;
  private readonly startTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly finishTimeoutMs: number;
  private lifecycle: Lifecycle = 'idle';
  private sessionId = '';
  private language: WireLanguage = 'ja';
  private taskId = '';
  private sessionStartedAt = 0;
  private transport?: FunAsrTransport;
  private cleanupPromise?: Promise<void>;
  private unsubscribe: Array<() => void> = [];
  private started = createDeferred();
  private finished = createDeferred();
  private sendChain: Promise<void> = Promise.resolve();
  private stopPromise?: Promise<void>;
  private cancelPromise?: Promise<void>;
  private readonly pendingTimeouts = new Map<ReturnType<typeof setTimeout>, (error: ServerProviderError) => void>();
  private expectedSequence = 0;
  private finishSent = false;
  private guardSlotHeld = false;
  private nextFinalSentenceId = 1;
  private readonly revisions = new Map<number, number>();
  private readonly finalized = new Set<number>();
  private readonly finalBuffer = new Map<number, BufferedFinal>();
  private latestUsageDurationSeconds?: number;
  private transcriptCallback: (result: SttTranscriptResult) => void = () => undefined;
  private errorCallback: (error: ServerProviderError) => void = () => undefined;
  private statusCallback: (status: ServerRecognitionStatus) => void = () => undefined;

  constructor(private readonly options: FunAsrProviderOptions) {
    this.now = options.now ?? Date.now;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.startTimeoutMs = options.startTimeoutMs ?? 15_000;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 15_000;
    this.finishTimeoutMs = options.finishTimeoutMs ?? 15_000;
  }

  async startSession(config: SttSessionConfig): Promise<void> {
    if (this.lifecycle !== 'idle') throw providerError('fun_asr_session_inactive');
    if (!this.options.externalEnabled) throw providerError('external_stt_disabled');
    if (!this.options.transportFactory) throw providerError('fun_asr_live_transport_unavailable');
    if (!this.options.usageGuard) throw providerError('fun_asr_usage_limits_required');
    assertSessionFormat(config);

    this.lifecycle = 'starting';
    this.sessionId = config.sessionId;
    this.language = config.language;
    this.sessionStartedAt = this.now();
    this.taskId = this.randomUUID();
    this.started = createDeferred();
    this.finished = createDeferred();
    let runTask: ReturnType<typeof createFunAsrRunTask>;
    try {
      runTask = createFunAsrRunTask({
        taskId: this.taskId,
        model: this.options.model,
        language: this.language,
        sampleRate: FUN_ASR_SAMPLE_RATE,
      });
    } catch {
      this.lifecycle = 'failed';
      throw providerError('fun_asr_model_unsupported');
    }

    try {
      this.options.usageGuard.beginSession(this.sessionId);
      this.guardSlotHeld = true;
      this.transport = this.options.transportFactory();
      this.attachTransport(this.transport);
      await this.withTimeout((async () => {
        await this.transport?.connect();
        await this.transport?.sendControl(runTask);
        await this.started.promise;
      })(), this.startTimeoutMs, 'fun_asr_start_timeout');
      if (this.lifecycle !== 'starting') throw providerError('fun_asr_session_inactive');
      this.lifecycle = 'active';
      this.emitStatus('listening');
    } catch (error) {
      const safeError = normalizeProviderError(error, 'fun_asr_transport_closed');
      this.lifecycle = 'failed';
      await this.cleanupTransport();
      this.releaseGuard();
      throw safeError;
    }
  }

  async sendAudio(chunk: SttAudioChunk): Promise<void> {
    const operation = this.sendChain.then(async () => {
      if (this.lifecycle !== 'active' || chunk.sessionId !== this.sessionId) {
        throw providerError('fun_asr_session_inactive');
      }
      if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== this.expectedSequence) {
        throw providerError('fun_asr_audio_sequence_invalid');
      }
      const frames = validateAudioChunk(chunk);
      this.expectedSequence += 1;
      if (frames === 0) return;
      const audioCopy = chunk.audio.slice();
      this.options.usageGuard?.reserveAudioFrames(this.sessionId, frames);
      try {
        const transport = this.transport;
        if (!transport) throw providerError('fun_asr_transport_closed');
        await this.withTimeout(
          transport.sendAudio(audioCopy),
          this.sendTimeoutMs,
          'fun_asr_transport_closed',
        );
      } catch (cause) {
        const error = normalizeSendError(cause);
        this.fail(error);
        throw error;
      }
    });
    this.sendChain = operation.catch(() => undefined);
    return operation;
  }

  async stopSession(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId || this.lifecycle === 'idle') return;
    if (this.stopPromise) return this.stopPromise;
    if (this.lifecycle === 'cancelled' || this.lifecycle === 'stopped' || this.lifecycle === 'disposed') return;
    if (this.lifecycle === 'failed') return this.cancelSession(sessionId);
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  async cancelSession(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId || this.lifecycle === 'idle') return;
    if (this.cancelPromise) return this.cancelPromise;
    if (this.lifecycle === 'cancelled' || this.lifecycle === 'stopped' || this.lifecycle === 'disposed') return;
    this.cancelPromise = this.performCancel();
    return this.cancelPromise;
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === 'disposed') return;
    if (this.lifecycle !== 'idle' && this.lifecycle !== 'stopped' && this.lifecycle !== 'cancelled') {
      await this.cancelSession(this.sessionId);
    }
    this.lifecycle = 'disposed';
    this.clearTranscriptState();
    await this.cleanupTransport();
    this.releaseGuard();
  }

  onTranscript(callback: (result: SttTranscriptResult) => void): void {
    this.transcriptCallback = callback;
  }

  onError(callback: (error: ServerProviderError) => void): void {
    this.errorCallback = callback;
  }

  onStatus(callback: (status: ServerRecognitionStatus) => void): void {
    this.statusCallback = callback;
  }

  get usageDurationSeconds(): number | undefined {
    return this.latestUsageDurationSeconds;
  }

  private attachTransport(transport: FunAsrTransport): void {
    this.unsubscribe = [
      transport.onMessage((message) => this.handleMessage(message)),
      transport.onError((error) => this.fail(normalizeProviderError(error, 'fun_asr_transport_closed'))),
      transport.onClose(() => {
        if (!['stopping', 'stopped', 'cancelled', 'disposed'].includes(this.lifecycle)) {
          this.fail(providerError('fun_asr_transport_closed'));
        }
      }),
    ];
  }

  private handleMessage(message: unknown): void {
    if (this.lifecycle === 'cancelled' || this.lifecycle === 'disposed' || this.lifecycle === 'stopped' || this.lifecycle === 'failed') return;
    let event: FunAsrServerEvent;
    try {
      event = parseFunAsrServerEvent(message);
    } catch (error) {
      if (error instanceof FunAsrProtocolError) {
        this.fail(providerError('fun_asr_protocol_invalid'));
        return;
      }
      this.fail(providerError('fun_asr_protocol_invalid'));
      return;
    }
    if (event.taskId !== this.taskId) {
      this.fail(providerError('fun_asr_protocol_invalid'));
      return;
    }

    switch (event.type) {
      case 'task-started':
        if (this.lifecycle === 'starting') this.started.resolve();
        break;
      case 'result-generated':
        this.handleResult(event);
        break;
      case 'task-finished':
        if (this.lifecycle !== 'stopping') {
          this.fail(providerError('fun_asr_protocol_invalid'));
          break;
        }
        this.recordUsage(event.usageDurationSeconds);
        this.flushRemainingFinals();
        this.finished.resolve();
        break;
      case 'task-failed':
        this.fail(providerError('fun_asr_task_failed'));
        break;
    }
  }

  private handleResult(event: Extract<FunAsrServerEvent, { type: 'result-generated' }>): void {
    this.recordUsage(event.usageDurationSeconds);
    if (event.heartbeat) return;
    if (this.lifecycle !== 'active' && this.lifecycle !== 'stopping') {
      this.fail(providerError('fun_asr_protocol_invalid'));
      return;
    }
    if (this.finalized.has(event.sentenceId)) return;
    if (!event.sentenceEnd && !event.text.trim()) return;
    if (!this.revisions.has(event.sentenceId) && this.revisions.size >= MAX_TRACKED_SENTENCES) {
      this.fail(providerError('fun_asr_result_limit'));
      return;
    }

    const revision = (this.revisions.get(event.sentenceId) ?? -1) + 1;
    this.revisions.set(event.sentenceId, revision);
    if (!event.sentenceEnd) {
      this.transcriptCallback(this.toTranscript(event, revision, false));
      return;
    }

    if (event.sentenceId !== this.nextFinalSentenceId && this.finalBuffer.size >= MAX_FINAL_BUFFER_SIZE) {
      this.fail(providerError('fun_asr_final_buffer_limit'));
      return;
    }
    this.finalized.add(event.sentenceId);
    const text = event.text.trim();
    this.finalBuffer.set(event.sentenceId, text ? { result: this.toTranscript(event, revision, true) } : {});
    this.flushContiguousFinals();
  }

  private toTranscript(
    event: Extract<FunAsrServerEvent, { type: 'result-generated' }>,
    revision: number,
    isFinal: boolean,
  ): SttTranscriptResult {
    const segments: TranscriptWireSegment[] = event.words.map((word) => ({
      startTimeMs: Math.max(0, word.beginTimeMs - event.beginTimeMs),
      endTimeMs: Math.max(0, word.endTimeMs - event.beginTimeMs),
      text: `${word.text}${word.punctuation}`,
    }));
    return {
      sessionId: this.sessionId,
      segmentId: `fun-asr:${this.taskId}:${event.sentenceId}`,
      revision,
      text: event.text,
      isFinal,
      language: this.language,
      startTime: this.sessionStartedAt + event.beginTimeMs,
      ...(isFinal ? { endTime: this.sessionStartedAt + event.endTimeMs } : {}),
      provider: this.id,
      model: FUN_ASR_REALTIME_MODEL,
      audioDurationMs: Math.max(0, event.endTimeMs - event.beginTimeMs),
      ...(segments.length > 0 ? { segments } : {}),
    };
  }

  private flushContiguousFinals(): void {
    while (this.finalBuffer.has(this.nextFinalSentenceId)) {
      const buffered = this.finalBuffer.get(this.nextFinalSentenceId);
      this.finalBuffer.delete(this.nextFinalSentenceId);
      this.nextFinalSentenceId += 1;
      if (buffered?.result) this.transcriptCallback(buffered.result);
    }
  }

  private flushRemainingFinals(): void {
    this.flushContiguousFinals();
    if (this.finalBuffer.size === 0) return;
    this.errorCallback(providerError('fun_asr_final_sequence_gap'));
    for (const sentenceId of [...this.finalBuffer.keys()].sort((left, right) => left - right)) {
      const buffered = this.finalBuffer.get(sentenceId);
      if (buffered?.result) this.transcriptCallback(buffered.result);
    }
    this.finalBuffer.clear();
  }

  private async performStop(): Promise<void> {
    this.lifecycle = 'stopping';
    try {
      await this.withTimeout((async () => {
        await this.sendChain;
        if (!this.finishSent && this.transport) {
          this.finishSent = true;
          await this.transport.sendControl(createFunAsrFinishTask(this.taskId));
        }
        await this.finished.promise;
      })(), this.finishTimeoutMs, 'fun_asr_finish_timeout');
      this.lifecycle = 'stopped';
      this.emitStatus('completed');
    } catch (error) {
      if (this.wasCancelledOrDisposed()) return;
      this.lifecycle = 'failed';
      throw normalizeProviderError(error, 'fun_asr_transport_closed');
    } finally {
      this.rejectPendingTimeouts(providerError('fun_asr_session_inactive'));
      this.clearTranscriptState();
      await this.cleanupTransport();
      this.releaseGuard();
    }
  }

  private async performCancel(): Promise<void> {
    this.lifecycle = 'cancelled';
    const cancelledError = providerError('fun_asr_session_inactive');
    this.started.reject(cancelledError);
    this.finished.reject(cancelledError);
    this.rejectPendingTimeouts(cancelledError);
    this.clearTranscriptState();
    await this.cleanupTransport();
    this.releaseGuard();
  }

  private fail(error: ServerProviderError): void {
    if (this.lifecycle === 'cancelled' || this.lifecycle === 'disposed' || this.lifecycle === 'stopped' || this.lifecycle === 'failed') return;
    this.lifecycle = 'failed';
    this.started.reject(error);
    this.finished.reject(error);
    this.rejectPendingTimeouts(error);
    this.errorCallback(error);
    this.clearTranscriptState();
    void this.cleanupTransport().finally(() => this.releaseGuard());
  }

  private recordUsage(duration: number | undefined): void {
    if (duration !== undefined) {
      this.latestUsageDurationSeconds = Math.max(this.latestUsageDurationSeconds ?? 0, duration);
    }
  }

  private cleanupTransport(): Promise<void> {
    this.cleanupPromise ??= this.performCleanupTransport();
    return this.cleanupPromise;
  }

  private async performCleanupTransport(): Promise<void> {
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Listener cleanup must not prevent the remaining resources from closing.
      }
    }
    const transport = this.transport;
    this.transport = undefined;
    if (transport) {
      try {
        await this.withTimeout(
          transport.close(),
          this.finishTimeoutMs,
          'fun_asr_transport_closed',
        );
      } catch {
        // Closing is best-effort after all callbacks have been detached.
      }
    }
  }

  private releaseGuard(): void {
    if (!this.guardSlotHeld) return;
    this.options.usageGuard?.endSession(this.sessionId);
    this.guardSlotHeld = false;
  }

  private clearTranscriptState(): void {
    this.revisions.clear();
    this.finalized.clear();
    this.finalBuffer.clear();
  }

  private wasCancelledOrDisposed(): boolean {
    return this.lifecycle === 'cancelled' || this.lifecycle === 'disposed';
  }

  private emitStatus(state: ServerRecognitionStatus['state']): void {
    this.statusCallback({
      sessionId: this.sessionId,
      state,
      queueLength: 0,
      model: FUN_ASR_REALTIME_MODEL,
      language: this.language,
    });
  }

  private async withTimeout(promise: Promise<void>, milliseconds: number, code: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_resolve, reject) => {
      timer = this.setTimer(() => {
        if (timer !== undefined) this.pendingTimeouts.delete(timer);
        reject(providerError(code));
      }, milliseconds);
      this.pendingTimeouts.set(timer, reject);
    });
    try {
      await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) {
        this.pendingTimeouts.delete(timer);
        this.clearTimer(timer);
      }
    }
  }

  private rejectPendingTimeouts(error: ServerProviderError): void {
    for (const [timer, reject] of this.pendingTimeouts) {
      this.clearTimer(timer);
      reject(error);
    }
    this.pendingTimeouts.clear();
  }
}

function validateAudioChunk(chunk: SttAudioChunk): number {
  if (chunk.audio.byteLength > MAX_AUDIO_CHUNK_BYTES) throw providerError('fun_asr_audio_chunk_too_large');
  if (chunk.audio.byteLength % 2 !== 0) throw providerError('fun_asr_pcm_invalid');
  if (!chunk.metadata) throw providerError('fun_asr_audio_format_unsupported');
  if (
    chunk.metadata.sampleRate !== FUN_ASR_SAMPLE_RATE
    || chunk.metadata.channels !== 1
    || chunk.metadata.encoding !== 'pcm_s16le'
    || chunk.metadata.frameCount !== chunk.audio.byteLength / 2
  ) {
    throw providerError('fun_asr_audio_format_unsupported');
  }
  return chunk.metadata.frameCount;
}

function assertSessionFormat(config: SttSessionConfig): void {
  if (!config.sessionId || (config.language !== 'ja' && config.language !== 'en')) {
    throw providerError('fun_asr_audio_format_unsupported');
  }
  if (config.mimeType.trim().toLowerCase() !== PCM_MIME_TYPE || (config.sampleRate !== undefined && config.sampleRate !== FUN_ASR_SAMPLE_RATE)) {
    throw providerError('fun_asr_audio_format_unsupported');
  }
}

function createDeferred(): Deferred {
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: ServerProviderError) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function normalizeProviderError(error: unknown, fallbackCode: string): ServerProviderError {
  return error instanceof ServerProviderError ? error : providerError(fallbackCode);
}

function normalizeSendError(error: unknown): ServerProviderError {
  if (error instanceof ServerProviderError && error.code.startsWith('fun_asr_transport_')) return error;
  return providerError('fun_asr_transport_closed');
}

function providerError(code: string): ServerProviderError {
  const messages: Record<string, string> = {
    external_stt_disabled: '外部STTは無効です。',
    fun_asr_live_transport_unavailable: 'Fun-ASRの実通信Transportはまだ利用できません。',
    fun_asr_model_unsupported: 'Fun-ASRで未対応のモデルです。',
    fun_asr_usage_limits_required: 'Fun-ASRの利用上限が設定されていません。',
    fun_asr_usage_limit_exceeded: 'Fun-ASRの音声利用上限に達しました。',
    fun_asr_audio_format_unsupported: 'Fun-ASRで未対応の音声形式です。',
    fun_asr_pcm_invalid: 'Fun-ASRへ渡すPCM音声が不正です。',
    fun_asr_audio_chunk_too_large: 'Fun-ASRへ渡す音声チャンクが大きすぎます。',
    fun_asr_audio_sequence_invalid: 'Fun-ASRへ渡す音声順序が不正です。',
    fun_asr_protocol_invalid: 'Fun-ASRから不正な応答を受信しました。',
    fun_asr_start_timeout: 'Fun-ASRの開始確認がタイムアウトしました。',
    fun_asr_finish_timeout: 'Fun-ASRの終了確認がタイムアウトしました。',
    fun_asr_transport_closed: 'Fun-ASRの通信が終了しました。',
    fun_asr_task_failed: 'Fun-ASRの文字起こし処理に失敗しました。',
    fun_asr_session_inactive: 'Fun-ASRセッションは利用できません。',
    fun_asr_final_sequence_gap: 'Fun-ASRの確定結果に欠番がありました。',
    fun_asr_final_buffer_limit: 'Fun-ASRの確定結果待機上限に達しました。',
    fun_asr_result_limit: 'Fun-ASRのセッション結果数上限に達しました。',
  };
  return new ServerProviderError(code, false, messages[code] ?? 'Fun-ASR処理に失敗しました。');
}
