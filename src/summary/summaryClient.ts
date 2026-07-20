import {
  validateFinalMeetingSummary,
  validateLiveMeetingSummary,
  type FinalMeetingSummary,
  type LiveMeetingSummary,
  type MeetingUsageSummary,
  type SummarySentence,
} from '../../shared/summary';
import type { CompletedSentence } from '../transcription/types';

export interface SummaryStatus {
  enabled: boolean;
  provider: 'mock' | 'openai';
  apiUsed: boolean;
  intervalSeconds: number;
}

export type SummaryFinalizationFailureReason = 'status_unavailable' | 'final_api_failed' | 'stale';

export type SummaryFinalizationResult =
  | { status: 'succeeded'; summary: FinalMeetingSummary }
  | { status: 'disabled' }
  | { status: 'failed'; reason: SummaryFinalizationFailureReason };

export class SummaryHttpClient {
  private readonly request: typeof fetch;

  constructor(
    private readonly baseUrl = import.meta.env.VITE_SERVER_HTTP_URL ?? 'http://127.0.0.1:8787',
    request: typeof fetch = window.fetch,
  ) {
    this.request = request.bind(window);
  }

  async status(): Promise<SummaryStatus> {
    return validateSummaryStatus(await this.get('/api/summary/status'));
  }

  async update(meetingId: string, previousSummary: LiveMeetingSummary | null, newSentences: SummarySentence[]): Promise<LiveMeetingSummary> {
    return validateLiveMeetingSummary(await this.post('/api/summary/live', { meetingId, previousSummary, newSentences }));
  }

  async finalize(meetingId: string, liveSummary: LiveMeetingSummary | null, sentences: SummarySentence[]): Promise<FinalMeetingSummary> {
    return validateFinalMeetingSummary(await this.post('/api/summary/final', { meetingId, liveSummary, sentences }));
  }

  usage(meetingId: string): Promise<MeetingUsageSummary> {
    return this.get(`/api/summary/usage?meetingId=${encodeURIComponent(meetingId)}`) as Promise<MeetingUsageSummary>;
  }

  private async get(path: string): Promise<unknown> {
    return this.parse(await this.request(`${this.baseUrl}${path}`));
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.parse(await this.request(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  private async parse(response: Response): Promise<unknown> {
    let value: unknown;
    try {
      value = await response.json() as unknown;
    } catch {
      throw new Error('要約サービスから有効な応答を受信できませんでした。');
    }
    if (!response.ok) {
      throw new Error(safeHttpErrorMessage(value));
    }
    return value;
  }
}

export interface SummaryCoordinatorCallbacks {
  onLiveSummary?: (summary: LiveMeetingSummary) => void;
  onFinalSummary?: (summary: FinalMeetingSummary) => void;
  onUsage?: (usage: MeetingUsageSummary) => void;
  onStatus?: (status: SummaryStatus) => void;
  onError?: (error: Error) => void;
}

export class IncrementalSummaryCoordinator {
  private statusValue: SummaryStatus = { enabled: false, provider: 'mock', apiUsed: false, intervalSeconds: 10 };
  private liveSummary: LiveMeetingSummary | null = null;
  private readonly sentIds = new Set<string>();
  private pending: SummarySentence[] = [];
  private timer: number | undefined;
  private inFlight: Promise<void> | null = null;
  private initialization: Promise<void> | null = null;
  private statusLoaded = false;
  private finalization: Promise<SummaryFinalizationResult> | null = null;
  private finalSummary: FinalMeetingSummary | null = null;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly client: SummaryHttpClient,
    private readonly meetingId: string,
    private readonly batchSize: number,
    private readonly callbacks: SummaryCoordinatorCallbacks = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.disposed || this.statusLoaded) return;
    if (this.initialization) return this.initialization;
    const generation = this.generation;
    const operation = (async () => {
      try {
        const status = await this.client.status();
        if (!this.isCurrent(generation)) return;
        this.statusValue = status;
        this.statusLoaded = true;
        this.callbacks.onStatus?.(status);
      } catch {
        if (this.isCurrent(generation)) this.callbacks.onError?.(safeSummaryError('status'));
      } finally {
        if (this.isCurrent(generation)) this.initialization = null;
      }
    })();
    this.initialization = operation;
    return operation;
  }

  add(sentences: readonly CompletedSentence[]): void {
    for (const sentence of sentences) {
      if (this.sentIds.has(sentence.id) || this.pending.some((item) => item.id === sentence.id)) continue;
      this.pending.push(toSummarySentence(sentence));
    }
    if (!this.statusValue.enabled || this.pending.length === 0) return;
    if (this.pending.length >= this.batchSize) void this.flushLive();
    else this.schedule();
  }

  async flushLive(): Promise<void> {
    if (!this.statusValue.enabled || this.pending.length === 0) return;
    if (this.inFlight) return this.inFlight;
    window.clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending];
    this.inFlight = (async () => {
      try {
        const result = await this.client.update(this.meetingId, this.liveSummary, batch);
        if (result.version <= (this.liveSummary?.version ?? 0)) throw new Error('古い要約versionを拒否しました。');
        this.liveSummary = result;
        for (const sentence of batch) this.sentIds.add(sentence.id);
        this.pending = this.pending.filter((sentence) => !this.sentIds.has(sentence.id));
        this.callbacks.onLiveSummary?.(result);
        this.callbacks.onUsage?.(await this.client.usage(this.meetingId));
      } catch {
        this.callbacks.onError?.(safeSummaryError('live'));
      } finally {
        this.inFlight = null;
        if (this.pending.length > 0) this.schedule();
      }
    })();
    return this.inFlight;
  }

