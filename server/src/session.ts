import {
  ProtocolValidationError,
  decodeAudioFrame,
  parseClientControlMessage,
  type ServerMessage,
} from '../../shared/protocol.js';
import { ServerProviderError, type SttProvider } from './providers/types.js';
import { TranscriptionSessionRegistry } from './sessionRegistry.js';

export interface SessionLimits {
  connectionTimeoutMs: number;
  audioIdleTimeoutMs: number;
  sessionResumeTtlMs?: number;
  maxSessions?: number;
}

let nextConnectionId = 1;

export class TranscriptionWebSocketSession {
  private readonly connectionId = nextConnectionId++;
  private readonly registry: TranscriptionSessionRegistry;
  private readonly ownsRegistry: boolean;
  private sessionId: string | null = null;
  private started = false;
  private closed = false;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    provider: SttProvider,
    private readonly limits: SessionLimits,
    private readonly send: (message: ServerMessage) => void,
    private readonly terminate: () => void,
    registry?: TranscriptionSessionRegistry,
  ) {
    this.ownsRegistry = registry === undefined;
    this.registry = registry ?? new TranscriptionSessionRegistry(
      () => provider,
      { resumeTtlMs: limits.sessionResumeTtlMs ?? 1, maxSessions: limits.maxSessions ?? 1 },
    );
    this.startTimer = setTimeout(() => {
      this.sendError('start_timeout', '音声認識セッションの開始がタイムアウトしました。', true);
      this.terminate();
    }, limits.connectionTimeoutMs);
  }

  async handleText(text: string): Promise<void> {
    if (this.closed) return;
    try {
      const message = parseClientControlMessage(text);
      if (message.type === 'start') {
        if (this.started) throw new ProtocolValidationError('session_already_started', 'この接続は開始済みです。');
        this.sessionId = message.sessionId;
        await this.registry.start(this.connectionId, message, this.send);
        this.started = true;
        clearTimeout(this.startTimer);
        this.send({ type: 'ready', sessionId: message.sessionId });
        this.resetIdleTimer();
        return;
      }
      if (message.type === 'resume') {
        if (this.started) throw new ProtocolValidationError('session_already_started', 'この接続は開始済みです。');
        this.sessionId = message.sessionId;
        const lastReceivedSequence = this.registry.resume(this.connectionId, message, this.send);
        this.started = true;
        clearTimeout(this.startTimer);
        this.send({ type: 'resumed', sessionId: message.sessionId, lastReceivedSequence });
        this.registry.flushPending(this.connectionId, message.sessionId);
        this.resetIdleTimer();
        return;
      }

      if (message.type === 'ping') {
        this.assertActiveSession(message.sessionId);
        this.resetIdleTimer();
        this.send({ type: 'pong', sessionId: message.sessionId });
        return;
      }

      this.assertActiveSession(message.sessionId);
      if (message.type === 'cancel') {
        clearTimeout(this.idleTimer);
        await this.registry.cancel(this.connectionId, message.sessionId);
        this.started = false;
        this.closed = true;
        return;
      }
      clearTimeout(this.idleTimer);
      await this.registry.stop(this.connectionId, message.sessionId);
      this.started = false;
      this.closed = true;
    } catch (error) {
      this.handleError(error);
    }
  }

  async handleBinary(data: Uint8Array): Promise<void> {
    if (this.closed) return;
    try {
      const frame = decodeAudioFrame(data);
      this.assertActiveSession(frame.sessionId);
      this.resetIdleTimer();
      await this.registry.acceptAudio(this.connectionId, frame.sessionId, frame.sequence, frame.audio, frame.metadata);
    } catch (error) {
      this.handleError(error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startTimer);
    clearTimeout(this.idleTimer);
    if (this.ownsRegistry) await this.registry.closeAll();
    else this.registry.detach(this.connectionId, this.sessionId);
  }

  private assertActiveSession(sessionId: string): void {
    if (!this.started || !this.sessionId) {
      throw new ProtocolValidationError('session_not_started', 'セッションが開始されていません。');
    }
    if (sessionId !== this.sessionId) {
      throw new ProtocolValidationError('stale_session', '古い、または不一致のセッションです。');
    }
  }

  private resetIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.sendError('audio_timeout', '一定時間音声を受信していません。再接続できます。', true);
      this.terminate();
    }, this.limits.audioIdleTimeoutMs);
  }

  private handleError(error: unknown): void {
    if (error instanceof ProtocolValidationError) {
      this.sendError(error.code, error.message, false);
      return;
    }
    if (error instanceof ServerProviderError) {
      this.sendError(error.code, error.safeMessage, error.retryable);
      return;
    }
    this.sendError('internal_error', '音声認識サーバーで処理に失敗しました。', true);
  }

  private sendError(code: string, message: string, retryable: boolean): void {
    if (this.closed) return;
    this.send({ type: 'error', sessionId: this.sessionId ?? undefined, code, message, retryable });
  }
}
