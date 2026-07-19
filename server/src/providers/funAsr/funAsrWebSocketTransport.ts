import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { MAX_AUDIO_CHUNK_BYTES } from '../../../../shared/protocol.js';
import { ServerProviderError } from '../types.js';
import { assertFunAsrApiKey, assertFunAsrSingaporeEndpoint } from './funAsrEndpoint.js';
import type { FunAsrTransport } from './funAsrTransport.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
const NORMAL_CLOSE_CODE = 1_000;
const NORMAL_CLOSE_REASON = 'client closing';
const DEFAULT_MAX_CONTROL_BYTES = 64 * 1_024;
const DEFAULT_MAX_MESSAGE_BYTES = 1_024 * 1_024;
const DEFAULT_MAX_BUFFERED_BYTES = 2 * MAX_AUDIO_CHUNK_BYTES;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export interface FunAsrWebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(
    data: string | Uint8Array,
    options: { binary: boolean; compress: boolean },
    callback: (error?: Error) => void,
  ): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open', callback: () => void): void;
  on(event: 'message', callback: (data: RawData, isBinary: boolean) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: 'close', callback: (code: number, reason: Buffer) => void): void;
  on(event: 'unexpected-response', callback: () => void): void;
  off(event: 'open', callback: () => void): void;
  off(event: 'message', callback: (data: RawData, isBinary: boolean) => void): void;
  off(event: 'error', callback: (error: Error) => void): void;
  off(event: 'close', callback: (code: number, reason: Buffer) => void): void;
  off(event: 'unexpected-response', callback: () => void): void;
}

export type FunAsrWebSocketFactory = (
  url: string,
  options: ClientOptions,
) => FunAsrWebSocketLike;

export interface FunAsrWebSocketTransportOptions {
  endpoint: string;
  workspaceId: string;
  apiKey: string;
  handshakeTimeoutMs: number;
  closeTimeoutMs?: number;
  maxControlBytes?: number;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
  createWebSocket?: FunAsrWebSocketFactory;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type TransportState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

export class FunAsrWebSocketTransport implements FunAsrTransport {
  private readonly createWebSocket: FunAsrWebSocketFactory;
  private readonly setTimer: NonNullable<FunAsrWebSocketTransportOptions['setTimer']>;
  private readonly clearTimer: NonNullable<FunAsrWebSocketTransportOptions['clearTimer']>;
  private readonly closeTimeoutMs: number;
  private readonly maxControlBytes: number;
  private readonly maxMessageBytes: number;
  private readonly maxBufferedBytes: number;
  private state: TransportState = 'idle';
  private socket?: FunAsrWebSocketLike;
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private resolveConnect?: () => void;
  private rejectConnect?: (error: ServerProviderError) => void;
  private resolveClose?: () => void;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private errorNotified = false;
  private closeNotified = false;
  private readonly messageCallbacks = new Set<(message: unknown) => void>();
  private readonly errorCallbacks = new Set<(error: unknown) => void>();
  private readonly closeCallbacks = new Set<() => void>();

