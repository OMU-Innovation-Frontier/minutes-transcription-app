import {
  CORRECTION_MAX_ATTEMPTS,
  CORRECTION_POLICY_VERSION,
  CORRECTION_QUEUE_LIMIT,
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
    return validateResponse(value, request);
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
  put(sessionId: string, sentenceId: string, correction: TranscriptCorrection): Promise<boolean>;
}

export class MemoryCorrectionStorage implements CorrectionStorage {
  readonly persistent = false;
  private readonly values = new Map<string, TranscriptCorrection>();

  async get(sessionId: string, sentenceId: string): Promise<TranscriptCorrection | undefined> {
    const value = this.values.get(storageKey(sessionId, sentenceId));
    return value ? cloneCorrection(value) : undefined;
  }

  async put(sessionId: string, sentenceId: string, correction: TranscriptCorrection): Promise<boolean> {
    const key = storageKey(sessionId, sentenceId);
    const current = this.values.get(key);
    if (!shouldStoreCorrection(current, correction)) return false;
    this.values.set(key, cloneCorrection(correction));
    return true;
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
      request.onsuccess = () => {
        const stored = request.result as StoredCorrection | undefined;
        resolve(stored ? normalizePersistedCorrection(stored.correction) : undefined);
      };
      request.onerror = () => reject(request.error ?? new Error('整文データの読み取りに失敗しました。'));
    });
  }

  async put(sessionId: string, sentenceId: string, correction: TranscriptCorrection): Promise<boolean> {
    const database = await this.database();
    return putStoredCorrection(database, sessionId, sentenceId, correction);
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 2);
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
  schemaVersion?: number;
}

export interface CorrectionCoordinatorCallbacks {
  onStatus?: (status: CorrectionServiceStatus) => void;
  onError?: (error: Error) => void;
}

export interface CorrectionCoordinatorOptions {
  glossary?: GlossaryEntry[];
  storage?: CorrectionStorage;
  policyVersion?: string;
  meetingId?: string;
  queueLimit?: number;
  maxAttempts?: number;
  createRequestId?: () => string;
  now?: () => number;
  setTimeout?: typeof window.setTimeout;
  clearTimeout?: typeof window.clearTimeout;
}

interface CorrectionJob {
  sentence: CompletedSentence;
  input: CorrectionInput;
  generation: number;
  requestId: string;
  attemptCount: number;
  key: string;
}

const DISABLED_STATUS: CorrectionServiceStatus = {
  enabled: false,
  provider: 'mock',
  model: 'deterministic-mock-v1',
  externalTransmission: false,
  timeoutMs: 8_000,
  concurrency: 1,
  maxInputChars: 4_000,
  removeFillers: false,
  correctionPolicyVersion: CORRECTION_POLICY_VERSION,
  queueLimit: CORRECTION_QUEUE_LIMIT,
  maxAttempts: CORRECTION_MAX_ATTEMPTS,
};

export class CorrectionCoordinator {
  private statusValue = DISABLED_STATUS;
  private initialized = false;
  private disposed = false;
  private generation = 0;
  private active = 0;
  private readonly candidates = new Map<string, CompletedSentence>();
  private readonly scheduled = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly queue: CorrectionJob[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly storage: CorrectionStorage;
  private readonly scheduleTimeout: typeof window.setTimeout;
  private readonly cancelTimeout: typeof window.clearTimeout;
  private readonly createRequestId: () => string;
  private readonly now: () => number;

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
    this.createRequestId = options.createRequestId ?? (() => globalThis.crypto?.randomUUID?.() ?? `correction-${Date.now()}`);
    this.now = options.now ?? Date.now;
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
    for (const sentence of this.candidates.values()) {
      if (sentence.correction?.status !== 'queued' && sentence.correction?.status !== 'processing') continue;
      this.apply(sentence, this.fallback(sentence, 'cancelled', sentence.correction.requestId, sentence.correction.attemptCount ?? 1, 'cancelled'));
    }
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.queue.length = 0;
  }

  retry(sentenceId: string): boolean {
    if (this.disposed || !this.initialized) return false;
    const sentence = this.candidates.get(sentenceId);
    if (!sentence || !isRetryableStatus(sentence.correction?.status)) return false;
    const attemptCount = Math.max(this.attempts.get(sentence.id) ?? 0, sentence.correction?.attemptCount ?? 0) + 1;
    if (attemptCount > this.maxAttempts()) return false;
    if (this.queue.some((job) => job.sentence.id === sentence.id) || [...this.controllers.keys()].some((key) => key.startsWith(`${sentence.id}:`))) return false;
    return this.enqueue(sentence, attemptCount);
  }

