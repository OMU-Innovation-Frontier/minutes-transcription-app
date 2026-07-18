import {
  CORRECTION_POLICY_VERSION,
  createFallbackCorrection,
  validateCorrectionOutput,
  type CorrectionInput,
  type CorrectionRequest,
  type CorrectionServiceStatus,
  type GlossaryEntry,
  type TranscriptCorrection,
} from '../../shared/correction';
import type { CompletedSentence } from '../transcription/types';
import type { TranscriptStore } from '../transcription/transcriptStore';

export class CorrectionHttpClient {
  private readonly request: typeof fetch;

  constructor(
    private readonly baseUrl = import.meta.env.VITE_SERVER_HTTP_URL ?? 'http://127.0.0.1:8787',
    request: typeof fetch = window.fetch,
  ) {
    this.request = request.bind(window);
  }

  status(): Promise<CorrectionServiceStatus> {
    return this.get('/api/correction/status') as Promise<CorrectionServiceStatus>;
  }

  async correct(request: CorrectionRequest, signal: AbortSignal): Promise<TranscriptCorrection> {
    const value = await this.post('/api/correction', request, signal);
    return validateResponse(value, request.input);
  }

  private async get(path: string): Promise<unknown> {
    return this.parse(await this.request(`${this.baseUrl}${path}`));
  }

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    return this.parse(await this.request(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }));
  }

  private async parse(response: Response): Promise<unknown> {
    const value = await response.json() as unknown;
    if (!response.ok) {
      const message = value && typeof value === 'object' && 'message' in value && typeof value.message === 'string'
        ? value.message
        : '整文サーバーとの通信に失敗しました。';
      throw new Error(message);
    }
    return value;
  }
}

export interface CorrectionStorage {
  readonly persistent: boolean;
  get(sessionId: string, sentenceId: string): Promise<TranscriptCorrection | undefined>;
  put(sessionId: string, sentenceId: string, correction: TranscriptCorrection): Promise<void>;
}

export class MemoryCorrectionStorage implements CorrectionStorage {
  readonly persistent = false;
  private readonly values = new Map<string, TranscriptCorrection>();

  async get(sessionId: string, sentenceId: string): Promise<TranscriptCorrection | undefined> {
    return this.values.get(storageKey(sessionId, sentenceId));
  }

  async put(sessionId: string, sentenceId: string, correction: TranscriptCorrection): Promise<void> {
    this.values.set(storageKey(sessionId, sentenceId), cloneCorrection(correction));
  }
}

export class IndexedDbCorrectionStorage implements CorrectionStorage {
  readonly persistent = true;
  private databasePromise?: Promise<IDBDatabase>;

  constructor(private readonly factory: IDBFactory, private readonly databaseName = 'minutes-transcript-corrections') {}

  async get(sessionId: string, sentenceId: string): Promise<TranscriptCorrection | undefined> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const request = database.transaction('corrections', 'readonly').objectStore('corrections').get(storageKey(sessionId, sentenceId));
      request.onsuccess = () => resolve((request.result as StoredCorrection | undefined)?.correction);
      request.onerror = () => reject(request.error ?? new Error('整文データの読み取りに失敗しました。'));
    });
  }

  async put(sessionId: string, sentenceId: string, correction: TranscriptCorrection): Promise<void> {
    const database = await this.database();
    await requestDone(database.transaction('corrections', 'readwrite').objectStore('corrections').put({
      key: storageKey(sessionId, sentenceId),
      sessionId,
      sentenceId,
      correction: cloneCorrection(correction),
      savedAt: new Date().toISOString(),
    } satisfies StoredCorrection));
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('corrections')) {
          request.result.createObjectStore('corrections', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('整文用IndexedDBを開けませんでした。'));
    });
    return this.databasePromise;
  }
}

interface StoredCorrection {
  key: string;
  sessionId: string;
  sentenceId: string;
  correction: TranscriptCorrection;
  savedAt: string;
}

export interface CorrectionCoordinatorCallbacks {
  onStatus?: (status: CorrectionServiceStatus) => void;
  onError?: (error: Error) => void;
}

export interface CorrectionCoordinatorOptions {
  glossary?: GlossaryEntry[];
  storage?: CorrectionStorage;
  policyVersion?: string;
  setTimeout?: typeof window.setTimeout;
  clearTimeout?: typeof window.clearTimeout;
}

interface CorrectionJob {
  sentence: CompletedSentence;
  input: CorrectionInput;
  generation: number;
}

