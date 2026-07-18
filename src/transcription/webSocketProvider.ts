import { encodeAudioFrame, parseServerMessage, ProtocolValidationError } from '../../shared/protocol';
import { PendingAudioQueue, type AudioBufferSnapshot } from '../audio/pendingAudioQueue';
import type { AudioChunk } from '../audio/types';
import type {
  SpeechToTextCallbacks,
  SpeechToTextProvider,
  StartTranscriptionOptions,
  TranscriptionError,
  TranscriptionLanguage,
  TranscriptionState,
} from './types';

interface WebSocketConnection {
  binaryType: BinaryType;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

interface NetworkEventSource {
  addEventListener(type: 'online' | 'offline', listener: EventListener): void;
  removeEventListener(type: 'online' | 'offline', listener: EventListener): void;
}

export interface WebSocketProviderDependencies {
  mode?: 'server-default' | 'local-whisper';
  url?: string;
  createWebSocket?: (url: string) => WebSocketConnection;
  setTimeout?: typeof window.setTimeout;
  clearTimeout?: typeof window.clearTimeout;
  random?: () => number;
  queue?: PendingAudioQueue;
  networkEvents?: NetworkEventSource;
  isOnline?: () => boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
  reconnectJitterRatio?: number;
  connectionTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxBufferedAmountBytes?: number;
  stopTimeoutMs?: number;
}

const OPEN = 1;
const STOP_TIMEOUT_MS = 3_000;
const BUFFER_POLL_MS = 25;

export class WebSocketSpeechToTextProvider implements SpeechToTextProvider {
  readonly id: 'websocket' | 'local-whisper';
  readonly label: string;
  readonly isMock = false;
  readonly audioCaptureMode;