  async finalize(sentences: readonly CompletedSentence[]): Promise<SummaryFinalizationResult> {
    const generation = this.generation;
    await this.initialize();
    if (!this.isCurrent(generation)) return { status: 'failed', reason: 'stale' };
    if (!this.statusLoaded) return { status: 'failed', reason: 'status_unavailable' };
    if (!this.statusValue.enabled) return { status: 'disabled' };
    if (this.finalSummary) return { status: 'succeeded', summary: this.finalSummary };
    if (this.finalization) return this.finalization;
    const finalSentences = toUniqueSummarySentences(sentences);
    const operation = (async (): Promise<SummaryFinalizationResult> => {
      try {
        const result = await this.client.finalize(this.meetingId, this.liveSummary, finalSentences);
        if (!this.isCurrent(generation)) return { status: 'failed', reason: 'stale' };
        this.finalSummary = result;
        this.callbacks.onFinalSummary?.(result);
        try {
          this.callbacks.onUsage?.(await this.client.usage(this.meetingId));
        } catch {
          if (this.isCurrent(generation)) this.callbacks.onError?.(safeSummaryError('usage'));
        }
        return { status: 'succeeded', summary: result };
      } catch {
        if (this.isCurrent(generation)) this.callbacks.onError?.(safeSummaryError('final'));
        return { status: 'failed', reason: this.isCurrent(generation) ? 'final_api_failed' : 'stale' };
      } finally {
        if (this.isCurrent(generation)) this.finalization = null;
      }
    })();
    this.finalization = operation;
    return operation;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    window.clearTimeout(this.timer);
    this.initialization = null;
    this.finalization = null;
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.flushLive();
    }, this.statusValue.intervalSeconds * 1_000);
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
}

export function toSummarySentence(sentence: CompletedSentence): SummarySentence {
  const correction = sentence.correction;
  const text = correction && (correction.status === 'completed' || correction.status === 'succeeded')
    && correction.correctedText.trim()
    ? correction.correctedText
    : sentence.rawText;
  return { id: sentence.id, text, startTime: sentence.startTime, endTime: sentence.endTime };
}

export function toUniqueSummarySentences(sentences: readonly CompletedSentence[]): SummarySentence[] {
  const seen = new Set<string>();
  const result: SummarySentence[] = [];
  for (const sentence of sentences) {
    if (seen.has(sentence.id)) continue;
    seen.add(sentence.id);
    result.push(toSummarySentence(sentence));
  }
  return result;
}

function validateSummaryStatus(value: unknown): SummaryStatus {
  if (!value || typeof value !== 'object') throw new Error('要約機能の状態を確認できませんでした。');
  const candidate = value as Partial<SummaryStatus>;
  if (typeof candidate.enabled !== 'boolean'
    || (candidate.provider !== 'mock' && candidate.provider !== 'openai')
    || typeof candidate.apiUsed !== 'boolean'
    || typeof candidate.intervalSeconds !== 'number'
    || !Number.isFinite(candidate.intervalSeconds)
    || candidate.intervalSeconds <= 0) {
    throw new Error('要約機能の状態を確認できませんでした。');
  }
  return {
    enabled: candidate.enabled,
    provider: candidate.provider,
    apiUsed: candidate.apiUsed,
    intervalSeconds: candidate.intervalSeconds,
  };
}

function safeHttpErrorMessage(value: unknown): string {
  const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
    ? value.code
    : '';
  if (code === 'summary_disabled') return '要約機能は現在無効です。';
  if (code === 'invalid_request') return '要約に必要な情報を確認できませんでした。';
  if (code === 'budget_exceeded') return '要約処理を現在実行できません。';
  return '要約サービスとの通信に失敗しました。';
}

function safeSummaryError(phase: 'status' | 'live' | 'final' | 'usage'): Error {
  if (phase === 'status') return new Error('要約機能の状態を確認できませんでした。');
  if (phase === 'live') return new Error('ライブ要約を更新できませんでした。');
  if (phase === 'usage') return new Error('要約の利用状況を確認できませんでした。');
  return new Error('最終要約を作成できませんでした。');
}
