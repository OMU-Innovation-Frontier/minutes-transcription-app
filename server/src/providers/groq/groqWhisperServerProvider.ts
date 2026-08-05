import type { AudioFrameMetadata, WireLanguage } from '../../../../shared/protocol.js';
import { DEFAULT_VAD_CONFIGURATION, PcmUtteranceSegmenter, type PcmUtterance, type VadConfiguration } from '../local/pcmUtteranceSegmenter.js';
import type { ServerRecognitionStatus, SttProvider, SttTranscriptResult } from '../types.js';
import { ServerProviderError } from '../types.js';
import { GROQ_WHISPER_MODEL, groqError } from './groqWhisperClient.js';
import { GroqWhisperRuntime, type GroqWhisperJob } from './groqWhisperRuntime.js';

export const GROQ_PCM_MIME_TYPE = 'audio/pcm;rate=16000;channels=1;format=s16le';

export class GroqWhisperServerProvider implements SttProvider {
  readonly id = 'groq-whisper';
  private sessionId = '';
  private language: WireLanguage = 'ja';
  private sessionStartedAt = 0;
  private segmenter?: PcmUtteranceSegmenter;
  private active = false;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private generation = 0;
  private utteranceSequence = 0;
  private transcriptCallback: (result: SttTranscriptResult) => void = () => undefined;
  private errorCallback: (error: ServerProviderError) => void = () => undefined;
  private statusCallback: (status: ServerRecognitionStatus) => void = () => undefined;

  constructor(
    private readonly runtime: GroqWhisperRuntime,
    private readonly options: { vad: Partial<VadConfiguration>; stopTimeoutMs: number; now?: () => number },
  ) {}

  async startSession(options: { sessionId: string; language: WireLanguage; mimeType: string; sampleRate?: number }): Promise<void> {
    if (options.language !== 'ja' && options.language !== 'en') throw groqError('groq_language_unsupported', false);
    if (options.mimeType !== GROQ_PCM_MIME_TYPE || (options.sampleRate !== undefined && options.sampleRate !== 16_000)) {
      throw groqError('groq_audio_format_unsupported', false);
    }
    try {
      this.segmenter = new PcmUtteranceSegmenter({ ...DEFAULT_VAD_CONFIGURATION, ...this.options.vad, sampleRate: 16_000 });
      this.runtime.registerSession(options.sessionId);
    } catch (error) {
      if (error instanceof ServerProviderError) throw error;
      throw groqError('groq_vad_configuration_invalid', false);
    }
    this.sessionId = options.sessionId;
    this.language = options.language;
    this.sessionStartedAt = (this.options.now ?? Date.now)();
    this.utteranceSequence = 0;
    this.generation += 1;
    this.active = true;
    this.stopping = false;
    this.stopPromise = undefined;
    this.emitStatus('listening');
  }

  async sendAudio(options: { sessionId: string; sequence: number; audio: Uint8Array; metadata?: AudioFrameMetadata }): Promise<void> {
    if (!this.active || this.stopping || options.sessionId !== this.sessionId || !this.segmenter) {
      throw groqError('groq_session_inactive', false);
    }
    validateMetadata(options.metadata, options.audio.byteLength);
    const snapshot = this.segmenter.snapshot();
    try {
      this.enqueue(this.segmenter.accept(options.sequence, options.audio));
      this.emitStatus('listening');
    } catch (error) {
      this.segmenter.restore(snapshot);
      throw error instanceof ServerProviderError ? error : groqError('groq_pcm_invalid', false);
    }
  }

  stopSession(sessionId: string): Promise<void> {
    if (!this.active || sessionId !== this.sessionId) return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(sessionId);
    return this.stopPromise;
  }

  private async performStop(sessionId: string): Promise<void> {
    this.stopping = true;
    if (this.segmenter) this.enqueue(this.segmenter.flush());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.runtime.waitForSession(sessionId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(groqError('groq_stop_timeout', true)), this.options.stopTimeoutMs); }),
      ]);
    } catch (error) {
      this.runtime.cancelSession(sessionId);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.active = false;
      this.stopping = false;
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId) return;
    this.generation += 1;
    this.runtime.cancelSession(sessionId);
    this.active = false;
    this.stopping = false;
  }

  async dispose(): Promise<void> {
    if (!this.sessionId) return;
    this.generation += 1;
    if (this.active) this.runtime.cancelSession(this.sessionId);
    else this.runtime.unregisterSession(this.sessionId);
    this.active = false;
    this.stopping = false;
    this.segmenter = undefined;
  }

  onTranscript(callback: (result: SttTranscriptResult) => void): void { this.transcriptCallback = callback; }
  onError(callback: (error: ServerProviderError) => void): void { this.errorCallback = callback; }
  onStatus(callback: (status: ServerRecognitionStatus) => void): void { this.statusCallback = callback; }

  private enqueue(utterances: readonly PcmUtterance[]): void {
    if (!utterances.length) return;
    const jobs = utterances.map((utterance) => this.createJob(utterance));
    this.runtime.enqueueMany(jobs);
    this.emitStatus('queued', jobs[0]?.utteranceId);
  }

  private createJob(utterance: PcmUtterance): GroqWhisperJob {
    const generation = this.generation;
    const utteranceId = `${this.sessionId}:groq-${String(++this.utteranceSequence).padStart(4, '0')}`;
    return {
      sessionId: this.sessionId, utteranceId, language: this.language, utterance,
      createdAt: (this.options.now ?? Date.now)(), generation,
      onStarted: (queueLength) => this.emitIfCurrent(generation, () => this.emitStatus('recognizing', utteranceId, { queueLength, audioDurationMs: utterance.audioDurationMs })),
      onCompleted: (result) => this.emitIfCurrent(generation, () => {
        const startTime = this.sessionStartedAt + utterance.startFrame / 16_000 * 1_000;
        const endTime = this.sessionStartedAt + utterance.endFrame / 16_000 * 1_000;
        this.transcriptCallback({ sessionId: this.sessionId, segmentId: utteranceId, utteranceId, revision: 0,
          text: result.text, isFinal: true, language: this.language, startTime, endTime, provider: this.id,
          model: GROQ_WHISPER_MODEL, processingTimeMs: result.processingTimeMs,
          audioDurationMs: result.audioDurationMs, realTimeFactor: result.realTimeFactor });
        this.emitStatus('completed', utteranceId, result);
      }),
      onError: (error) => this.emitIfCurrent(generation, () => this.errorCallback(error)),
    };
  }

  private emitIfCurrent(generation: number, callback: () => void): void {
    if (generation === this.generation && (this.active || this.stopping)) callback();
  }

  private emitStatus(state: ServerRecognitionStatus['state'], utteranceId?: string,
    values: Partial<Pick<ServerRecognitionStatus, 'queueLength' | 'audioDurationMs' | 'processingTimeMs' | 'realTimeFactor'>> = {}): void {
    this.statusCallback({ sessionId: this.sessionId, state, queueLength: values.queueLength ?? this.runtime.queueLength,
      model: GROQ_WHISPER_MODEL, language: this.language, utteranceId, ...values });
  }
}

function validateMetadata(metadata: AudioFrameMetadata | undefined, byteLength: number): void {
  if (!metadata || metadata.sampleRate !== 16_000 || metadata.channels !== 1 || metadata.encoding !== 'pcm_s16le'
    || metadata.frameCount <= 0 || metadata.frameCount * 2 !== byteLength || byteLength % 2 !== 0) {
    throw groqError('groq_pcm_invalid', false);
  }
}
