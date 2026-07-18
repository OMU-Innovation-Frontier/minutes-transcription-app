import type { WireLanguage } from '../../../shared/protocol.js';
import type {
  ServerProviderError,
  ServerSpeechToTextProvider,
  ServerTranscriptResult,
} from './types.js';

const PHRASES: Record<WireLanguage, readonly (readonly string[])[]> = {
  ja: [
    ['これは', 'WebSocket音声認識の', 'サーバーモックです。'],
    ['音声チャンクを', '順番に受信して', '確定結果を返します。'],
  ],
  en: [
    ['This is', 'the WebSocket transcription', 'server mock.'],
    ['Audio chunks', 'arrive in order', 'and become final text.'],
  ],
};

export class MockServerSpeechToTextProvider implements ServerSpeechToTextProvider {
  readonly id = 'server-mock';
  private sessionId = '';
  private language: WireLanguage = 'ja';
  private phraseIndex = 0;
  private tokenIndex = 0;
  private revision = 0;
  private currentText = '';
  private startTime = 0;
  private active = false;
  private transcriptCallback: (result: ServerTranscriptResult) => void = () => undefined;
  private errorCallback: (error: ServerProviderError) => void = () => undefined;

  async startSession(options: {
    sessionId: string;
    language: WireLanguage;
    mimeType: string;
    sampleRate?: number;
    hotwords?: string[];
  }): Promise<void> {
    void options.mimeType;
    void options.sampleRate;
    void options.hotwords;
    this.sessionId = options.sessionId;
    this.language = options.language;
    this.phraseIndex = 0;
    this.tokenIndex = 0;
    this.revision = 0;
    this.currentText = '';
    this.startTime = 0;
    this.active = true;
  }

  async sendAudio(options: { sessionId: string; sequence: number; audio: Uint8Array }): Promise<void> {
    void options.sequence;
    void options.audio;
    const { sessionId } = options;
    if (!this.active || sessionId !== this.sessionId) return;
    const phrase = PHRASES[this.language][this.phraseIndex % PHRASES[this.language].length];
    const token = phrase?.[this.tokenIndex];
    if (!phrase || !token) return;

    const now = Date.now();
    if (this.startTime === 0) this.startTime = now;
    this.currentText = [this.currentText, token].filter(Boolean).join(' ');
    const isFinal = this.tokenIndex === phrase.length - 1;
    this.transcriptCallback({
      sessionId: this.sessionId,
      segmentId: `server-mock-${this.phraseIndex}`,
      revision: this.revision,
      text: this.currentText,
      isFinal,
      language: this.language,
      confidence: isFinal ? 0.99 : undefined,
      startTime: this.startTime,
      endTime: isFinal ? now : undefined,
    });

    if (isFinal) {
      this.phraseIndex += 1;
      this.tokenIndex = 0;
      this.revision = 0;
      this.currentText = '';
      this.startTime = 0;
    } else {
      this.tokenIndex += 1;
      this.revision += 1;
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    if (!this.active || sessionId !== this.sessionId) return;
    if (this.currentText) {
      this.transcriptCallback({
        sessionId: this.sessionId,
        segmentId: `server-mock-${this.phraseIndex}`,
        revision: this.revision,
        text: this.currentText,
        isFinal: true,
        language: this.language,
        confidence: 0.99,
        startTime: this.startTime,
        endTime: Date.now(),
      });
    }
    this.active = false;
    this.currentText = '';
  }

  async closeSession(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId) return;
    this.active = false;
    this.currentText = '';
  }

  onTranscript(callback: (result: ServerTranscriptResult) => void): void {
    this.transcriptCallback = callback;
  }

  onError(callback: (error: ServerProviderError) => void): void {
    this.errorCallback = callback;
    void this.errorCallback;
  }
}