  constructor(private readonly options: FunAsrWebSocketTransportOptions) {
    assertFunAsrSingaporeEndpoint(options.endpoint, options.workspaceId);
    assertFunAsrApiKey(options.apiKey);
    this.assertBoundedInteger(options.handshakeTimeoutMs, 1_000, 120_000);
    this.closeTimeoutMs = this.readBoundedInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 100, 30_000);
    this.maxControlBytes = this.readBoundedInteger(options.maxControlBytes, DEFAULT_MAX_CONTROL_BYTES, 1_024, 1_024 * 1_024);
    this.maxMessageBytes = this.readBoundedInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 1_024, 4 * 1_024 * 1_024);
    this.maxBufferedBytes = this.readBoundedInteger(options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, MAX_AUDIO_CHUNK_BYTES, 16 * MAX_AUDIO_CHUNK_BYTES);
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  connect(): Promise<void> {
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'connecting' && this.connectPromise) return this.connectPromise;
    if (this.state !== 'idle') return Promise.reject(transportError('fun_asr_transport_connect_failed'));
    this.state = 'connecting';
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    try {
      const socket = this.createWebSocket(this.options.endpoint, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        handshakeTimeout: this.options.handshakeTimeoutMs,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: this.maxMessageBytes,
        rejectUnauthorized: true,
      });
      this.socket = socket;
      this.attachSocket(socket);
      this.connectTimer = this.setTimer(() => {
        if (this.state !== 'connecting') return;
        this.rejectConnection(transportError('fun_asr_transport_connect_failed'));
        void this.close();
      }, this.options.handshakeTimeoutMs);
    } catch {
      this.rejectConnection(transportError('fun_asr_transport_connect_failed'));
      this.finalizeClose(false);
    }
    return this.connectPromise;
  }

  async sendControl(message: unknown): Promise<void> {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(message);
    } catch {
      throw transportError('fun_asr_transport_invalid_message');
    }
    if (
      serialized === undefined
      || Buffer.byteLength(serialized, 'utf8') > this.maxControlBytes
      || containsSensitiveValue(
        JSON.parse(serialized) as unknown,
        [this.options.apiKey, this.options.workspaceId],
      )
    ) {
      throw transportError('fun_asr_transport_invalid_message');
    }
    await this.sendFrame(serialized, false, Buffer.byteLength(serialized, 'utf8'));
  }

  async sendAudio(audio: Uint8Array): Promise<void> {
    if (!(audio instanceof Uint8Array) || audio.byteLength % 2 !== 0) {
      throw transportError('fun_asr_transport_invalid_message');
    }
    if (audio.byteLength === 0) return;
    if (audio.byteLength > MAX_AUDIO_CHUNK_BYTES) {
      throw transportError('fun_asr_transport_message_too_large');
    }
    const copy = Uint8Array.from(audio);
    await this.sendFrame(copy, true, copy.byteLength);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'closed') return Promise.resolve();
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });
    const socket = this.socket;
    if (this.state === 'connecting') {
      this.rejectConnection(transportError('fun_asr_transport_connect_failed'));
    }
    this.state = 'closing';
    if (!socket || socket.readyState === CLOSED) {
      this.finalizeClose();
      return this.closePromise;
    }
    try {
      if (socket.readyState === CONNECTING || socket.readyState === OPEN) {
        socket.close(NORMAL_CLOSE_CODE, NORMAL_CLOSE_REASON);
      }
    } catch {
      // The close timeout below is the bounded fallback for a socket that cannot close cleanly.
    }
    if (socket.readyState === CLOSED) {
      this.finalizeClose();
      return this.closePromise;
    }
    this.closeTimer = this.setTimer(() => {
      if (this.state === 'closed') return;
      try {
        socket.terminate();
      } catch {
        // Cleanup must finish even when the underlying socket rejects termination.
      }
      this.finalizeClose();
    }, this.closeTimeoutMs);
    return this.closePromise;
  }

  onMessage(callback: (message: unknown) => void): () => void {
    this.messageCallbacks.add(callback);
    return () => this.messageCallbacks.delete(callback);
  }

  onError(callback: (error: unknown) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  onClose(callback: () => void): () => void {
    this.closeCallbacks.add(callback);
    return () => this.closeCallbacks.delete(callback);
  }

  private attachSocket(socket: FunAsrWebSocketLike): void {
    socket.on('open', this.handleOpen);
    socket.on('message', this.handleMessage);
    socket.on('error', this.handleError);
    socket.on('close', this.handleClose);
    socket.on('unexpected-response', this.handleUnexpectedResponse);
  }

  private readonly handleOpen = (): void => {
    if (this.state !== 'connecting') return;
    this.clearConnectTimer();
    this.state = 'open';
    this.resolveConnect?.();
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
  };

  private readonly handleMessage = (data: RawData, isBinary: boolean): void => {
    if (this.state !== 'open' || isBinary) {
      this.notifyError(transportError('fun_asr_transport_protocol_failed'));
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = toUint8Array(data, this.maxMessageBytes);
    } catch (error) {
      this.notifyError(error instanceof ServerProviderError ? error : transportError('fun_asr_transport_invalid_message'));
      return;
    }
    let message: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      message = JSON.parse(text) as unknown;
    } catch {
      this.notifyError(transportError('fun_asr_transport_invalid_message'));
      return;
    }
    for (const callback of this.messageCallbacks) callback(message);
  };

  private readonly handleError = (): void => {
    if (this.state === 'connecting') {
      this.rejectConnection(transportError('fun_asr_transport_connect_failed'));
      return;
    }
    if (this.state === 'open') this.notifyError(transportError('fun_asr_transport_closed'));
  };

  private readonly handleUnexpectedResponse = (): void => {
    if (this.state === 'connecting') this.rejectConnection(transportError('fun_asr_transport_connect_failed'));
  };

  private readonly handleClose = (): void => {
    const notify = this.state !== 'connecting';
    if (!notify) this.rejectConnection(transportError('fun_asr_transport_connect_failed'));
    this.finalizeClose(notify);
  };

  private sendFrame(data: string | Uint8Array, binary: boolean, byteLength: number): Promise<void> {
    const socket = this.socket;
    if (this.state !== 'open' || !socket || socket.readyState !== OPEN) {
      return Promise.reject(transportError('fun_asr_transport_closed'));
    }
    if (!Number.isSafeInteger(socket.bufferedAmount) || socket.bufferedAmount < 0) {
      return Promise.reject(transportError('fun_asr_transport_backpressure'));
    }
    if (socket.bufferedAmount > this.maxBufferedBytes - byteLength) {
      return Promise.reject(transportError('fun_asr_transport_backpressure'));
    }
    return new Promise<void>((resolve, reject) => {
      try {
        socket.send(data, { binary, compress: false }, (error) => {
          if (error) reject(transportError('fun_asr_transport_send_failed'));
          else resolve();
        });
      } catch {
        reject(transportError('fun_asr_transport_send_failed'));
      }
    });
  }

  private rejectConnection(error: ServerProviderError): void {
    if (this.state !== 'connecting') return;
    this.clearConnectTimer();
    this.rejectConnect?.(error);
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
  }

  private notifyError(error: ServerProviderError): void {
    if (this.errorNotified || this.state === 'closing' || this.state === 'closed') return;
    this.errorNotified = true;
    for (const callback of this.errorCallbacks) callback(error);
  }

  private finalizeClose(notify = true): void {
    if (this.state === 'closed') return;
    this.clearConnectTimer();
    if (this.closeTimer !== undefined) {
      this.clearTimer(this.closeTimer);
      this.closeTimer = undefined;
    }
    const socket = this.socket;
    if (socket) this.detachSocket(socket);
    this.socket = undefined;
    this.state = 'closed';
    this.resolveClose?.();
    this.resolveClose = undefined;
    const closeCallbacks = notify && !this.closeNotified ? [...this.closeCallbacks] : [];
    this.messageCallbacks.clear();
    this.errorCallbacks.clear();
    this.closeCallbacks.clear();
    if (notify && !this.closeNotified) {
      this.closeNotified = true;
      for (const callback of closeCallbacks) callback();
    }
  }

  private detachSocket(socket: FunAsrWebSocketLike): void {
    socket.off('open', this.handleOpen);
    socket.off('message', this.handleMessage);
    socket.off('error', this.handleError);
    socket.off('close', this.handleClose);
    socket.off('unexpected-response', this.handleUnexpectedResponse);
    // Node EventEmitter treats an unobserved late "error" as fatal. This module-level
    // sink retains no transport state and protects the process after all owned listeners are gone.
    socket.on('error', ignoreLateSocketError);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === undefined) return;
    this.clearTimer(this.connectTimer);
    this.connectTimer = undefined;
  }

  private readBoundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
    const resolved = value ?? fallback;
    this.assertBoundedInteger(resolved, minimum, maximum);
    return resolved;
  }

  private assertBoundedInteger(value: number, minimum: number, maximum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw transportError('fun_asr_transport_configuration_invalid');
    }
  }
}

