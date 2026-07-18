export type PendingAudioChunkStatus = 'pending' | 'sent' | 'acknowledged';

export interface PendingAudioChunk {
  sessionId: string;
  sequence: number;
  capturedAt: number;
  mimeType: string;
  data: Blob | ArrayBuffer;
  status: PendingAudioChunkStatus;
  retryCount: number;
  sampleRate?: number;
  channels?: number;
  encoding?: 'pcm_s16le';
  frameCount?: number;
}

export interface AudioBufferSnapshot {
  sessionId: string;
  chunkCount: number;
  pendingCount: number;
  sentUnacknowledgedCount: number;
  byteLength: number;
  durationSeconds: number;
  limitReached: boolean;
  persistent: boolean;
}

export interface PendingAudioStorage {
  readonly persistent: boolean;
  list(sessionId: string): Promise<PendingAudioChunk[]>;
  put(chunk: PendingAudioChunk): Promise<void>;
  delete(sessionId: string, sequence: number): Promise<void>;
}

export interface PendingAudioQueueOptions {
  maxSeconds: number;
  maxBytes: number;
  chunkDurationMs?: number;
  storage?: PendingAudioStorage;
  onChange?: (snapshot: AudioBufferSnapshot) => void;
}

export class AudioBufferLimitError extends Error {
  readonly code = 'audio_buffer_limit';
  constructor(message: string) {
    super(message);
    this.name = 'AudioBufferLimitError';
  }
}

export class PendingAudioQueue {
  private readonly storage: PendingAudioStorage;
  private readonly chunkDurationMs: number;
  private limitReached = false;

  constructor(private readonly options: PendingAudioQueueOptions) {
    this.storage = options.storage ?? createDefaultStorage();
    this.chunkDurationMs = options.chunkDurationMs ?? 1_000;
  }

  async enqueue(chunk: Omit<PendingAudioChunk, 'status' | 'retryCount'>): Promise<void> {
    const chunks = await this.storage.list(chunk.sessionId);
    if (chunks.some((item) => item.sequence === chunk.sequence)) return;
    const candidate: PendingAudioChunk = { ...chunk, status: 'pending', retryCount: 0 };
    const next = [...chunks, candidate].sort((a, b) => a.sequence - b.sequence);
    const snapshot = this.toSnapshot(chunk.sessionId, next);
    if (snapshot.byteLength > this.options.maxBytes || snapshot.durationSeconds > this.options.maxSeconds) {
      this.limitReached = true;
      await this.emit(chunk.sessionId, chunks);
      throw new AudioBufferLimitError(
        `未送信音声バッファが上限（${this.options.maxSeconds}秒 / ${this.options.maxBytes} bytes）に達しました。録音は継続しますが、このチャンクは保存できません。`,
      );
    }
    await this.storage.put(candidate);
    this.limitReached = false;
    await this.emit(chunk.sessionId);
  }

