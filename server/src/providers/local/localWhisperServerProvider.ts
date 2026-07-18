import type { AudioFrameMetadata, LocalWhisperErrorCode, WireLanguage } from '../../../../shared/protocol.js';
import type { ServerRecognitionStatus, ServerSpeechToTextProvider, ServerTranscriptResult } from '../types.js';
import { ServerProviderError } from '../types.js';
import { LocalSttError } from './localSttTypes.js';
import { LOCAL_WHISPER_MODEL_ID, LocalWhisperRuntime, type LocalWhisperJob, type LocalWhisperRecognitionResult } from './localWhisperRuntime.js';
import { DEFAULT_VAD_CONFIGURATION, PcmUtteranceSegmenter, type PcmUtterance, type VadConfiguration } from './pcmUtteranceSegmenter.js';

export const LOCAL_PCM_MIME_TYPE = 'audio/pcm;rate=16000;channels=1;format=s16le';

export interface LocalWhisperServerProviderOptions {
  vad: Partial<VadConfiguration>;
  onMetric?: (metric: LocalUtteranceMetrics) => void;
}

export interface LocalUtteranceMetrics {
  sessionId: string;
  utteranceId: string;
  sequenceStart: number;
  sequenceEnd: number;
  audioDurationMs: number;
  processingTimeMs?: number;
  realTimeFactor?: number;
  queueWaitTimeMs?: number;
  totalLatencyMs?: number;
  segmentCount?: number;
  processExitCode?: number;
  errorCode?: string;
  model: string;
  language: WireLanguage;
  threadCount: 4;
  createdAt: string;
  completedAt?: string;
}

export class LocalWhisperServerProvider implements ServerSpeechToTextProvider {
  readonly id = 'local-whisper';
  private sessionId = '';
  private language: WireLanguage = 'ja';
  private sessionStartedAt = 0;
  private segmenter?: PcmUtteranceSegmenter;
  private vadConfiguration: VadConfiguration = DEFAULT_VAD_CONFIGURATION;
  private active = false;
  private stopping = false;
  private utteranceSequence = 0;
  private transcriptCallback: (result: ServerTranscriptResult) => void = () => undefined;
  private errorCallback: (error: ServerProviderError) => void = () => undefined;
  private statusCallback: (status: ServerRecognitionStatus) => void = () => undefined;
  private readonly metrics: LocalUtteranceMetrics[] = [];

  constructor(
    private readonly runtime: LocalWhisperRuntime,
    private readonly options: LocalWhisperServerProviderOptions,
  ) {}

  async startSession(options: {
    sessionId: string;
    language: WireLanguage;
    mimeType: string;
    sampleRate?: number;
    hotwords?: string[];
  }): Promise<void> {
    if (options.language !== 'ja' && options.language !== 'en') throw providerError('local_language_unsupported');
    if (options.mimeType !== LOCAL_PCM_MIME_TYPE || (options.sampleRate !== undefined && options.sampleRate !== 16_000)) {
      throw providerError('local_audio_format_unsupported');
    }
    let segmenter: PcmUtteranceSegmenter;
    try {
      this.vadConfiguration = {
        ...DEFAULT_VAD_CONFIGURATION, ...this.options.vad, sampleRate: 16_000,
      };
      segmenter = new PcmUtteranceSegmenter(this.vadConfiguration);
      await this.runtime.registerSession(options.sessionId);
    } catch (error) {
      if (error instanceof LocalSttError) throw mapRuntimeError(error);
      throw providerError('local_vad_configuration_invalid');
    }
    this.sessionId = options.sessionId;
    this.language = options.language;
    this.sessionStartedAt = Date.now();
    this.utteranceSequence = 0;
    this.metrics.length = 0;
    this.segmenter = segmenter;
    this.active = true;
    this.stopping = false;
    this.emitStatus('listening');
  }

  async sendAudio(options: {
    sessionId: string;
    sequence: number;
    audio: Uint8Array;
    metadata?: AudioFrameMetadata;
  }): Promise<void> {
    if (!this.active || this.stopping || options.sessionId !== this.sessionId || !this.segmenter) {
      throw providerError('local_session_inactive');
    }
    validatePcmMetadata(options.metadata, options.audio.byteLength);
    const snapshot = this.segmenter.snapshot();
    try {
      const utterances = this.segmenter.accept(options.sequence, options.audio);
      this.enqueueUtterances(utterances);
      this.emitStatus('listening');
    } catch (error) {
      this.segmenter.restore(snapshot);
      if (error instanceof LocalSttError) throw mapRuntimeError(error);
      throw providerError('local_pcm_invalid');
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    if (!this.active || sessionId !== this.sessionId) return;
    this.stopping = true;
    if (this.segmenter) this.enqueueUtterances(this.segmenter.flush());
    await this.runtime.waitForSession(sessionId);
    this.active = false;
    this.stopping = false;
  }

  async cancelSession(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId) return;
    this.runtime.cancelSession(sessionId);
    this.active = false;
    this.stopping = false;
  }