  private evaluateCandidates(): void {
    for (const sentence of this.candidates.values()) {
      const candidateKey = `${sentence.id}:${sentence.revision}`;
      if (this.scheduled.has(candidateKey) || isTerminalStatus(sentence.correction?.status)) continue;
      this.scheduled.add(candidateKey);
      if (!this.statusValue.enabled) {
        this.apply(sentence, createFallbackCorrection(sentence.rawText, 'disabled', sentence.rawSegmentIds, {
          provider: this.statusValue.provider,
          model: this.statusValue.model,
          segmentId: sentence.id,
          revision: sentence.revision,
          policyVersion: this.statusValue.correctionPolicyVersion,
        }));
        continue;
      }
      if (!sentence.rawText.trim()) {
        this.apply(sentence, createFallbackCorrection('', 'skipped', sentence.rawSegmentIds, {
          provider: this.statusValue.provider,
          model: this.statusValue.model,
          errorCode: 'empty_text',
          segmentId: sentence.id,
          revision: sentence.revision,
          policyVersion: this.statusValue.correctionPolicyVersion,
        }));
        continue;
      }
      const input = this.buildInput(sentence);
      if (!input) {
        this.apply(sentence, createFallbackCorrection(sentence.rawText, 'skipped', sentence.rawSegmentIds, {
          provider: this.statusValue.provider,
          model: this.statusValue.model,
          errorCode: 'input_too_long',
          segmentId: sentence.id,
          revision: sentence.revision,
          policyVersion: this.statusValue.correctionPolicyVersion,
        }));
        continue;
      }
      this.enqueue(sentence, 1, input);
    }
    this.pump();
  }

