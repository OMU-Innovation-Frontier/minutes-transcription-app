import type { WireLanguage } from '../../../../shared/protocol.js';
import { ServerProviderError } from '../types.js';
import type { PcmUtterance } from '../local/pcmUtteranceSegmenter.js';
import { createPcm16MonoWav } from './pcmToWav.js';
import { GroqWhisperClient, groqError } from './groqWhisperClient.js';
import { GroqWhisperUsageGuard } from './groqWhisperUsageGuard.js';

export interface GroqWhisperJob {
  sessionId: string;
  utteranceId: string;
  language: WireLanguage;
  utterance: PcmUtterance;
  createdAt: number;
  generation: number;
  onStarted(queueLength: number): void;
  onCompleted(result: { text: string; processingTimeMs: number; audioDurationMs: number; realTimeFactor: number }): void;
  onError(error: ServerProviderError): void;
}

export class GroqWhisperRuntime {
  private readonly queue: GroqWhisperJob[] = [];
  private readonly activeSessions = new Set<string>();
  private readonly pendingBySession = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly seenUtterances = new Set<string>();
  private running = 0;
  private closed = false;
  private authenticationFailed = false;

  constructor(
    private readonly client: GroqWhisperClient,
    private readonly usage: GroqWhisperUsageGuard,
    private readonly options: { maxConcurrency: number; maxQueueSize: number; maxSessions?: number; now?: () => number },
  ) {}

  get queueLength(): number { return this.queue.length + this.running; }

  registerSession(sessionId: string): void {
    if (this.closed) throw groqError('groq_runtime_closed', false);
    if (this.authenticationFailed) throw groqError('groq_auth_failed', false);
    this.client.assertConfigured();
    if (!this.activeSessions.has(sessionId) && this.activeSessions.size >= (this.options.maxSessions ?? Number.MAX_SAFE_INTEGER)) {
      throw groqError('groq_session_limit', false);
    }
    this.usage.beginSession(sessionId);
    this.activeSessions.add(sessionId);
  }

  unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    this.usage.endSession(sessionId);
    for (const utteranceId of this.seenUtterances) {
      if (utteranceId.startsWith(`${sessionId}:`)) this.seenUtterances.delete(utteranceId);
    }
  }

  enqueueMany(jobs: readonly GroqWhisperJob[]): void {
    if (this.closed || this.queue.length + jobs.length > this.options.maxQueueSize) throw groqError('groq_queue_limit', true);
    for (const job of jobs) {
      if (!this.activeSessions.has(job.sessionId)) throw groqError('groq_session_inactive', false);
      if (this.seenUtterances.has(job.utteranceId)) continue;
      this.seenUtterances.add(job.utteranceId);
      this.queue.push(job);
      this.pendingBySession.set(job.sessionId, (this.pendingBySession.get(job.sessionId) ?? 0) + 1);
    }
    queueMicrotask(() => this.drain());
  }

  waitForSession(sessionId: string): Promise<void> {
    if ((this.pendingBySession.get(sessionId) ?? 0) === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.waiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.waiters.set(sessionId, waiters);
    });
  }

  cancelSession(sessionId: string): void {
    for (const [id, controller] of this.controllers) if (id.startsWith(`${sessionId}:`)) controller.abort();
    const retained: GroqWhisperJob[] = [];
    for (const job of this.queue) {
      if (job.sessionId === sessionId) this.completePending(sessionId);
      else retained.push(job);
    }
    this.queue.splice(0, this.queue.length, ...retained);
    this.unregisterSession(sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const job of this.queue.splice(0)) this.completePending(job.sessionId);
    await Promise.all([...this.activeSessions].map((sessionId) => this.waitForSession(sessionId)));
    for (const sessionId of [...this.activeSessions]) this.unregisterSession(sessionId);
  }

  private drain(): void {
    while (!this.closed && this.running < this.options.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) return;
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        this.completePending(job.sessionId);
        this.drain();
      });
    }
  }

  private async run(job: GroqWhisperJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.utteranceId, controller);
    job.onStarted(this.queueLength);
    const startedAt = (this.options.now ?? Date.now)();
    try {
      if (this.authenticationFailed) throw groqError('groq_auth_failed', false);
      this.usage.reserve(job.sessionId, job.utterance.audioDurationMs);
      const text = await this.client.transcribe(createPcm16MonoWav(job.utterance.pcm), job.language, controller.signal);
      if (!this.activeSessions.has(job.sessionId) || controller.signal.aborted) return;
      const processingTimeMs = Math.max(0, (this.options.now ?? Date.now)() - startedAt);
      job.onCompleted({ text, processingTimeMs, audioDurationMs: job.utterance.audioDurationMs,
        realTimeFactor: processingTimeMs / job.utterance.audioDurationMs });
    } catch (error) {
      if (error instanceof ServerProviderError && error.code === 'groq_auth_failed') this.authenticationFailed = true;
      if (this.activeSessions.has(job.sessionId) && !controller.signal.aborted) {
        job.onError(error instanceof ServerProviderError ? error : groqError('groq_recognition_failed', true));
      }
    } finally {
      this.controllers.delete(job.utteranceId);
    }
  }

  private completePending(sessionId: string): void {
    const next = Math.max(0, (this.pendingBySession.get(sessionId) ?? 1) - 1);
    if (next) return void this.pendingBySession.set(sessionId, next);
    this.pendingBySession.delete(sessionId);
    for (const waiter of this.waiters.get(sessionId) ?? []) waiter();
    this.waiters.delete(sessionId);
  }
}
