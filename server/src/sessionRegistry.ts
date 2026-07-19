import type { AudioFrameMetadata, ClientControlMessage, ServerMessage, ServerProviderRequest, WireLanguage } from '../../shared/protocol.js';
import { ProtocolValidationError } from '../../shared/protocol.js';
import type { SttProvider } from './providers/types.js';

interface ActiveSession {
  sessionId: string;
  language: WireLanguage;
  audioFormat: string;
  providerRequest?: ServerProviderRequest;
  provider: SttProvider;
  lastReceivedSequence: number;
  connectionId: number | null;
  send: ((message: ServerMessage) => void) | null;
  stopped: boolean;
  pendingMessages: ServerMessage[];
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface SessionRegistryOptions {
  resumeTtlMs: number;
  maxSessions: number;
}

export class TranscriptionSessionRegistry {
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(
    private readonly providerFactory: (requestedProvider?: ServerProviderRequest) => SttProvider,
    private readonly options: SessionRegistryOptions,
  ) {}

  async start(
    connectionId: number,
    message: Extract<ClientControlMessage, { type: 'start' }>,
    send: (message: ServerMessage) => void,
  ): Promise<number> {
    const existing = this.sessions.get(message.sessionId);
    if (existing) {
      throw new ProtocolValidationError(
        existing.stopped ? 'session_stopped' : 'session_already_started',
        existing.stopped ? '停止済みセッションは再開できません。' : '同じsessionIdのセッションが既に存在します。',
      );
    }
    if (this.sessions.size >= this.options.maxSessions) {
      throw new ProtocolValidationError('session_limit', '同時セッション数の上限に達しています。');
    }

    const provider = this.providerFactory(message.provider);
    const session: ActiveSession = {
      sessionId: message.sessionId,
      language: message.language,
      audioFormat: message.audioFormat,
      providerRequest: message.provider,
      provider,
      lastReceivedSequence: -1,
      connectionId,
      send,
      stopped: false,
      pendingMessages: [],
    };
    this.bindProvider(session);
    try {
      await provider.startSession({
        sessionId: message.sessionId,
        language: message.language,
        mimeType: message.audioFormat,
      });
    } catch (error) {
      await provider.dispose();
      throw error;
    }
    this.sessions.set(message.sessionId, session);
    return session.lastReceivedSequence;
  }

  resume(
    connectionId: number,
    message: Extract<ClientControlMessage, { type: 'resume' }>,
    send: (message: ServerMessage) => void,
  ): number {
    const session = this.requireSession(message.sessionId);
    if (session.stopped) {
      throw new ProtocolValidationError('session_stopped', '停止済みセッションは再開できません。');
    }
    if (session.language !== message.language || session.audioFormat !== message.audioFormat
      || session.providerRequest !== message.provider) {
      throw new ProtocolValidationError('resume_mismatch', '再開時の言語または音声形式が開始時と一致しません。');
    }
    clearTimeout(session.cleanupTimer);
    session.connectionId = connectionId;
    session.send = send;
    return session.lastReceivedSequence;
  }

  flushPending(connectionId: number, sessionId: string): void {
    const session = this.requireAttachedSession(connectionId, sessionId);
    for (const message of session.pendingMessages.splice(0)) session.send?.(message);
  }

  async acceptAudio(
    connectionId: number,
    sessionId: string,
    sequence: number,
    audio: Uint8Array,
    metadata?: AudioFrameMetadata,
  ): Promise<void> {
    const session = this.requireAttachedSession(connectionId, sessionId);
    if (session.stopped) throw new ProtocolValidationError('session_stopped', '停止済みセッションです。');
    if (sequence <= session.lastReceivedSequence) {
      session.send?.({ type: 'audio_ack', sessionId, sequence });
      return;
    }
    const expectedSequence = session.lastReceivedSequence + 1;
    if (sequence !== expectedSequence) {
      throw new ProtocolValidationError('out_of_order_chunk', `音声チャンクの順序が不正です。expected=${expectedSequence}`);
    }

    await session.provider.sendAudio({ sessionId, sequence, audio, metadata });
    session.lastReceivedSequence = sequence;
    session.send?.({ type: 'audio_ack', sessionId, sequence });
  }

  async cancel(connectionId: number, sessionId: string): Promise<void> {
    const session = this.requireAttachedSession(connectionId, sessionId);
    if (session.stopped) return;
    await session.provider.cancelSession?.(sessionId);
    session.stopped = true;
    session.send?.({ type: 'stopped', sessionId });
    await session.provider.dispose();
    session.connectionId = null;
    session.send = null;
    this.scheduleCleanup(session);
  }

  async stop(connectionId: number, sessionId: string): Promise<void> {
    const session = this.requireAttachedSession(connectionId, sessionId);
    if (session.stopped) return;
    await session.provider.stopSession(sessionId);
    session.stopped = true;
    session.send?.({ type: 'stopped', sessionId });
    await session.provider.dispose();
    session.connectionId = null;
    session.send = null;
    this.scheduleCleanup(session);
  }

  detach(connectionId: number, sessionId: string | null): void {
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.connectionId !== connectionId) return;
    session.connectionId = null;
    session.send = null;
    this.scheduleCleanup(session);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async (session) => {
      clearTimeout(session.cleanupTimer);
      await session.provider.dispose();
    }));
  }

  private bindProvider(session: ActiveSession): void {
    session.provider.onTranscript((result) => {
      if (!session.stopped && result.sessionId === session.sessionId) {
        this.deliverOrBuffer(session, { type: 'transcript', ...result });
      }
    });
    session.provider.onError((error) => {
      this.deliverOrBuffer(session, {
        type: 'error',
        sessionId: session.sessionId,
        code: error.code,
        message: error.safeMessage,
        retryable: error.retryable,
      });
    });
    session.provider.onStatus?.((status) => {
      if (!session.stopped && status.sessionId === session.sessionId) {
        this.deliverOrBuffer(session, { type: 'recognition_status', ...status });
      }
    });
  }

  private deliverOrBuffer(session: ActiveSession, message: ServerMessage): void {
    if (session.send) {
      session.send(message);
      return;
    }
    if (session.pendingMessages.length >= 100) session.pendingMessages.shift();
    session.pendingMessages.push(message);
  }

  private requireSession(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProtocolValidationError('session_not_found', '再開対象のセッションが見つかりません。');
    return session;
  }

  private requireAttachedSession(connectionId: number, sessionId: string): ActiveSession {
    const session = this.requireSession(sessionId);
    if (session.connectionId !== connectionId) {
      throw new ProtocolValidationError('stale_connection', '古いWebSocket接続からのイベントを拒否しました。');
    }
    return session;
  }

  private scheduleCleanup(session: ActiveSession): void {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
      if (session.connectionId !== null) return;
      this.sessions.delete(session.sessionId);
      void session.provider.dispose().catch((error: unknown) => {
        console.error('[stt] detached provider cleanup failed', error);
      });
    }, this.options.resumeTtlMs);
  }
}