  async closeSession(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId) return;
    if (this.active && !this.stopping) this.runtime.cancelSession(sessionId);
    this.runtime.unregisterSession(sessionId);
    this.active = false;
    this.stopping = false;
  }

  onTranscript(callback: (result: ServerTranscriptResult) => void): void {
    this.transcriptCallback = callback;
  }

  onError(callback: (error: ServerProviderError) => void): void {
    this.errorCallback = callback;
  }

  onStatus(callback: (status: ServerRecognitionStatus) => void): void {
    this.statusCallback = callback;
  }

  getMetricsSnapshot(): readonly LocalUtteranceMetrics[] {
    return this.metrics.map((item) => ({ ...item }));
  }

  private enqueueUtterances(utterances: readonly PcmUtterance[]): void {
    if (utterances.length === 0) return;
    const jobs = utterances.map((utterance) => this.createJob(utterance));
    try {
      this.runtime.enqueueMany(jobs);
    } catch (error) {
      throw mapRuntimeError(error);
    }
    this.emitStatus('queued', jobs[0]?.utteranceId);
  }

  private createJob(utterance: PcmUtterance): LocalWhisperJob {
    const utteranceId = `${this.sessionId}:utterance-${String(++this.utteranceSequence).padStart(4, '0')}`;
    const createdAt = Date.now();
    const metric: LocalUtteranceMetrics = {
      sessionId: this.sessionId, utteranceId, sequenceStart: utterance.sequenceStart,
      sequenceEnd: utterance.sequenceEnd, audioDurationMs: utterance.audioDurationMs,
      model: LOCAL_WHISPER_MODEL_ID, language: this.language, threadCount: 4,
      createdAt: new Date(createdAt).toISOString(),
    };
    this.metrics.push(metric);
    return {
      sessionId: this.sessionId,
      utteranceId,
      language: this.language,
      utterance,
      vadConfiguration: this.vadConfiguration,
      createdAt,
      onStarted: (queueLength, queueWaitTimeMs) => {
        metric.queueWaitTimeMs = queueWaitTimeMs;
        this.emitStatus('recognizing', utteranceId, { queueLength, audioDurationMs: utterance.audioDurationMs });
      },
      onCompleted: (result) => this.completeUtterance(utteranceId, utterance, metric, result),
      onError: (error) => {
        metric.errorCode = error.code;
        metric.completedAt = new Date().toISOString();
        this.options.onMetric?.({ ...metric });
        this.errorCallback(mapRuntimeError(error));
      },
    };
  }

  private completeUtterance(
    utteranceId: string,
    utterance: PcmUtterance,
    metric: LocalUtteranceMetrics,
    result: LocalWhisperRecognitionResult,
  ): void {
    metric.processingTimeMs = result.processingTimeMs;
    metric.realTimeFactor = result.realTimeFactor;
    metric.queueWaitTimeMs = result.queueWaitTimeMs;
    metric.totalLatencyMs = result.totalLatencyMs;
    metric.segmentCount = result.segments.length;
    metric.processExitCode = result.processExitCode;
    metric.completedAt = new Date(result.completedAt).toISOString();
    this.options.onMetric?.({ ...metric });
    const startTime = this.sessionStartedAt + utterance.startFrame / 16_000 * 1_000;
    const endTime = this.sessionStartedAt + utterance.endFrame / 16_000 * 1_000;
    if (result.transcript) {
      this.transcriptCallback({
        sessionId: this.sessionId,
        segmentId: utteranceId,
        utteranceId,
        revision: 0,
        text: result.transcript,
        isFinal: true,
        language: this.language,
        startTime,
        endTime,
        provider: this.id,
        model: LOCAL_WHISPER_MODEL_ID,
        processingTimeMs: result.processingTimeMs,
        audioDurationMs: result.audioDurationMs,
        realTimeFactor: result.realTimeFactor,
        segments: result.segments.map((segment) => ({
          startTimeMs: segment.startMs,
          endTimeMs: segment.endMs,
          text: segment.text,
        })),
      });
    }
    this.emitStatus('completed', utteranceId, {
      queueLength: this.runtime.queueLength,
      audioDurationMs: result.audioDurationMs,
      processingTimeMs: result.processingTimeMs,
      realTimeFactor: result.realTimeFactor,
    });
  }

  private emitStatus(
    state: ServerRecognitionStatus['state'],
    utteranceId?: string,
    values: Partial<Pick<ServerRecognitionStatus, 'queueLength' | 'audioDurationMs' | 'processingTimeMs' | 'realTimeFactor'>> = {},
  ): void {
    this.statusCallback({
      sessionId: this.sessionId,
      state,
      queueLength: values.queueLength ?? this.runtime.queueLength,
      model: LOCAL_WHISPER_MODEL_ID,
      language: this.language,
      utteranceId,
      audioDurationMs: values.audioDurationMs,
      processingTimeMs: values.processingTimeMs,
      realTimeFactor: values.realTimeFactor,
    });
  }
}