  private readonly url: string;
  private readonly createWebSocket: ((url: string) => WebSocketConnection) | undefined;
  private readonly scheduleTimeout: typeof window.setTimeout;
  private readonly cancelTimeout: typeof window.clearTimeout;
  private readonly random: () => number;
  private readonly queue: PendingAudioQueue;
  private readonly networkEvents: NetworkEventSource;
  private readonly isOnline: () => boolean;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectJitterRatio: number;
  private readonly connectionTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxBufferedAmountBytes: number;
  private readonly stopTimeoutMs: number;
  private readonly requestedProvider: 'server-default' | 'local-whisper';
  private socket: WebSocketConnection | null = null;
  private callbacks: SpeechToTextCallbacks = {};
  private sessionId = '';
  private language: TranscriptionLanguage = 'ja-JP';
  private audioFormat = 'application/octet-stream';
  private generation = 0;
  private transcriptSequence = 0;
  private active = false;
  private stopRequested = false;
  private gracefulStopPending = false;
  private gracefulStopSending = false;
  private ready = false;
  private hasConnected = false;
  private terminalError = false;
  private reconnectAttempts = 0;
  private lastAcknowledgedSequence = -1;
  private state: TranscriptionState = 'disconnected';
  private flushing: Promise<void> | null = null;
  private flushRequested = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: TranscriptionError) => void) | null = null;
  private stopResolve: (() => void) | null = null;
  private connectionTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private heartbeatTimeoutTimer: number | undefined;
  private stopTimer: number | undefined;
  private networkListenersRegistered = false;
  private readonly acknowledgementListeners = new Set<() => void>();
  private readonly revisions = new Map<string, number>();
  private readonly finalSegments = new Set<string>();

  private readonly onlineListener: EventListener = () => this.handleOnline();
  private readonly offlineListener: EventListener = () => this.handleOffline();

  constructor(dependencies: WebSocketProviderDependencies = {}) {
    this.requestedProvider = dependencies.mode ?? 'server-default';
    this.id = this.requestedProvider === 'local-whisper' ? 'local-whisper' : 'websocket';
    this.label = this.requestedProvider === 'local-whisper' ? 'Local Whisper small' : 'WebSocketサーバー認識';
    this.audioCaptureMode = this.requestedProvider === 'local-whisper' ? 'pcm16-16khz' as const : 'media-recorder' as const;
    this.url = dependencies.url ?? import.meta.env.VITE_TRANSCRIPTION_WEBSOCKET_URL ?? 'ws://localhost:8787/transcription';
    this.createWebSocket = dependencies.createWebSocket ??
      (typeof WebSocket === 'undefined' ? undefined : (url) => new WebSocket(url));
    this.scheduleTimeout = dependencies.setTimeout ?? window.setTimeout.bind(window);
    this.cancelTimeout = dependencies.clearTimeout ?? window.clearTimeout.bind(window);
    this.random = dependencies.random ?? Math.random;
    this.networkEvents = dependencies.networkEvents ?? window;
    this.isOnline = dependencies.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine);
    this.reconnectBaseDelayMs = dependencies.reconnectBaseDelayMs ?? envNumber('VITE_WS_RECONNECT_BASE_MS', 500);
    this.reconnectMaxDelayMs = dependencies.reconnectMaxDelayMs ?? envNumber('VITE_WS_RECONNECT_MAX_MS', 10_000);
    this.reconnectMaxAttempts = dependencies.reconnectMaxAttempts ?? envNumber('VITE_WS_RECONNECT_MAX_ATTEMPTS', 8);
    this.reconnectJitterRatio = dependencies.reconnectJitterRatio ?? envNumber('VITE_WS_RECONNECT_JITTER_RATIO', 0.25);
    this.connectionTimeoutMs = dependencies.connectionTimeoutMs ?? envNumber('VITE_WS_CONNECTION_TIMEOUT_MS', 8_000);
    this.heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? envNumber('VITE_WS_HEARTBEAT_INTERVAL_MS', 5_000);
    this.heartbeatTimeoutMs = dependencies.heartbeatTimeoutMs ?? envNumber('VITE_WS_HEARTBEAT_TIMEOUT_MS', 10_000);
    this.maxBufferedAmountBytes = dependencies.maxBufferedAmountBytes ?? envNumber('VITE_WS_MAX_BUFFERED_AMOUNT_BYTES', 1_000_000);
    this.stopTimeoutMs = dependencies.stopTimeoutMs ?? (this.requestedProvider === 'local-whisper' ? 120_000 : STOP_TIMEOUT_MS);
    this.queue = dependencies.queue ?? new PendingAudioQueue({
      maxSeconds: envNumber('VITE_AUDIO_BUFFER_MAX_SECONDS', 60),
      maxBytes: envNumber('VITE_AUDIO_BUFFER_MAX_BYTES', 25_000_000),
      onChange: (snapshot) => this.callbacks.onBufferedAudioChange?.(snapshot),
    });
  }

  isSupported(): boolean {
    return Boolean(this.createWebSocket && this.url);
  }

  start(options: StartTranscriptionOptions): Promise<void> {
    if (!this.isSupported()) {
      const error: TranscriptionError = { code: 'unsupported', message: 'このブラウザはWebSocket音声認識に対応していません。' };
      options.callbacks?.onError?.(error);
      return Promise.reject(error);
    }

    this.cancelAllTimers();
    this.removeNetworkListeners();
    this.cleanupSocket(true);
    this.callbacks = options.callbacks ?? {};
    this.sessionId = options.sessionId;
    this.language = options.language;
    this.audioFormat = options.audioFormat;
    this.transcriptSequence = 0;
    this.active = true;
    this.stopRequested = false;
    this.gracefulStopPending = false;
    this.gracefulStopSending = false;
    this.ready = false;
    this.hasConnected = false;
    this.terminalError = false;
    this.reconnectAttempts = 0;
    this.lastAcknowledgedSequence = -1;
    this.revisions.clear();
    this.finalSegments.clear();
    this.addNetworkListeners();
    this.emitState(this.isOnline() ? 'connecting' : 'reconnecting');

    const promise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    if (this.isOnline()) this.openSocket(false);
    else this.debug('offline-wait', { generation: this.generation });
    return promise;
  }

  async acceptChunk(chunk: AudioChunk): Promise<void> {
    if (!this.active || this.stopRequested || this.gracefulStopPending) return;
    try {
      await this.queue.enqueue({
        sessionId: this.sessionId,
        sequence: chunk.sequence,
        capturedAt: chunk.capturedAt,
        mimeType: chunk.mimeType,
        data: chunk.data,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        encoding: chunk.encoding,
        frameCount: chunk.frameCount,
      });
      if (this.ready) await this.flushQueue();
    } catch (cause) {
      const error = toClientError(cause);
      this.callbacks.onWarning?.(error);
      throw cause;
    }
  }

  async stop(): Promise<void> {
    if (!this.active) {
      this.emitState('disconnected');
      return;
    }
    this.gracefulStopPending = true;
    this.terminalError = false;
    return new Promise<void>((resolve) => {
      this.stopResolve = resolve;
      this.stopTimer = this.scheduleTimeout(() => {
        this.callbacks.onError?.({
          code: 'network',
          message: '停止前に未送信音声をサーバーへ届けられませんでした。音声はローカルキューに保持されています。',
        });
        this.finishStop();
      }, this.stopTimeoutMs);
      if (this.ready) void this.requestGracefulStop();
      else if (!this.socket && this.isOnline()) this.openSocket(this.hasConnected);
    });
  }

  async abort(): Promise<void> {
    const error: TranscriptionError = { code: 'service', message: '音声認識を中止しました。' };
    const socket = this.socket;
    if (this.active && socket?.readyState === OPEN && this.ready) {
      socket.send(JSON.stringify({ type: 'cancel', sessionId: this.sessionId }));
    }
    this.active = false;
    this.stopRequested = true;
    this.ready = false;
    this.notifyAcknowledgementProgress();
    this.removeNetworkListeners();
    this.cancelAllTimers();
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.cleanupSocket(true);
    this.stopResolve?.();
    this.stopResolve = null;
    this.emitState('disconnected');
  }

  reconnect(): void {
    if (!this.active || this.stopRequested) return;
    this.terminalError = false;
    this.reconnectAttempts = 0;
    this.ready = false;
    this.cancelReconnectTimer();
    this.cancelHeartbeatTimers();
    this.cleanupSocket(true);
    this.emitState('reconnecting');
    if (this.isOnline()) {
      this.reconnectAttempts = 1;
      this.callbacks.onReconnectAttempt?.(1, this.reconnectMaxAttempts, 0);
      this.openSocket(this.hasConnected);
    }
  }

  getBufferedAudioSnapshot(): Promise<AudioBufferSnapshot> {
    return this.queue.snapshot(this.sessionId);
  }

  private openSocket(resume: boolean): void {
    if (!this.active || this.stopRequested || this.terminalError || this.socket || !this.isOnline()) return;
    this.cancelReconnectTimer();
    const generation = ++this.generation;
    let socket: WebSocketConnection;
    try {
      socket = this.createWebSocket?.(this.url) as WebSocketConnection;
    } catch (cause) {
      this.scheduleReconnect({ code: 'network', message: '音声認識サーバーへ接続できません。', cause });
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    this.debug('socket-created', { generation, readyState: socket.readyState, resume });
    this.connectionTimer = this.scheduleTimeout(() => {
      if (!this.isCurrent(socket, generation)) return;
      this.handleConnectionLoss(
        { code: 'network', message: '音声認識サーバーへの接続がタイムアウトしました。' },
        socket,
        generation,
      );
    }, this.connectionTimeoutMs);

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      const common = {
        sessionId: this.sessionId,
        language: toWireLanguage(this.language),
        audioFormat: this.audioFormat,
        ...(this.requestedProvider === 'local-whisper' ? { provider: this.requestedProvider } : {}),
      };
      if (resume) {
        this.emitState('resuming');
        this.debug('resume-send', {
          generation,
          readyState: socket.readyState,
          lastAcknowledgedSequence: this.lastAcknowledgedSequence,
        });
        socket.send(JSON.stringify({ type: 'resume', ...common, lastAcknowledgedSequence: this.lastAcknowledgedSequence }));
      } else {
        socket.send(JSON.stringify({ type: 'start', ...common }));
      }
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation) || typeof event.data !== 'string') return;
      this.handleServerMessage(event.data, socket, generation);
    };
    socket.onerror = () => {
      if (!this.isCurrent(socket, generation) || this.stopRequested) return;
      this.handleConnectionLoss(
        { code: 'network', message: '音声認識サーバーとの通信でエラーが発生しました。録音を継続して再接続します。' },
        socket,
        generation,
      );
    };
    socket.onclose = () => {
      if (!this.isCurrent(socket, generation)) return;
      if (this.stopRequested || !this.active) {
        this.finishStop();
        return;
      }
      this.handleConnectionLoss(
        { code: 'network', message: '音声認識サーバーとの接続が切断されました。録音を継続して再接続します。' },
        socket,
        generation,
      );
    };
  }

  private handleServerMessage(text: string, socket: WebSocketConnection, generation: number): void {
    let message;
    try {
      message = parseServerMessage(text);
    } catch (cause) {
      this.fail({ code: 'protocol', message: '音声認識サーバーから不正な応答を受信しました。', cause });
      return;
    }
    if (!this.isCurrent(socket, generation)) return;
    if ('sessionId' in message && message.sessionId !== undefined && message.sessionId !== this.sessionId) return;

    if (message.type === 'ready') {
      this.cancelConnectionTimer();
      this.ready = true;
      this.hasConnected = true;
      this.terminalError = false;
      this.reconnectAttempts = 0;
      this.callbacks.onReconnectAttempt?.(0, this.reconnectMaxAttempts, 0);
      this.emitState('ready');
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      this.startHeartbeat();
      if (this.gracefulStopPending) void this.requestGracefulStop();
      else void this.flushQueue();
      return;
    }
    if (message.type === 'resumed') {
      void this.completeResume(message.lastReceivedSequence, socket, generation);
      return;
    }
    if (message.type === 'pong') {
      this.debug('pong-received', { generation, readyState: socket.readyState });
      this.startHeartbeat();
      return;
    }
    if (message.type === 'audio_ack') {
      this.lastAcknowledgedSequence = Math.max(this.lastAcknowledgedSequence, message.sequence);
      this.debug('audio-ack', { generation, sequence: message.sequence, lastAcknowledgedSequence: this.lastAcknowledgedSequence });
      void this.queue.acknowledgeThrough(this.sessionId, message.sequence).then(() => this.debugQueue('audio-ack-queue'));
      this.notifyAcknowledgementProgress();
      return;
    }
    if (message.type === 'recognition_status') {
      const states = {
        listening: 'utterance-waiting',
        queued: 'recognition-queued',
        recognizing: 'recognizing',
        completed: 'recognition-complete',
      } as const;
      this.emitState(states[message.state]);
      this.callbacks.onProviderStatus?.({
        state: message.state,
        queueLength: message.queueLength,
        model: message.model,
        language: message.language,
        utteranceId: message.utteranceId,
        audioDurationMs: message.audioDurationMs,
        processingTimeMs: message.processingTimeMs,
        realTimeFactor: message.realTimeFactor,
      });
      return;
    }
    if (message.type === 'transcript') {
      const previousRevision = this.revisions.get(message.segmentId) ?? -1;
      if (message.revision <= previousRevision || this.finalSegments.has(message.segmentId)) return;
      this.revisions.set(message.segmentId, message.revision);
      if (message.isFinal) this.finalSegments.add(message.segmentId);
      this.emitState('transcribing');
      this.callbacks.onTranscript?.({
        sessionId: message.sessionId,
        segmentId: message.segmentId,
        sequence: this.transcriptSequence++,
        revision: message.revision,
        text: message.text,
        isFinal: message.isFinal,
        language: fromWireLanguage(message.language),
        provider: message.provider ?? this.id,
        startTime: message.startTime,
        endTime: message.endTime,
        confidence: message.confidence,
        createdAt: new Date().toISOString(),
        utteranceId: message.utteranceId,
        model: message.model,
        processingTimeMs: message.processingTimeMs,
        audioDurationMs: message.audioDurationMs,
        realTimeFactor: message.realTimeFactor,
      });
      return;
    }
    if (message.type === 'error') {
      const error: TranscriptionError = {
        code: message.code === 'api_key_missing' ? 'configuration' : message.retryable ? 'network' : 'service',
        message: message.message.slice(0, 300),
      };
      this.debug('server-error', { generation, code: message.code, retryable: message.retryable });
      if (message.retryable) this.handleConnectionLoss(error, socket, generation);
      else this.fail(error);
      return;
    }
    if (message.type === 'stopped') this.finishStop();
  }

  private async completeResume(lastReceivedSequence: number, socket: WebSocketConnection, generation: number): Promise<void> {
    this.cancelConnectionTimer();
    this.emitState('resuming');
    this.debug('resumed-received', { generation, lastReceivedSequence, lastAcknowledgedSequence: this.lastAcknowledgedSequence });
    try {
      await this.flushing;
      await this.queue.prepareForResume(this.sessionId, lastReceivedSequence);
      if (!this.isCurrent(socket, generation) || !this.active || this.stopRequested) return;
      this.lastAcknowledgedSequence = Math.max(this.lastAcknowledgedSequence, lastReceivedSequence);
      this.ready = true;
      this.hasConnected = true;
      this.terminalError = false;
      this.reconnectAttempts = 0;
      this.callbacks.onReconnectAttempt?.(0, this.reconnectMaxAttempts, 0);
      const replayChunks = await this.queue.listForResend(this.sessionId, lastReceivedSequence);
      const replayThroughSequence = replayChunks.at(-1)?.sequence ?? lastReceivedSequence;
      this.emitState('replaying');
      this.startHeartbeat();
      await this.debugQueue('replay-start');
      await this.flushQueue();
      await this.waitForAcknowledgement(replayThroughSequence, generation);
      if (!this.isCurrent(socket, generation) || !this.active || this.stopRequested) return;
      await this.debugQueue('replay-end');
      this.emitState('transcribing');
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      if (this.gracefulStopPending) void this.requestGracefulStop();
    } catch (cause) {
      if (!this.isCurrent(socket, generation) || !this.active || this.stopRequested) return;
      this.handleConnectionLoss(
        { code: 'network', message: '未送信音声の再送準備に失敗したため再接続します。', cause },
        socket,
        generation,
      );
    }
  }

  private flushQueue(): Promise<void> {
    if (this.flushing) {
      this.flushRequested = true;
      return this.flushing;
    }
    const generation = this.generation;
    this.flushing = (async () => {
      do {
        this.flushRequested = false;
        const chunks = await this.queue.listForResend(this.sessionId, this.lastAcknowledgedSequence);
        for (const chunk of chunks) {
          const socket = this.socket;
          if (!this.active || !this.ready || !socket || socket.readyState !== OPEN || generation !== this.generation) return;
          await this.waitForSocketCapacity(socket, generation);
          if (!this.isCurrent(socket, generation) || !this.ready) return;
          const audio = chunk.data instanceof Blob ? await chunk.data.arrayBuffer() : chunk.data;
          if (!this.isCurrent(socket, generation) || !this.ready) return;
          const metadata = this.requestedProvider === 'local-whisper'
            ? {
                capturedAt: chunk.capturedAt,
                sampleRate: chunk.sampleRate ?? 0,
                channels: chunk.channels ?? 0,
                encoding: chunk.encoding ?? 'pcm_s16le' as const,
                frameCount: chunk.frameCount ?? 0,
              }
            : undefined;
          socket.send(encodeAudioFrame(this.sessionId, chunk.sequence, audio, metadata));
          await this.queue.markSent(this.sessionId, chunk.sequence);
        }
      } while (this.flushRequested);
    })().finally(() => {
      const rerun = this.flushRequested;
      this.flushing = null;
      this.flushRequested = false;
      if (rerun && this.ready && this.active && !this.stopRequested) void this.flushQueue();
    });
    return this.flushing;
  }

  private async waitForSocketCapacity(socket: WebSocketConnection, generation: number): Promise<void> {
    while (socket.bufferedAmount > this.maxBufferedAmountBytes) {
      if (!this.isCurrent(socket, generation) || !this.ready || this.stopRequested) return;
      await new Promise<void>((resolve) => this.scheduleTimeout(resolve, BUFFER_POLL_MS));
    }
  }

  private handleConnectionLoss(error: TranscriptionError, socket?: WebSocketConnection, generation?: number): void {
    if (socket && generation !== undefined && !this.isCurrent(socket, generation)) return;
    if (!this.active || this.stopRequested || this.terminalError) return;
    this.ready = false;
    this.notifyAcknowledgementProgress();
    this.cancelConnectionTimer();
    this.cancelHeartbeatTimers();
    this.cleanupSocket(true);
    this.scheduleReconnect(error);
  }

  private scheduleReconnect(error: TranscriptionError): void {
    if (!this.active || this.stopRequested || this.terminalError) return;
    this.ready = false;
    this.emitState('reconnecting');
    if (this.reconnectTimer !== undefined) return;
    if (!this.isOnline()) {
      this.callbacks.onWarning?.(error);
      this.debug('reconnect-waiting-offline', { generation: this.generation, attempt: this.reconnectAttempts });
      return;
    }
    if (this.reconnectAttempts >= this.reconnectMaxAttempts) {
      this.terminalError = true;
      this.emitState('error');
      const terminal = { ...error, message: `${error.message} 自動再接続の上限に達しました。手動再接続を利用できます。` };
      this.callbacks.onError?.(terminal);
      this.readyReject?.(terminal);
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    const exponential = Math.min(this.reconnectMaxDelayMs, this.reconnectBaseDelayMs * 2 ** this.reconnectAttempts);
    const jitter = 1 + (this.random() * 2 - 1) * this.reconnectJitterRatio;
    const delay = Math.max(0, Math.round(exponential * jitter));
    this.reconnectAttempts += 1;
    this.callbacks.onReconnectAttempt?.(this.reconnectAttempts, this.reconnectMaxAttempts, delay);
    this.callbacks.onWarning?.(error);
    this.debug('reconnect-scheduled', {
      generation: this.generation,
      attempt: this.reconnectAttempts,
      maxAttempts: this.reconnectMaxAttempts,
      delay,
      code: error.code,
      retryable: true,
    });
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket(this.hasConnected);
    }, delay);
  }

  private handleOffline(): void {
    if (!this.active || this.stopRequested || this.terminalError) return;
    this.debug('network-offline', { generation: this.generation, readyState: this.socket?.readyState ?? -1 });
    this.cancelReconnectTimer();
    this.handleConnectionLoss({
      code: 'network',
      message: '通信が一時的に切断されました。録音を継続し、ネットワーク復旧後に再接続します。',
    });
  }

  private handleOnline(): void {
    if (!this.active || this.stopRequested || this.terminalError || this.ready) return;
    const hadScheduledAttempt = this.reconnectTimer !== undefined;
    this.cancelReconnectTimer();
    this.cancelHeartbeatTimers();
    this.cleanupSocket(true);
    this.emitState('reconnecting');
    if (!hadScheduledAttempt && this.hasConnected) {
      if (this.reconnectAttempts >= this.reconnectMaxAttempts) {
        this.scheduleReconnect({ code: 'network', message: 'ネットワーク復旧後の再接続上限に達しました。' });
        return;
      }
      this.reconnectAttempts += 1;
    }
    this.callbacks.onReconnectAttempt?.(Math.max(1, this.reconnectAttempts), this.reconnectMaxAttempts, 0);
    this.debug('network-online-reconnect', { generation: this.generation, attempt: this.reconnectAttempts });
    this.openSocket(this.hasConnected);
  }

  private startHeartbeat(): void {
    this.cancelHeartbeatTimers();
    if (!this.active || !this.ready || this.stopRequested || this.heartbeatIntervalMs <= 0) return;
    const generation = this.generation;
    this.heartbeatTimer = this.scheduleTimeout(() => {
      this.heartbeatTimer = undefined;
      const socket = this.socket;
      if (!socket || !this.isCurrent(socket, generation) || socket.readyState !== OPEN || !this.ready) return;
      socket.send(JSON.stringify({ type: 'ping', sessionId: this.sessionId }));
      this.debug('heartbeat-ping', { generation, readyState: socket.readyState });
      this.heartbeatTimeoutTimer = this.scheduleTimeout(() => {
        this.heartbeatTimeoutTimer = undefined;
        if (!this.isCurrent(socket, generation) || !this.ready) return;
        this.handleConnectionLoss(
          { code: 'network', message: '音声認識サーバーの応答が途絶えたため再接続します。' },
          socket,
          generation,
        );
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private fail(error: TranscriptionError): void {
    this.ready = false;
    this.terminalError = true;
    this.notifyAcknowledgementProgress();
    this.cancelConnectionTimer();
    this.cancelReconnectTimer();
    this.cancelHeartbeatTimers();
    this.debug('terminal-error', {
      generation: this.generation,
      readyState: this.socket?.readyState ?? -1,
      code: error.code,
      retryable: false,
    });
    this.emitState('error');
    this.callbacks.onError?.(error);
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.cleanupSocket(true);
  }

  private finishStop(): void {
    this.active = false;
    this.ready = false;
    this.stopRequested = true;
    this.gracefulStopPending = false;
    this.gracefulStopSending = false;
    this.notifyAcknowledgementProgress();
    this.removeNetworkListeners();
    this.cancelAllTimers();
    this.cleanupSocket(true);
    this.emitState('disconnected');
    this.stopResolve?.();
    this.stopResolve = null;
  }

  private async requestGracefulStop(): Promise<void> {
    if (!this.active || !this.gracefulStopPending || this.gracefulStopSending || !this.ready) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    const generation = this.generation;
    this.gracefulStopSending = true;
    try {
      await this.flushQueue();
      const unacknowledged = await this.queue.listForResend(this.sessionId, this.lastAcknowledgedSequence);
      const finalSequence = unacknowledged.at(-1)?.sequence ?? this.lastAcknowledgedSequence;
      await this.waitForAcknowledgement(finalSequence, generation);
      if (!this.isCurrent(socket, generation) || !this.ready || !this.active) return;
      this.stopRequested = true;
      this.removeNetworkListeners();
      this.cancelReconnectTimer();
      this.cancelHeartbeatTimers();
      socket.send(JSON.stringify({ type: 'stop', sessionId: this.sessionId }));
    } catch (cause) {
      this.callbacks.onWarning?.({
        code: 'network', message: '停止前の音声送信を再試行します。', cause,
      });
    } finally {
      this.gracefulStopSending = false;
    }
  }

  private cleanupSocket(close: boolean): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (close) socket.close(1000, 'Client cleanup');
  }

  private addNetworkListeners(): void {
    if (this.networkListenersRegistered) return;
    this.networkEvents.addEventListener('online', this.onlineListener);
    this.networkEvents.addEventListener('offline', this.offlineListener);
    this.networkListenersRegistered = true;
  }

  private removeNetworkListeners(): void {
    if (!this.networkListenersRegistered) return;
    this.networkEvents.removeEventListener('online', this.onlineListener);
    this.networkEvents.removeEventListener('offline', this.offlineListener);
    this.networkListenersRegistered = false;
  }

  private cancelConnectionTimer(): void {
    this.cancelTimeout(this.connectionTimer);
    this.connectionTimer = undefined;
  }

  private cancelReconnectTimer(): void {
    this.cancelTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private cancelHeartbeatTimers(): void {
    this.cancelTimeout(this.heartbeatTimer);
    this.cancelTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatTimeoutTimer = undefined;
  }

  private cancelAllTimers(): void {
    this.cancelConnectionTimer();
    this.cancelReconnectTimer();
    this.cancelHeartbeatTimers();
    this.cancelTimeout(this.stopTimer);
    this.stopTimer = undefined;
  }

  private isCurrent(socket: WebSocketConnection, generation: number): boolean {
    return socket === this.socket && generation === this.generation;
  }

  private waitForAcknowledgement(sequence: number, generation: number): Promise<void> {
    if (sequence <= this.lastAcknowledgedSequence) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (
          sequence <= this.lastAcknowledgedSequence
          || generation !== this.generation
          || !this.active
          || this.stopRequested
          || !this.ready
        ) {
          this.acknowledgementListeners.delete(check);
          resolve();
        }
      };
      this.acknowledgementListeners.add(check);
      check();
    });
  }

  private notifyAcknowledgementProgress(): void {
    for (const listener of [...this.acknowledgementListeners]) listener();
  }

  private emitState(state: TranscriptionState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private async debugQueue(event: string): Promise<void> {
    if (!import.meta.env.DEV) return;
    const snapshot = await this.queue.snapshot(this.sessionId);
    this.debug(event, {
      generation: this.generation,
      lastAcknowledgedSequence: this.lastAcknowledgedSequence,
      pendingCount: snapshot.pendingCount,
      sentUnacknowledgedCount: snapshot.sentUnacknowledgedCount,
    });
  }

  private debug(event: string, details: Record<string, unknown>): void {
    if (!import.meta.env.DEV) return;
    console.debug('[ws-transcription]', event, {
      session: shortSessionId(this.sessionId),
      ...details,
    });
  }
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 6)}…${sessionId.slice(-4)}`;
}

function toWireLanguage(language: TranscriptionLanguage): 'ja' | 'en' {
  return language === 'ja-JP' ? 'ja' : 'en';
}

function fromWireLanguage(language: 'ja' | 'en'): TranscriptionLanguage {
  return language === 'ja' ? 'ja-JP' : 'en-US';
}

function toClientError(cause: unknown): TranscriptionError {
  if (cause instanceof ProtocolValidationError) return { code: 'protocol', message: cause.message, cause };
  if (cause instanceof Error && 'code' in cause && cause.code === 'audio_buffer_limit') {
    return { code: 'service', message: cause.message, cause };
  }
  return { code: 'network', message: '音声チャンクを一時保存できませんでした。', cause };
}

function envNumber(name: keyof ImportMetaEnv, fallback: number): number {
  const value = Number(import.meta.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