function defaultWebSocketFactory(url: string, options: ClientOptions): FunAsrWebSocketLike {
  return new WebSocket(url, options);
}

function ignoreLateSocketError(): void {
  // The transport has already emitted a safe classification and released its state.
}

function containsSensitiveValue(value: unknown, sensitiveValues: readonly string[]): boolean {
  const pending: unknown[] = [value];
  let inspected = 0;
  while (pending.length > 0) {
    inspected += 1;
    if (inspected > 10_000) return true;
    const current = pending.pop();
    if (typeof current === 'string') {
      if (containsAnySensitiveText(current, sensitiveValues)) return true;
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (
        key.toLowerCase() === 'authorization'
        || containsAnySensitiveText(key, sensitiveValues)
      ) return true;
      pending.push(child);
    }
  }
  return false;
}

function containsAnySensitiveText(value: string, sensitiveValues: readonly string[]): boolean {
  return sensitiveValues.some((sensitiveValue) => (
    sensitiveValue.length > 0 && value.includes(sensitiveValue)
  ));
}

function toUint8Array(data: RawData, maximumBytes: number): Uint8Array {
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maximumBytes) throw transportError('fun_asr_transport_message_too_large');
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    let length = 0;
    for (const part of data) {
      length += part.byteLength;
      if (!Number.isSafeInteger(length) || length > maximumBytes) {
        throw transportError('fun_asr_transport_message_too_large');
      }
    }
    return Uint8Array.from(Buffer.concat(data, length));
  }
  if (data.byteLength > maximumBytes) throw transportError('fun_asr_transport_message_too_large');
  return Uint8Array.from(data);
}

function transportError(code: string): ServerProviderError {
  const messages: Record<string, string> = {
    fun_asr_transport_connect_failed: 'Fun-ASR connection failed.',
    fun_asr_transport_send_failed: 'Fun-ASR send failed.',
    fun_asr_transport_protocol_failed: 'Fun-ASR transport protocol failed.',
    fun_asr_transport_closed: 'Fun-ASR transport closed.',
    fun_asr_transport_backpressure: 'Fun-ASR transport is busy.',
    fun_asr_transport_message_too_large: 'Fun-ASR transport message is too large.',
    fun_asr_transport_invalid_message: 'Fun-ASR transport message is invalid.',
    fun_asr_transport_configuration_invalid: 'Fun-ASR transport configuration is invalid.',
  };
  return new ServerProviderError(code, false, messages[code] ?? 'Fun-ASR transport failed.');
}
