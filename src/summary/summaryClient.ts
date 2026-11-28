import { serverHttpUrl } from '../serverLocation';
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
  provider: 'mock' | 'openai' | 'groq';
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
    private readonly baseUrl = serverHttpUrl(),
    request: typeof fetch = window.fetch,
    private readonly provider?: 'openai',
  ) {
    this.request = request.bind(window);
  }

  async status(): Promise<SummaryStatus> {
    return validateSummaryStatus(await this.get('/api/summary/status'));
  }

  async update(meetingId: string, previousSummary: LiveMeetingSummary | null, newSentences: SummarySentence[], expectedProvider?: SummaryStatus['provider']): Promise<LiveMeetingSummary> {
    return validateLiveMeetingSummary(await this.post('/api/summary/live', { meetingId, previousSummary, newSentences }, expectedProvider));
  }

  async finalize(meetingId: string, liveSummary: LiveMeetingSummary | null, sentences: SummarySentence[], expectedProvider?: SummaryStatus['provider']): Promise<FinalMeetingSummary> {
    return validateFinalMeetingSummary(await this.post('/api/summary/final', { meetingId, liveSummary, sentences }, expectedProvider));
  }

  usage(meetingId: string): Promise<MeetingUsageSummary> {
    return this.get(`/api/summary/usage?meetingId=${encodeURIComponent(meetingId)}`) as Promise<MeetingUsageSummary>;
  }

  private async get(path: string): Promise<unknown> {
    return this.parse(await this.request(this.endpoint(path)));
  }

  private async post(path: string, body: unknown, expectedProvider?: SummaryStatus['provider']): Promise<unknown> {
    return this.parse(await this.request(this.endpoint(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(expectedProvider ? { 'x-summary-provider': expectedProvider } : {}) },
      body: JSON.stringify(body),
    }));
  }

  private endpoint(path: string): string {
    const query = this.provider ? `${path.includes('?') ? '&' : '?'}provider=${this.provider}` : '';
    return `${this.baseUrl}${path}${query}`;
  }

  private async parse(response: Response): Promise<unknown> {
    let value: unknown;
    try {
      value = await response.json() as unknown;
    } catch {
      throw new Error('要約サービスから有効な応答を受信できませんでした。');
    }
    if (!response.ok) {
      throw new SummaryRequestError(safeHttpErrorMessage(value));
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
    private readonly allowExternalTransmission = false,
    private readonly automatic = true,
    private readonly expectedExternalProvider?: SummaryStatus['provider'],
  ) {}

  async initialize(): Promise<void> {
    if (this.disposed || this.statusLoaded) return;
    if (this.initialization) return this.initialization;
    const generation = this.generation;
    const operation = (async () => {
      try {
        const status = await this.client.status();
        if (!this.isCurrent(generation)) return;
        if (status.apiUsed && this.expectedExternalProvider && status.provider !== this.expectedExternalProvider) throw new Error('要約先が変更されています。会議設定を確認してください。');
        if (status.apiUsed && !this.allowExternalTransmission) throw new Error('外部要約への同意がありません。');
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
    if (this.disposed) return;
    for (const sentence of sentences) {
      if (this.sentIds.has(sentence.id) || this.pending.some((item) => item.id === sentence.id)) continue;
      this.pending.push(toSummarySentence(sentence));
    }
    if (!this.automatic || !this.statusValue.enabled || this.pending.length === 0) return;
    if (this.pending.length >= this.batchSize) void this.flushLive();
    else this.schedule();
  }

  get busy(): boolean { return this.inFlight !== null; }

  hasNewSentences(sentences: readonly CompletedSentence[]): boolean {
    return sentences.some((sentence) => !this.sentIds.has(sentence.id));
  }

  async waitForLive(): Promise<void> { await this.inFlight; }

  async flushLive(): Promise<void> {
    if (this.disposed || this.pending.length === 0) return;
    const generation = this.generation;
    if (this.inFlight) return this.inFlight;
    window.clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending];
    this.inFlight = (async () => {
      try {
        await this.initialize();
        if (!this.isCurrent(generation) || !this.statusValue.enabled) return;
        const result = await this.client.update(this.meetingId, this.liveSummary, batch, this.statusValue.provider);
        if (!this.isCurrent(generation)) return;
        if (result.version <= (this.liveSummary?.version ?? 0)) throw new Error('古い要約versionを拒否しました。');
        this.liveSummary = result;
        for (const sentence of batch) this.sentIds.add(sentence.id);
        this.pending = this.pending.filter((sentence) => !this.sentIds.has(sentence.id));
        this.callbacks.onLiveSummary?.(result);
        const usage = await this.client.usage(this.meetingId);
        if (this.isCurrent(generation)) this.callbacks.onUsage?.(usage);
      } catch (error) {
        if (this.isCurrent(generation)) this.callbacks.onError?.(error instanceof SummaryRequestError ? error : safeSummaryError('live'));
      } finally {
        this.inFlight = null;
        if (this.isCurrent(generation) && this.automatic && this.pending.length > 0) this.schedule();
      }
    })();
    return this.inFlight;
  }

  async finalize(sentences: readonly CompletedSentence[], liveSummary = this.liveSummary): Promise<SummaryFinalizationResult> {
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
        const result = await this.client.finalize(this.meetingId, liveSummary, finalSentences, this.statusValue.provider);
        if (!this.isCurrent(generation)) return { status: 'failed', reason: 'stale' };
        this.finalSummary = result;
        this.callbacks.onFinalSummary?.(result);
        try {
          this.callbacks.onUsage?.(await this.client.usage(this.meetingId));
        } catch {
          if (this.isCurrent(generation)) this.callbacks.onError?.(safeSummaryError('usage'));
        }
        return { status: 'succeeded', summary: result };
      } catch (error) {
        if (this.isCurrent(generation)) this.callbacks.onError?.(error instanceof SummaryRequestError ? error : safeSummaryError('final'));
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
  return { id: sentence.id, text, startTime: sentence.startTime, endTime: sentence.endTime,
    ...(sentence.speakerLabel ? { speakerLabel: sentence.speakerLabel } : {}),
    ...(sentence.speakerName ? { speakerName: sentence.speakerName } : {}) };
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
    || (candidate.provider !== 'mock' && candidate.provider !== 'openai' && candidate.provider !== 'groq')
    || typeof candidate.apiUsed !== 'boolean'
    || candidate.apiUsed !== (candidate.enabled && candidate.provider !== 'mock')
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

class SummaryRequestError extends Error {}

function safeHttpErrorMessage(value: unknown): string {
  const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
    ? value.code
    : '';
  if (code === 'access_required') return '入室の有効期限を確認してください。ページを開き直して合言葉を入力してください。';
  if (code === 'access_daily_limit') return '今日の利用上限に達しました。文字起こし履歴は保持しています。';
  if (code === 'access_busy') return 'ほかの処理が進行中です。しばらく待ってから再試行してください。';
  if (code === 'summary_provider_changed') return '要約先が変更されています。会議設定を開き直して送信先を確認してください。';
  if (code === 'summary_input_too_large') return '要約対象が長すぎます。文字起こしは保持しています。要約の入力上限と設定を確認してください。';
  if (code === 'summary_rate_limited') return '要約サービスの利用制限に達しました。時間をおいて手動で再試行してください。';
  if (code === 'summary_disabled') return '要約機能は現在無効です。';
  if (code === 'text_model_unavailable') return '選択した要約モデルを利用できません。';
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