function validatePcmMetadata(metadata: AudioFrameMetadata | undefined, byteLength: number): void {
  if (!metadata || metadata.sampleRate !== 16_000 || metadata.channels !== 1 || metadata.encoding !== 'pcm_s16le'
    || metadata.frameCount <= 0 || metadata.frameCount * 2 !== byteLength || byteLength % 2 !== 0) {
    throw providerError('local_pcm_invalid');
  }
}

function mapRuntimeError(error: unknown): ServerProviderError {
  const code = error instanceof LocalSttError && isLocalWhisperErrorCode(error.code)
    ? error.code
    : 'local_recognition_failed';
  return providerError(code);
}

function providerError(code: LocalWhisperErrorCode): ServerProviderError {
  const messages: Record<string, string> = {
    local_model_unsupported: 'The configured Local Whisper model is not supported.',
    local_vad_configuration_invalid: 'The Local Whisper voice detection configuration is invalid.',
    local_process_cancelled: 'Local Whisper recognition was cancelled.',
    local_stt_disabled: 'Local Whisperはサーバー設定で無効です。',
    local_model_missing: 'Local Whisperモデルが見つかりません。',
    local_model_hash_mismatch: 'Local Whisperモデルの整合性を確認できません。',
    local_executable_missing: 'whisper.cpp実行ファイルが見つかりません。',
    local_executable_hash_mismatch: 'whisper.cpp実行ファイルの整合性を確認できません。',
    local_audio_format_unsupported: 'Local Whisperには16 kHz mono PCM16音声が必要です。',
    local_pcm_invalid: '受信したPCM音声が不正です。',
    local_process_timeout: 'Local Whisperの認識がタイムアウトしました。',
    local_process_start_failed: 'Local Whisperを開始できませんでした。',
    local_process_failed: 'Local Whisperが異常終了しました。',
    local_timestamp_parse_failed: 'Local Whisperのタイムスタンプを解析できませんでした。',
    local_queue_limit: 'Local Whisperの認識待ち上限に達しました。',
    local_session_limit: 'Local Whisperの同時セッション上限に達しました。',
    local_temp_cleanup_failed: 'Local Whisperの一時音声を安全に削除できませんでした。',
    local_session_inactive: 'Local Whisperセッションは終了しています。',
    local_language_unsupported: '指定された認識言語には対応していません。',
  };
  const retryable = ['local_process_timeout', 'local_process_start_failed', 'local_process_failed', 'local_queue_limit'].includes(code);
  return new ServerProviderError(code, retryable, messages[code] ?? 'Local Whisperの音声認識に失敗しました。');
}

function isLocalWhisperErrorCode(code: string): code is LocalWhisperErrorCode {
  return [
    'local_stt_disabled', 'local_model_missing', 'local_model_hash_mismatch',
    'local_model_unsupported', 'local_executable_missing', 'local_executable_hash_mismatch',
    'local_audio_format_unsupported', 'local_pcm_invalid', 'local_language_unsupported',
    'local_threads_invalid', 'local_vad_configuration_invalid', 'local_queue_limit',
    'local_session_limit', 'local_session_inactive', 'local_runtime_closed',
    'local_process_start_failed', 'local_process_timeout', 'local_process_failed',
    'local_process_cancelled', 'local_output_limit', 'local_timestamp_parse_failed',
    'local_temp_cleanup_failed', 'local_recognition_failed',
  ].includes(code);
}
