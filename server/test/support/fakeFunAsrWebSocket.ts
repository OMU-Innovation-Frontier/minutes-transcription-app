import { EventEmitter } from 'node:events';
import type { ClientOptions, RawData } from 'ws';
import type {
  FunAsrWebSocketFactory,
  FunAsrWebSocketLike,
} from '../../src/providers/funAsr/funAsrWebSocketTransport';

export interface FakeSentFrame {
  data: string | Uint8Array;
  binary: boolean;
  compress: boolean;
}

export class FakeFunAsrWebSocket extends EventEmitter implements FunAsrWebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly sentFrames: FakeSentFrame[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminateCount = 0;
  sendError = false;
  sendThrows = false;
  autoClose = true;

  send(
    data: string | Uint8Array,
    options: { binary: boolean; compress: boolean },
    callback: (error?: Error) => void,
  ): void {
    if (this.sendThrows) throw new Error('fake send failure');
    this.sentFrames.push({
      data: typeof data === 'string' ? data : Uint8Array.from(data),
      binary: options.binary,
      compress: options.compress,
    });
    callback(this.sendError ? new Error('fake send failure') : undefined);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
    if (this.autoClose) this.emitClose(code ?? 1_000);
  }

  terminate(): void {
    this.terminateCount += 1;
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emit('open');
  }

  emitMessage(data: RawData, isBinary = false): void {
    this.emit('message', data, isBinary);
  }

  emitError(): void {
    this.emit('error', new Error('fake websocket error'));
  }

  emitClose(code = 1_000): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.alloc(0));
  }

  emitUnexpectedResponse(): void {
    this.emit('unexpected-response');
  }
}

export class FakeFunAsrWebSocketFactory {
  readonly calls: Array<{ url: string; options: ClientOptions; socket: FakeFunAsrWebSocket }> = [];
  throwOnCreate = false;

  readonly create: FunAsrWebSocketFactory = (url, options) => {
    if (this.throwOnCreate) throw new Error('fake constructor failure');
    const socket = new FakeFunAsrWebSocket();
    this.calls.push({ url, options: structuredClone(options), socket });
    return socket;
  };

  get latest(): FakeFunAsrWebSocket {
    const call = this.calls.at(-1);
    if (!call) throw new Error('fake websocket was not created');
    return call.socket;
  }
}
