import { SONIX_PROCESSING_LIMIT_MS, SONIX_RECORDING_LIMIT_MS } from '../../../../shared/sonix.js';
import type { ServerConfig } from '../../config.js';
import { GROQ_PCM_MIME_TYPE } from '../groq/groqWhisperServerProvider.js';
import { createPcm16MonoWav, GROQ_PCM_SAMPLE_RATE } from '../groq/pcmToWav.js';
import { assertExternalSttMayStart } from '../externalAccessPolicy.js';
import { ServerProviderError, type ServerRecognitionStatus, type SttAudioChunk, type SttProvider, type SttSessionConfig, type SttTranscriptResult } from '../types.js';
import { sonixError, transcribeWithSonix } from './sonixClient.js';

const MAX_PCM_BYTES = (SONIX_RECORDING_LIMIT_MS / 1_000 + 30) * GROQ_PCM_SAMPLE_RATE * 2;

export function createSonixProviderFactory(config: ServerConfig, fetcher: typeof fetch = fetch): () => SttProvider {
  let active = false;
  return () => new SonixProvider(config, fetcher, () => {
    if (active) throw new ServerProviderError('sonix_busy', false, 'Sonixは別の録音を処理中です。');
    active = true;
    return () => { active = false; };
  });
}

class SonixProvider implements SttProvider {
  readonly id = 'sonix';
  private session?: SttSessionConfig;
  private release?: () => void;
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private capturedAt?: number;
  private controller?: AbortController;
  private transcript?: (result: SttTranscriptResult) => void;
  private status?: (status: ServerRecognitionStatus) => void;
  private error?: (error: ServerProviderError) => void;

  constructor(private readonly config: ServerConfig, private readonly fetcher: typeof fetch, private readonly acquire: () => () => void) {}

  async startSession(session: SttSessionConfig): Promise<void> {
    assertExternalSttMayStart({ externalEnabled: this.config.externalEnabled, apiKey: this.config.sonixApiKey });
    if (session.mimeType !== GROQ_PCM_MIME_TYPE) throw invalidAudio();
    this.release = this.acquire();
    this.session = session;
  }

  async sendAudio({ sessionId, audio, metadata }: SttAudioChunk): Promise<void> {
    if (this.session?.sessionId !== sessionId || this.controller || !metadata
      || metadata.sampleRate !== GROQ_PCM_SAMPLE_RATE || metadata.channels !== 1
      || metadata.encoding !== 'pcm_s16le' || audio.byteLength !== metadata.frameCount * 2) throw invalidAudio();
    if (this.byteLength + audio.byteLength > MAX_PCM_BYTES) {
      throw new ServerProviderError('sonix_audio_limit', false, 'Sonixの録音時間上限に達しました。');
    }
    this.capturedAt ??= metadata.capturedAt;
    this.chunks.push(audio);
    this.byteLength += audio.byteLength;
  }

  async stopSession(sessionId: string): Promise<void> {
    const { session, capturedAt } = this;
    const key = this.config.sonixApiKey;
    if (session?.sessionId !== sessionId || capturedAt === undefined || !key || this.controller) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SONIX_PROCESSING_LIMIT_MS)]);
    this.controller = controller;
    try {
      this.status?.({ sessionId, state: 'recognizing', queueLength: 0, language: session.language, model: this.id });
      const wav = new Blob([new Uint8Array(createPcm16MonoWav(Buffer.concat(this.chunks, this.byteLength)))], { type: 'audio/wav' });
      this.chunks = [];
      const turns = await transcribeWithSonix(this.fetcher, key, wav, session.language, signal);
      if (signal.aborted) return;
      for (const [index, turn] of turns.entries()) {
        this.transcript?.({
          sessionId, segmentId: `sonix-${index + 1}`, revision: 1, isFinal: true, language: session.language,
          text: turn.text, speakerLabel: turn.speakerLabel, provider: this.id,
          startTime: capturedAt + turn.startTimeMs, endTime: capturedAt + turn.endTimeMs,
        });
      }
      this.status?.({ sessionId, state: 'completed', queueLength: 0, language: session.language, model: this.id });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.error?.(error instanceof ServerProviderError ? error : signal.aborted
          ? new ServerProviderError('sonix_timeout', false, 'Sonixの文字起こしが時間内に完了しませんでした。')
          : sonixError());
      }
    }
  }

  async dispose(): Promise<void> {
    this.controller?.abort();
    this.session = undefined;
    this.chunks = [];
    this.byteLength = 0;
    this.release?.();
    this.release = undefined;
  }

  onTranscript(callback: (result: SttTranscriptResult) => void): void { this.transcript = callback; }
  onStatus(callback: (status: ServerRecognitionStatus) => void): void { this.status = callback; }
  onError(callback: (error: ServerProviderError) => void): void { this.error = callback; }
}

function invalidAudio(): ServerProviderError {
  return new ServerProviderError('sonix_audio_format', false, 'Sonixの録音形式を確認してください。');
}
