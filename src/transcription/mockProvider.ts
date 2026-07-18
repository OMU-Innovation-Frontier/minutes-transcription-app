import type { AudioChunk } from '../audio/types';
import type {
  SpeechToTextCallbacks,
  SpeechToTextProvider,
  StartTranscriptionOptions,
  TranscriptUpdate,
  TranscriptionLanguage,
} from './types';

const PHRASES: Record<TranscriptionLanguage, readonly (readonly string[])[]> = {
  'ja-JP': [
    ['マイク音声を', 'リアルタイムで', '文字起こししています。'],
    ['暫定結果は', '確定すると', '履歴に追加されます。'],
  ],
  'en-US': [
    ['Microphone audio', 'is being transcribed', 'in real time.'],
    ['Interim text', 'moves into', 'the final transcript.'],
  ],
};

export class MockSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'mock';
  readonly label = 'モック認識';
  readonly isMock = true;

  private callbacks: SpeechToTextCallbacks = {};
  private sessionId = '';
  private language: TranscriptionLanguage = 'ja-JP';
  private phraseIndex = 0;
  private tokenIndex = 0;
  private sequence = 0;
  private revision = 0;
  private currentText = '';
  private currentStartTime: number | undefined;
  private active = false;

  isSupported(): boolean {
    return true;
  }

  async start(options: StartTranscriptionOptions): Promise<void> {
    this.callbacks = options.callbacks ?? {};
    this.sessionId = options.sessionId;
    this.language = options.language;
    this.phraseIndex = 0;
    this.tokenIndex = 0;
    this.sequence = 0;
    this.revision = 0;
    this.currentText = '';
    this.currentStartTime = undefined;
    this.active = true;
    this.callbacks.onStateChange?.('connecting');
    await Promise.resolve();
    this.callbacks.onStateChange?.('transcribing');
  }

  acceptChunk(chunk: AudioChunk): void {
    void chunk;
    if (!this.active) return;

    const phrases = PHRASES[this.language];
    const phrase = phrases[this.phraseIndex % phrases.length];
    if (!phrase) return;
    const token = phrase[this.tokenIndex];
    if (!token) return;

    this.currentStartTime ??= chunk.capturedAt;
    this.currentText = [this.currentText, token].filter(Boolean).join(' ');
    const isFinal = this.tokenIndex === phrase.length - 1;
    this.emit(this.currentText, isFinal, chunk.capturedAt);

    if (isFinal) {
      this.phraseIndex += 1;
      this.tokenIndex = 0;
      this.revision = 0;
      this.currentText = '';
      this.currentStartTime = undefined;
    } else {
      this.tokenIndex += 1;
      this.revision += 1;
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.callbacks.onStateChange?.('degraded');
    if (this.currentText) this.emit(this.currentText, true, Date.now());
    this.active = false;
    this.currentText = '';
    this.currentStartTime = undefined;
    this.callbacks.onStateChange?.('disconnected');
  }

  async abort(): Promise<void> {
    this.active = false;
    this.currentText = '';
    this.currentStartTime = undefined;
    this.callbacks.onStateChange?.('disconnected');
  }

  private emit(text: string, isFinal: boolean, eventTime: number): void {
    const update: TranscriptUpdate = {
      sessionId: this.sessionId,
      segmentId: `mock-${this.phraseIndex}`,
      sequence: this.sequence++,
      revision: this.revision,
      text,
      isFinal,
      language: this.language,
      provider: this.id,
      startTime: this.currentStartTime ?? eventTime,
      endTime: isFinal ? eventTime : undefined,
      confidence: isFinal ? 0.99 : undefined,
      createdAt: new Date().toISOString(),
    };
    this.callbacks.onTranscript?.(update);
  }
}