const DISABLED_STATUS: CorrectionServiceStatus = {
  enabled: false,
  provider: 'mock',
  externalTransmission: false,
  timeoutMs: 8_000,
  concurrency: 1,
  maxInputChars: 4_000,
  removeFillers: false,
  correctionPolicyVersion: CORRECTION_POLICY_VERSION,
};

export class CorrectionCoordinator {
  private statusValue = DISABLED_STATUS;
  private initialized = false;
  private disposed = false;
  private generation = 0;
  private active = 0;
  private readonly candidates = new Map<string, CompletedSentence>();
  private readonly scheduled = new Set<string>();
  private readonly queue: CorrectionJob[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly storage: CorrectionStorage;
  private readonly scheduleTimeout: typeof window.setTimeout;
  private readonly cancelTimeout: typeof window.clearTimeout;

  constructor(
    private readonly client: CorrectionHttpClient,
    private readonly store: TranscriptStore,
    private readonly sessionId: string,
    private readonly callbacks: CorrectionCoordinatorCallbacks = {},
    private readonly options: CorrectionCoordinatorOptions = {},
  ) {
    this.storage = options.storage ?? createDefaultStorage();
    this.scheduleTimeout = options.setTimeout ?? window.setTimeout.bind(window);
    this.cancelTimeout = options.clearTimeout ?? window.clearTimeout.bind(window);
  }

  async initialize(): Promise<void> {
    try {
      this.statusValue = await this.client.status();
      this.callbacks.onStatus?.(this.statusValue);
    } catch (error) {
      this.callbacks.onError?.(toError(error));
    } finally {
      this.initialized = true;
      this.evaluateCandidates();
    }
  }

  add(sentences: readonly CompletedSentence[]): void {
    if (this.disposed) return;
    for (const sentence of sentences) {
      if (sentence.sessionId === this.sessionId) this.candidates.set(sentence.id, sentence);
    }
    if (this.initialized) this.evaluateCandidates();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.queue.length = 0;
  }

  private evaluateCandidates(): void {
    for (const sentence of this.candidates.values()) {
      if (this.scheduled.has(sentence.id) || sentence.correction?.status === 'completed') continue;
      this.scheduled.add(sentence.id);
      if (!this.statusValue.enabled) {
        this.apply(sentence, createFallbackCorrection(sentence.rawText, 'disabled', sentence.rawSegmentIds, {
          provider: this.statusValue.provider,
        }));
        continue;
      }
      if (!sentence.rawText.trim()) {
        this.apply(sentence, createFallbackCorrection('', 'skipped', sentence.rawSegmentIds, {
          provider: this.statusValue.provider,
          errorCode: 'empty_text',
        }));
        continue;
      }
      const input = this.buildInput(sentence);
      if (!input) {
        this.apply(sentence, createFallbackCorrection(sentence.rawText, 'skipped', sentence.rawSegmentIds, {
          provider: this.statusValue.provider,
          errorCode: 'input_too_large',
        }));
        continue;
      }
      this.apply(sentence, createFallbackCorrection(sentence.rawText, 'pending', sentence.rawSegmentIds, {
        provider: this.statusValue.provider,
      }), false);
      this.queue.push({ sentence, input, generation: this.generation });
    }
    this.pump();
  }

  private buildInput(sentence: CompletedSentence): CorrectionInput | null {
    const ordered = [...this.candidates.values()];
    const targetIndex = ordered.findIndex((candidate) => candidate.id === sentence.id);
    const previousSegments = ordered
      .slice(Math.max(0, targetIndex - 2), targetIndex)
      .map((candidate) => ({ segmentId: candidate.id, rawText: candidate.rawText }));
    const glossary = this.options.glossary ?? [];
    const baseCharacters = sentence.rawText.length
      + glossary.reduce((sum, entry) => sum + entry.canonical.length + (entry.aliases ?? []).join('').length, 0);
    if (baseCharacters > this.statusValue.maxInputChars) return null;
    while (previousSegments.length > 0 && baseCharacters + previousSegments.reduce((sum, item) => sum + item.rawText.length, 0) > this.statusValue.maxInputChars) {
      previousSegments.shift();
    }
    return {
      targetSegmentId: sentence.id,
      targetRawText: sentence.rawText,
      previousSegments,
      language: sentence.language,
      glossary,
      correctionPolicyVersion: this.options.policyVersion ?? this.statusValue.correctionPolicyVersion,
      removeFillers: this.statusValue.removeFillers,
      sourceSegmentIds: [...sentence.rawSegmentIds],
    };
  }

  private pump(): void {
    const concurrency = Math.max(1, Math.min(4, this.statusValue.concurrency));
    while (!this.disposed && this.active < concurrency) {
      const job = this.queue.shift();
      if (!job) return;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: CorrectionJob): Promise<void> {
    try {
      const saved = await this.storage.get(this.sessionId, job.sentence.id);
      if (saved && saved.rawText === job.sentence.rawText && saved.status !== 'pending') {
        if (this.isCurrent(job)) this.store.applyCorrection(this.sessionId, job.sentence.id, saved);
        return;
      }
      await this.storage.put(this.sessionId, job.sentence.id, createFallbackCorrection(
        job.sentence.rawText,
        'pending',
        job.sentence.rawSegmentIds,
        { provider: this.statusValue.provider },
      ));
      const controller = new AbortController();
      this.controllers.set(job.sentence.id, controller);
      const timer = this.scheduleTimeout(() => controller.abort(), this.statusValue.timeoutMs + 500);
      try {
        const correction = await this.client.correct({ sessionId: this.sessionId, input: job.input }, controller.signal);
        if (this.isCurrent(job)) this.apply(job.sentence, correction);
      } finally {
        this.cancelTimeout(timer);
        this.controllers.delete(job.sentence.id);
      }
    } catch (error) {
      if (!this.isCurrent(job)) return;
      const code = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'request_failed';
      this.apply(job.sentence, createFallbackCorrection(job.sentence.rawText, 'failed', job.sentence.rawSegmentIds, {
        provider: this.statusValue.provider,
        errorCode: code,
      }));
      this.callbacks.onError?.(toError(error));
    }
  }

  private isCurrent(job: CorrectionJob): boolean {
    return !this.disposed && job.generation === this.generation && job.sentence.sessionId === this.sessionId;
  }

  private apply(sentence: CompletedSentence, correction: TranscriptCorrection, persist = true): void {
    if (!this.store.applyCorrection(this.sessionId, sentence.id, correction)) return;
    if (persist) void this.storage.put(this.sessionId, sentence.id, correction).catch((error) => this.callbacks.onError?.(toError(error)));
  }
}

function validateResponse(value: unknown, input: CorrectionInput): TranscriptCorrection {
  if (!value || typeof value !== 'object') throw new Error('整文レスポンスが不正です。');
  const record = value as Partial<TranscriptCorrection>;
  if (record.rawText !== input.targetRawText || !Array.isArray(record.sourceSegmentIds)
    || record.sourceSegmentIds.join('\u0000') !== input.sourceSegmentIds.join('\u0000')) {
    throw new Error('整文レスポンスの原文参照が一致しません。');
  }
  if (record.status === 'completed') {
    const validated = validateCorrectionOutput({
      correctedText: record.correctedText,
      changes: record.changes,
      uncertainParts: record.uncertainParts,
    }, input, { removeFillers: input.removeFillers });
    return {
      rawText: input.targetRawText,
      correctedText: validated.correctedText,
      status: 'completed',
      changes: validated.changes,
      uncertainParts: validated.uncertainParts,
      provider: typeof record.provider === 'string' ? record.provider : undefined,
      processingTimeMs: typeof record.processingTimeMs === 'number' ? record.processingTimeMs : undefined,
      sourceSegmentIds: [...input.sourceSegmentIds],
    };
  }
  if (record.status !== 'disabled' && record.status !== 'failed' && record.status !== 'skipped') {
    throw new Error('整文レスポンスのstatusが不正です。');
  }
  return createFallbackCorrection(input.targetRawText, record.status, input.sourceSegmentIds, {
    provider: typeof record.provider === 'string' ? record.provider : undefined,
    processingTimeMs: typeof record.processingTimeMs === 'number' ? record.processingTimeMs : undefined,
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : undefined,
  });
}

function createDefaultStorage(): CorrectionStorage {
  return typeof indexedDB === 'undefined'
    ? new MemoryCorrectionStorage()
    : new IndexedDbCorrectionStorage(indexedDB);
}

function storageKey(sessionId: string, sentenceId: string): string {
  return `${sessionId}:${sentenceId}`;
}

function cloneCorrection(correction: TranscriptCorrection): TranscriptCorrection {
  return {
    ...correction,
    changes: correction.changes.map((change) => ({ ...change })),
    uncertainParts: correction.uncertainParts.map((part) => ({ ...part })),
    sourceSegmentIds: [...correction.sourceSegmentIds],
  };
}

function requestDone(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('整文データの保存に失敗しました。'));
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('整文処理に失敗しました。');
}
