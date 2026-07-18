import {
  ServerProviderError,
  type ServerSpeechToTextProvider,
  type ServerTranscriptResult,
} from './types.js';

export class UnavailableExternalSpeechToTextProvider implements ServerSpeechToTextProvider {
  readonly id: string;
  private readonly apiKey: string | undefined;
  private readonly externalEnabled: boolean;
  private transcriptCallback: (result: ServerTranscriptResult) => void = () => undefined;

  constructor(
    options: string | undefined | { apiKey?: string; externalEnabled: boolean },
    id = 'external',
  ) {
    this.id = id;
    this.apiKey = typeof options === 'object' ? options.apiKey : options;
    this.externalEnabled = typeof options === 'object' ? options.externalEnabled : true;
  }

  async startSession(options: {
    sessionId: string;
    language: 'ja' | 'en';
    mimeType: string;
    sampleRate?: number;
    hotwords?: string[];
  }): Promise<void> {
    void options;
    const error = this.id === 'browser-compatible'
      ? new ServerProviderError(
          'provider_not_configured',
          false,
          'browser-compatibleサーバープロバイダーは未構成です。ブラウザ認識はフロントエンドで選択してください。',
        )
      : !this.externalEnabled
      ? new ServerProviderError(
          'external_stt_disabled',
          false,
          '外部音声認識はサーバー設定で無効です。録音データは外部へ送信されていません。',
        )
      : this.apiKey
      ? new ServerProviderError(
          'provider_not_configured',
          false,
          '外部音声認識プロバイダーが設定されていません。',
        )
      : new ServerProviderError(
          'api_key_missing',
          false,
          '音声認識サービスのAPIキーがサーバーに設定されていません。',
        );
    throw error;
  }

  async sendAudio(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async closeSession(): Promise<void> {}

  onTranscript(callback: (result: ServerTranscriptResult) => void): void {
    this.transcriptCallback = callback;
    void this.transcriptCallback;
  }

  onError(callback: (error: ServerProviderError) => void): void {
    void callback;
  }
}
