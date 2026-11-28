import { MEETING_RECORDING_LIMIT_MS } from '../../../../shared/sonix.js';
import { GROQ_PCM_MIME_TYPE } from '../groq/groqWhisperServerProvider.js';
import { assertExternalSttMayStart } from '../externalAccessPolicy.js';
import { ServerProviderError, type SttAudioChunk, type SttProvider, type SttSessionConfig, type SttTranscriptResult } from '../types.js';
import { SonioxTranscript, parseSonioxResult, sonioxError } from './sonioxTranscript.js';

export const SONIOX_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';
const MODEL = 'stt-rt-v6';
const MAX_AUDIO_BYTES = MEETING_RECORDING_LIMIT_MS / 1_000 * 32_000;

export interface SonioxSocket {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(): void;
  listen(onMessage: (data: unknown) => void, onEnd: (code?: number) => void): void;
}

export type ConnectSoniox = (apiKey: string) => Promise<SonioxSocket>;

export class SonioxProvider implements SttProvider {
  readonly id = 'soniox';
  private sessionId?: string;
  private socket?: SonioxSocket;
  private stopPromise?: Promise<void>;
  private finish?: () => void;
  private bytes = 0;
  private lastAudioAt = Date.now();
  private keepalive?: ReturnType<typeof setInterval>;
  private transcript?: (result: SttTranscriptResult) => void;
  private onFailure?: (error: ServerProviderError) => void;
  private failure?: ServerProviderError;
  private results?: SonioxTranscript;

  constructor(
    private readonly config: { externalEnabled: boolean; apiKey?: string },
    private readonly connect: ConnectSoniox,
  ) {}

  async startSession(config: SttSessionConfig): Promise<void> {
    const { apiKey } = this.config;
    assertExternalSttMayStart(this.config);
    if (!apiKey || config.mimeType !== GROQ_PCM_MIME_TYPE) throw sonioxError('format');
    try {
      const socket = await this.connect(apiKey);
      this.socket = socket;
      this.sessionId = config.sessionId;
      this.results = new SonioxTranscript(config.sessionId, config.language, MODEL, (result) => this.transcript?.(result));
      socket.listen((data) => this.receive(socket, data), (code) => {
        if (socket === this.socket) this.fail(this.closedError(code));
      });
      socket.send(JSON.stringify({
        model: MODEL, audio_format: 'pcm_s16le', sample_rate: 16_000, num_channels: 1,
        language_hints: [config.language], enable_speaker_diarization: true,
      }));
      this.keepalive = setInterval(() => {
        if (socket === this.socket && !this.stopPromise && Date.now() - this.lastAudioAt >= 5_000) {
          try { socket.send('{"type":"keepalive"}'); } catch { this.fail(this.closedError()); }
        }
      }, 5_000);
    } catch (error) {
      const failure = error instanceof ServerProviderError ? error : sonioxError(this.socket ? 'start' : 'connect');
      this.closeSocket();
      throw failure;
    }
  }

  async sendAudio({ sessionId, audio, metadata }: SttAudioChunk): Promise<void> {
    const socket = this.socket;
    if (sessionId !== this.sessionId || !socket || this.stopPromise) throw this.failure ?? sonioxError('send_audio');
    if (!metadata || metadata.encoding !== 'pcm_s16le' || metadata.sampleRate !== 16_000 || metadata.channels !== 1
      || metadata.frameCount * 2 !== audio.byteLength || audio.byteLength === 0) throw sonioxError('format');
    if (this.bytes + audio.byteLength > MAX_AUDIO_BYTES) throw sonioxError('limit');
    if (socket.bufferedAmount + audio.byteLength > 2_000_000) throw sonioxError('send_audio');
    this.results?.setAudioStart(metadata.capturedAt - metadata.frameCount / 16);
    try { socket.send(audio); } catch { throw sonioxError('send_audio'); }
    this.lastAudioAt = Date.now();
    this.bytes += audio.byteLength;
  }

  async stopSession(sessionId: string): Promise<void> {
    if (sessionId !== this.sessionId || !this.socket) return;
    if (this.stopPromise) return this.stopPromise;
    const socket = this.socket;
    this.stopPromise = new Promise<void>((resolve) => { this.finish = resolve; });
    const timeout = setTimeout(() => this.fail(sonioxError('timeout')), 15_000);
    try {
      socket.send('');
      await this.stopPromise;
    } catch {
      this.fail(this.closedError());
    } finally {
      clearTimeout(timeout);
      this.closeSocket();
    }
  }

  async dispose(): Promise<void> {
    this.closeSocket();
    this.results = undefined;
  }

  onTranscript(callback: (result: SttTranscriptResult) => void): void { this.transcript = callback; }
  onError(callback: (error: ServerProviderError) => void): void { this.onFailure = callback; }

  private receive(socket: SonioxSocket, payload: unknown): void {
    if (socket !== this.socket) return;
    try {
      const result = parseSonioxResult(payload);
      if (!result) return;
      this.results?.apply(result.tokens, result.finished);
      if (result.finished) this.closeSocket();
    } catch (error) {
      this.fail(error instanceof ServerProviderError ? error : sonioxError('result'));
    }
  }

  private fail(error: ServerProviderError): void {
    this.failure = error;
    this.results?.apply([], true);
    this.onFailure?.(error);
    this.closeSocket();
  }

  private closedError(code?: number): ServerProviderError {
    if (this.stopPromise) return sonioxError('closed_before_finish', code);
    return sonioxError(this.bytes > 0 ? 'closed_during_audio' : 'closed_before_audio', code);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    clearInterval(this.keepalive);
    this.finish?.();
    this.finish = undefined;
    try { socket?.close(); } catch { /* The connection may have closed already. */ }
  }
}