  private enqueue(sentence: CompletedSentence, attemptCount: number, preparedInput?: CorrectionInput): boolean {
    const input = preparedInput ?? this.buildInput(sentence);
    const requestId = this.createRequestId();
    if (!input) {
      this.apply(sentence, this.fallback(sentence, 'skipped', requestId, attemptCount, 'input_too_long'));
      return false;
    }
    const queueLimit = Math.max(1, Math.min(CORRECTION_QUEUE_LIMIT, this.options.queueLimit ?? this.statusValue.queueLimit));
    if (this.queue.length + this.active >= queueLimit) {
      this.apply(sentence, this.fallback(sentence, 'fallback', requestId, attemptCount, 'queue_full'));
      return false;
    }
    const key = `${sentence.id}:${sentence.revision}:${requestId}`;
    this.attempts.set(sentence.id, attemptCount);
    // Pending is an in-memory/public execution marker; persist only terminal
    // results so a worker cannot mistake its own pending write for a restore.
    this.apply(sentence, this.fallback(sentence, 'pending', requestId, attemptCount), false);
    this.queue.push({ sentence, input, generation: this.generation, requestId, attemptCount, key });
    this.pump();
    return true;
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
      // Yield once so queued/pending is observable before a worker marks the
      // request as processing; this also keeps enqueue independent from STT.
      await Promise.resolve();
      if (job.attemptCount === 1) {
        let saved: TranscriptCorrection | undefined;
        try {
          saved = await this.storage.get(this.sessionId, job.sentence.id);
        } catch {
          // Persistence is best-effort and must never stop correction/STT.
          saved = undefined;
        }
        if (saved && saved.rawText === job.sentence.rawText && (saved.revision ?? job.sentence.revision) === job.sentence.revision) {
          const persistedCompleted = saved.status === 'pending' && Boolean(saved.correctedText?.trim());
          const belongsToCurrentJob = !persistedCompleted && saved.requestId === job.requestId
            && (saved.status === 'queued' || saved.status === 'processing'
              || (saved.status === 'failed' && saved.errorCode === 'interrupted'));
          if (!belongsToCurrentJob) {
            const restored = persistedCompleted
              ? { ...saved, status: 'completed' as const }
              : saved.status === 'queued' || saved.status === 'processing'
              ? this.fallback(job.sentence, 'failed', saved.requestId, saved.attemptCount ?? 1, 'interrupted')
              : normalizePersistedCorrection(saved);
            if (this.isCurrent(job)) this.apply(job.sentence, restored);
            return;
          }
        }
      }
      const processing = this.fallback(job.sentence, 'processing', job.requestId, job.attemptCount);
      this.apply(job.sentence, processing);
      const controller = new AbortController();
      this.controllers.set(job.key, controller);
      const timer = this.scheduleTimeout(() => controller.abort(), this.statusValue.timeoutMs + 500);
      try {
        const correction = await this.client.correct({
          requestId: job.requestId,
          meetingId: this.options.meetingId ?? this.sessionId,
          sessionId: this.sessionId,
          segmentId: job.sentence.id,
          revision: job.sentence.revision,
          attemptCount: job.attemptCount,
          input: job.input,
        }, controller.signal);
        if (this.isCurrent(job)) this.apply(job.sentence, correction);
      } finally {
        this.cancelTimeout(timer);
        this.controllers.delete(job.key);
      }
    } catch (error) {
      if (!this.isCurrent(job)) return;
      const code = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'invalid_response';
      this.apply(job.sentence, this.fallback(job.sentence, 'failed', job.requestId, job.attemptCount, code));
      this.callbacks.onError?.(toError(error));
    }
  }

  private isCurrent(job: CorrectionJob): boolean {
    const current = this.candidates.get(job.sentence.id);
    return !this.disposed
      && job.generation === this.generation
      && job.sentence.sessionId === this.sessionId
      && current?.revision === job.sentence.revision
      && (this.attempts.get(job.sentence.id) ?? 0) === job.attemptCount;
  }

  private apply(sentence: CompletedSentence, correction: TranscriptCorrection, persist = true): void {
    if (!this.store.applyCorrection(this.sessionId, sentence.id, correction)) return;
    if (persist) void this.storage.put(this.sessionId, sentence.id, correction).catch((error) => this.callbacks.onError?.(toError(error)));
  }

  private fallback(
    sentence: CompletedSentence,
    status: Exclude<TranscriptCorrection['status'], 'completed'>,
    requestId: string | undefined,
    attemptCount: number,
    errorCode?: string,
  ): TranscriptCorrection {
    const timestamp = new Date(this.now()).toISOString();
    return createFallbackCorrection(sentence.rawText, status, sentence.rawSegmentIds, {
      provider: this.statusValue.provider,
      model: this.statusValue.model,
      errorCode,
      requestId,
      segmentId: sentence.id,
      revision: sentence.revision,
      attemptCount,
      policyVersion: this.options.policyVersion ?? this.statusValue.correctionPolicyVersion,
      createdAt: sentence.correction?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  private maxAttempts(): number {
    return Math.max(1, Math.min(CORRECTION_MAX_ATTEMPTS, this.options.maxAttempts ?? this.statusValue.maxAttempts));
  }
}

function validateResponse(value: unknown, request: CorrectionRequest): TranscriptCorrection {
  if (!value || typeof value !== 'object') throw new Error('整文レスポンスが不正です。');
  const record = value as Partial<TranscriptCorrection>;
  const input = request.input;
  if (record.rawText !== input.targetRawText || !Array.isArray(record.sourceSegmentIds)
    || record.sourceSegmentIds.join('\u0000') !== input.sourceSegmentIds.join('\u0000')
    || record.requestId !== request.requestId
    || record.segmentId !== request.segmentId
    || record.revision !== request.revision
    || record.attemptCount !== request.attemptCount
    || record.policyVersion !== input.correctionPolicyVersion
    || !isSafeLabel(record.provider)
    || !isSafeLabel(record.model)) {
    throw new Error('整文レスポンスの原文参照が一致しません。');
  }
  if (record.status === 'succeeded' || record.status === 'completed') {
    const validated = validateCorrectionOutput({
      correctedText: record.correctedText,
      changes: record.changes,
      uncertainParts: record.uncertainParts,
    }, input, { removeFillers: input.removeFillers });
    return {
      rawText: input.targetRawText,
      correctedText: validated.correctedText,
      status: record.status as 'succeeded' | 'completed',
      changes: validated.changes,
      uncertainParts: validated.uncertainParts,
      provider: record.provider,
      model: record.model,
      processingTimeMs: typeof record.processingTimeMs === 'number' ? record.processingTimeMs : undefined,
      sourceSegmentIds: [...input.sourceSegmentIds],
      requestId: request.requestId,
      segmentId: request.segmentId,
      revision: request.revision,
      attemptCount: request.attemptCount,
      policyVersion: input.correctionPolicyVersion,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    };
  }
  if (!['disabled', 'failed', 'cancelled', 'skipped', 'fallback'].includes(record.status ?? '')) {
    throw new Error('整文レスポンスのstatusが不正です。');
  }
  return createFallbackCorrection(input.targetRawText, record.status as Exclude<TranscriptCorrection['status'], 'completed'>, input.sourceSegmentIds, {
    provider: record.provider,
    model: record.model,
    processingTimeMs: typeof record.processingTimeMs === 'number' ? record.processingTimeMs : undefined,
    errorCode: safeFailureCode(record.errorCode),
    requestId: request.requestId,
    segmentId: request.segmentId,
    revision: request.revision,
    attemptCount: request.attemptCount,
    policyVersion: input.correctionPolicyVersion,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
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

function putStoredCorrection(
  database: IDBDatabase,
  sessionId: string,
  sentenceId: string,
  correction: TranscriptCorrection,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('corrections', 'readwrite');
    const store = transaction.objectStore('corrections');
    const key = storageKey(sessionId, sentenceId);
    const read = store.get(key);
    let result = false;
    read.onerror = () => reject(read.error ?? new Error('整文データの読み取りに失敗しました。'));
    read.onsuccess = () => {
      const current = (read.result as StoredCorrection | undefined)?.correction;
      if (!shouldStoreCorrection(current, correction)) return;
      result = true;
      store.put({
        key,
        sessionId,
        sentenceId,
        correction: cloneCorrection(correction),
        savedAt: new Date().toISOString(),
        schemaVersion: 2,
      } satisfies StoredCorrection);
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error('整文データの保存に失敗しました。'));
    transaction.onabort = () => reject(transaction.error ?? new Error('整文データの保存を中断しました。'));
  });
}

function normalizePersistedCorrection(correction: TranscriptCorrection): TranscriptCorrection {
  if (correction.status === 'completed' || correction.status === 'succeeded') return { ...cloneCorrection(correction), status: 'completed' };
  if (correction.status === 'pending') {
    return createFallbackCorrection(correction.rawText, 'failed', correction.sourceSegmentIds, {
      provider: correction.provider,
      model: correction.model,
      processingTimeMs: correction.processingTimeMs,
      errorCode: 'interrupted',
      requestId: correction.requestId,
      segmentId: correction.segmentId,
      revision: correction.revision,
      attemptCount: correction.attemptCount,
      policyVersion: correction.policyVersion,
      createdAt: correction.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }
  return cloneCorrection(correction);
}

function shouldStoreCorrection(current: TranscriptCorrection | undefined, next: TranscriptCorrection): boolean {
  if (!current) return true;
  const currentRevision = current.revision ?? 0;
  const nextRevision = next.revision ?? 0;
  if (nextRevision !== currentRevision) return nextRevision > currentRevision;
  const currentAttempt = current.attemptCount ?? 0;
  const nextAttempt = next.attemptCount ?? 0;
  if (nextAttempt !== currentAttempt) return nextAttempt > currentAttempt;
  if (current.requestId && next.requestId && current.requestId !== next.requestId) return false;
  return correctionStatusRank(next.status) > correctionStatusRank(current.status);
}

function correctionStatusRank(status: TranscriptCorrection['status']): number {
  switch (status) {
    case 'queued':
    case 'pending': return 1;
    case 'processing': return 2;
    case 'disabled':
    case 'failed':
    case 'cancelled':
    case 'skipped':
    case 'fallback': return 3;
    case 'succeeded':
    case 'completed': return 4;
  }
}

function isRetryableStatus(status: TranscriptCorrection['status'] | undefined): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'fallback';
}

function isTerminalStatus(status: TranscriptCorrection['status'] | undefined): boolean {
  return status === 'succeeded' || status === 'completed' || status === 'disabled' || status === 'skipped';
}

function isSafeLabel(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value);
}

const SAFE_FAILURE_CODES = new Set([
  'cancelled',
  'empty_text',
  'input_too_long',
  'interrupted',
  'invalid_response',
  'output_validation_failed',
  'protected_token_mismatch',
  'provider_unavailable',
  'queue_full',
  'stale_result',
  'timeout',
  'unknown_safe_failure',
]);

function safeFailureCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_FAILURE_CODES.has(value) ? value : 'unknown_safe_failure';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('整文処理に失敗しました。');
}
