import type { FunAsrTransport } from '../../src/providers/funAsr/funAsrTransport';

export class FakeFunAsrTransport implements FunAsrTransport {
  readonly controls: unknown[] = [];
  readonly audioChunks: Uint8Array[] = [];
  connectCount = 0;
  closeCount = 0;
  failConnect = false;
  failAudio = false;
  hangConnect = false;
  hangFinishControl = false;
  hangAudio = false;
  private readonly messageCallbacks = new Set<(message: unknown) => void>();
  private readonly errorCallbacks = new Set<(error: unknown) => void>();
  private readonly closeCallbacks = new Set<() => void>();

  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.failConnect) throw new Error('fake connect failure');
    if (this.hangConnect) await new Promise<void>(() => undefined);
  }

  async sendControl(message: unknown): Promise<void> {
    this.controls.push(structuredClone(message));
    if (this.hangFinishControl && controlAction(message) === 'finish-task') {
      await new Promise<void>(() => undefined);
    }
  }

  async sendAudio(audio: Uint8Array): Promise<void> {
    this.audioChunks.push(audio.slice());
    if (this.failAudio) throw new Error('fake audio failure');
    if (this.hangAudio) await new Promise<void>(() => undefined);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
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

  emitMessage(message: unknown): void {
    for (const callback of this.messageCallbacks) callback(message);
  }

  emitError(): void {
    for (const callback of this.errorCallbacks) callback(new Error('fake transport error'));
  }

  emitClose(): void {
    for (const callback of this.closeCallbacks) callback();
  }

  get listenerCount(): number {
    return this.messageCallbacks.size + this.errorCallbacks.size + this.closeCallbacks.size;
  }
}

function controlAction(value: unknown): unknown {
  return (value as { header?: { action?: unknown } }).header?.action;
}