  async listForResend(sessionId: string, lastReceivedSequence = -1): Promise<PendingAudioChunk[]> {
    const chunks = await this.storage.list(sessionId);
    return chunks
      .filter((chunk) => chunk.status === 'pending' && chunk.sequence > lastReceivedSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async markSent(sessionId: string, sequence: number): Promise<void> {
    const chunk = (await this.storage.list(sessionId)).find((item) => item.sequence === sequence);
    if (!chunk || chunk.status === 'acknowledged') return;
    await this.storage.put({ ...chunk, status: 'sent', retryCount: chunk.retryCount + 1 });
    await this.emit(sessionId);
  }

  async acknowledge(sessionId: string, sequence: number): Promise<boolean> {
    const exists = (await this.storage.list(sessionId)).some((item) => item.sequence === sequence);
    if (!exists) return false;
    await this.storage.put({
      ...(await this.storage.list(sessionId)).find((item) => item.sequence === sequence)!,
      status: 'acknowledged',
    });
    await this.storage.delete(sessionId, sequence);
    await this.emit(sessionId);
    return true;
  }

  async acknowledgeThrough(sessionId: string, sequence: number): Promise<void> {
    const chunks = await this.storage.list(sessionId);
    await Promise.all(
      chunks.filter((chunk) => chunk.sequence <= sequence).map((chunk) => this.storage.delete(sessionId, chunk.sequence)),
    );
    await this.emit(sessionId);
  }

  async prepareForResume(sessionId: string, lastReceivedSequence: number): Promise<void> {
    const chunks = await this.storage.list(sessionId);
    await Promise.all(chunks.map(async (chunk) => {
      if (chunk.sequence <= lastReceivedSequence) await this.storage.delete(sessionId, chunk.sequence);
      else if (chunk.status !== 'acknowledged') await this.storage.put({ ...chunk, status: 'pending' });
    }));
    await this.emit(sessionId);
  }

  async snapshot(sessionId: string): Promise<AudioBufferSnapshot> {
    return this.toSnapshot(sessionId, await this.storage.list(sessionId));
  }

  private async emit(sessionId: string, chunks?: PendingAudioChunk[]): Promise<void> {
    this.options.onChange?.(this.toSnapshot(sessionId, chunks ?? await this.storage.list(sessionId)));
  }

  private toSnapshot(sessionId: string, chunks: PendingAudioChunk[]): AudioBufferSnapshot {
    const active = chunks.filter((chunk) => chunk.status !== 'acknowledged').sort((a, b) => a.capturedAt - b.capturedAt);
    const first = active[0];
    const last = active.at(-1);
    const durationSeconds = first && last
      ? Math.max(this.chunkDurationMs, last.capturedAt - first.capturedAt + this.chunkDurationMs) / 1_000
      : 0;
    return {
      sessionId,
      chunkCount: active.length,
      pendingCount: active.filter((chunk) => chunk.status === 'pending').length,
      sentUnacknowledgedCount: active.filter((chunk) => chunk.status === 'sent').length,
      byteLength: active.reduce((sum, chunk) => sum + byteLength(chunk.data), 0),
      durationSeconds,
      limitReached: this.limitReached,
      persistent: this.storage.persistent,
    };
  }
}

export class MemoryPendingAudioStorage implements PendingAudioStorage {
  readonly persistent = false;
  private readonly chunks = new Map<string, PendingAudioChunk>();

  async list(sessionId: string): Promise<PendingAudioChunk[]> {
    return [...this.chunks.values()].filter((chunk) => chunk.sessionId === sessionId);
  }
  async put(chunk: PendingAudioChunk): Promise<void> {
    this.chunks.set(key(chunk.sessionId, chunk.sequence), chunk);
  }
  async delete(sessionId: string, sequence: number): Promise<void> {
    this.chunks.delete(key(sessionId, sequence));
  }
}

export class IndexedDbPendingAudioStorage implements PendingAudioStorage {
  readonly persistent = true;
  private databasePromise?: Promise<IDBDatabase>;

  constructor(private readonly factory: IDBFactory, private readonly databaseName = 'minutes-audio-buffer') {}

  async list(sessionId: string): Promise<PendingAudioChunk[]> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const request = database.transaction('chunks', 'readonly').objectStore('chunks').getAll();
      request.onsuccess = () => resolve((request.result as StoredChunk[])
        .filter((chunk) => chunk.sessionId === sessionId)
        .map(fromStored));
      request.onerror = () => reject(request.error ?? new Error('IndexedDBの読み取りに失敗しました。'));
    });
  }

  async put(chunk: PendingAudioChunk): Promise<void> {
    const database = await this.database();
    await requestDone(database.transaction('chunks', 'readwrite').objectStore('chunks').put(toStored(chunk)));
  }

  async delete(sessionId: string, sequence: number): Promise<void> {
    const database = await this.database();
    await requestDone(database.transaction('chunks', 'readwrite').objectStore('chunks').delete(key(sessionId, sequence)));
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('chunks')) request.result.createObjectStore('chunks', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDBを開けませんでした。'));
    });
    return this.databasePromise;
  }
}

interface StoredChunk extends PendingAudioChunk { key: string }

function createDefaultStorage(): PendingAudioStorage {
  return typeof indexedDB === 'undefined'
    ? new MemoryPendingAudioStorage()
    : new IndexedDbPendingAudioStorage(indexedDB);
}

function toStored(chunk: PendingAudioChunk): StoredChunk {
  return { ...chunk, key: key(chunk.sessionId, chunk.sequence) };
}

function fromStored(chunk: StoredChunk): PendingAudioChunk {
  return {
    sessionId: chunk.sessionId,
    sequence: chunk.sequence,
    capturedAt: chunk.capturedAt,
    mimeType: chunk.mimeType,
    data: chunk.data,
    status: chunk.status,
    retryCount: chunk.retryCount,
    sampleRate: chunk.sampleRate,
    channels: chunk.channels,
    encoding: chunk.encoding,
    frameCount: chunk.frameCount,
  };
}

function key(sessionId: string, sequence: number): string {
  return `${sessionId}:${sequence.toString().padStart(10, '0')}`;
}

function byteLength(data: Blob | ArrayBuffer): number {
  return data instanceof Blob ? data.size : data.byteLength;
}

function requestDone(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('IndexedDB操作に失敗しました。'));
  });
}
