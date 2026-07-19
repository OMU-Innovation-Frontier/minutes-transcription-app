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

export class SummaryHttpClient {
  private readonly request: typeof fetch;

  constructor(
    private readonly baseUrl = import.meta.env.VITE_SERVER_HTTP_URL ?? 'http://127.0.0.1:8787',
    request: typeof fetch = window.fetch,
  ) {
    this.request = request.bind(window);
  }

  status(): Promise<SummaryStatus> {
    return this.get('/api/summary/status') as Promise<SummaryStatus>;
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
    const value = await response.json() as unknown;
    if (!response.ok) {
      const message = value && typeof value === 'object' && 'message' in value && typeof value.message === 'string'
        ? value.message
        : '要約サーバーとの通信に失敗しました。';
      throw new Error(message);
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
  private finalization: Promise<FinalMeetingSummary | null> | null = null;
  private finalSummary: FinalMeetingSummary | null = null;

  constructor(
    private readonly client: SummaryHttpClient,
    private readonly meetingId: string,
    private readonly batchSize: number,
    private readonly callbacks: SummaryCoordinatorCallbacks = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      try {
        this.statusValue = await this.client.status();
        this.callbacks.onStatus?.(this.statusValue);
      } catch (error) {
        this.callbacks.onError?.(toError(error));
      }
    })();
    return this.initialization;
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
      } catch (error) {
        this.callbacks.onError?.(toError(error));
      } finally {
        this.inFlight = null;
        if (this.pending.length > 0) this.schedule();
      }
    })();
    return this.inFlight;
  }

  async finalize(sentences: readonly CompletedSentence[]): Promise<FinalMeetingSummary | null> {
    await this.initialize();
    if (!this.statusValue.enabled) return null;
    if (this.finalSummary) return this.finalSummary;
    if (this.finalization) return this.finalization;
    const finalSentences = toUniqueSummarySentences(sentences);
    this.finalization = (async () => {
      try {
        const result = await this.client.finalize(this.meetingId, this.liveSummary, finalSentences);
        this.finalSummary = result;
        this.callbacks.onFinalSummary?.(result);
        this.callbacks.onUsage?.(await this.client.usage(this.meetingId));
        return result;
      } catch (error) {
        this.callbacks.onError?.(toError(error));
        return null;
      } finally {
        this.finalization = null;
      }
    })();
    return this.finalization;
  }

  dispose(): void {
    window.clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.flushLive();
    }, this.statusValue.intervalSeconds * 1_000);
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('要約処理に失敗しました。');
}
