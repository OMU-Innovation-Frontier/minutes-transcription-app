import {
  validateFinalMeetingSummary,
  validateLiveMeetingSummary,
  type ApiUsageRecord,
  type FinalMeetingSummary,
  type FinalSummaryInput,
  type IncrementalSummaryInput,
  type LiveMeetingSummary,
  type MeetingUsageSummary,
  type SummaryProvider,
} from '../../../shared/summary.js';
import type { SummaryConfig } from './config.js';
import { MockSummaryProvider } from './mockSummaryProvider.js';
import { OpenAISummaryProvider } from './openAISummaryProvider.js';
import { estimateCostUsd, parsePricingTable } from './pricing.js';
import { ApiUsageStore } from './usageStore.js';

export class SummaryService {
  private readonly pricing;

  constructor(
    private readonly config: SummaryConfig,
    private readonly provider: SummaryProvider,
    private readonly usageStore: ApiUsageStore,
  ) {
    this.pricing = parsePricingTable(config.pricingJson);
  }

  async update(input: IncrementalSummaryInput): Promise<LiveMeetingSummary> {
    this.validateEnabled();
    if (input.newSentences.length === 0) throw new SummaryServiceError('no_new_sentences', '新しい完成文がありません。', 400);
    await this.checkBudget(input.meetingId, this.config.liveModel);
    let summary: LiveMeetingSummary;
    try {
      summary = await this.provider.updateSummary(input);
    } finally {
      await this.persistProviderUsage();
    }
    const allowed = new Set([
      ...input.newSentences.map((sentence) => sentence.id),
      ...collectPreviousEvidence(input.previousSummary),
    ]);
    validateLiveMeetingSummary(summary, allowed);
    if (summary.version <= (input.previousSummary?.version ?? 0)) {
      throw new SummaryServiceError('stale_summary', '古い要約versionを拒否しました。', 409);
    }
    return summary;
  }

  async finalize(input: FinalSummaryInput): Promise<FinalMeetingSummary> {
    this.validateEnabled();
    await this.checkBudget(input.meetingId, this.config.finalModel);
    let summary: FinalMeetingSummary;
    try {
      summary = await this.provider.createFinalSummary(input);
    } finally {
      await this.persistProviderUsage();
    }
    validateFinalMeetingSummary(summary, new Set(input.sentences.map((sentence) => sentence.id)));
    return summary;
  }

  async usage(meetingId: string): Promise<MeetingUsageSummary> {
    return this.usageStore.meetingSummary(meetingId);
  }

  status(): { enabled: boolean; provider: 'mock' | 'openai'; apiUsed: boolean; intervalSeconds: number } {
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      apiUsed: this.config.enabled && this.config.provider === 'openai',
      intervalSeconds: this.config.intervalSeconds,
    };
  }

  private validateEnabled(): void {
    if (!this.config.enabled) throw new SummaryServiceError('summary_disabled', '要約はサーバー設定で無効です。', 409);
  }

  private async checkBudget(meetingId: string, model: string | undefined): Promise<void> {
    if (this.config.provider !== 'openai') return;
    const usage = await this.usageStore.meetingSummary(meetingId);
    if (this.config.maxRequestsPerMeeting !== undefined && usage.requestCount >= this.config.maxRequestsPerMeeting) {
      this.throwBudget('会議あたりのAPI呼び出し回数上限に達しました。');
    }
    const hasMoneyBudget = this.config.meetingBudgetUsd !== undefined || this.config.monthlyBudgetUsd !== undefined;
    if (hasMoneyBudget && (!model || !this.pricing[model])) {
      throw new SummaryServiceError('pricing_not_configured', '価格設定未登録のため、金額上限を安全に判定できません。', 409);
    }
    if (this.config.meetingBudgetUsd !== undefined && (usage.estimatedCostUsd ?? 0) >= this.config.meetingBudgetUsd) {
      this.throwBudget('会議単位の要約予算上限に達しました。');
    }
    if (this.config.monthlyBudgetUsd !== undefined && await this.usageStore.monthlyEstimatedCost() >= this.config.monthlyBudgetUsd) {
      this.throwBudget('月単位の要約予算上限に達しました。');
    }
  }

  private throwBudget(message: string): void {
    if (this.config.stopOnBudgetExceeded) throw new SummaryServiceError('budget_exceeded', message, 429);
  }

  private async persistProviderUsage(): Promise<void> {
    if (!(this.provider instanceof OpenAISummaryProvider)) return;
    for (const usage of this.provider.takeUsage()) {
      const record: ApiUsageRecord = {
        meetingId: usage.meetingId,
        purpose: usage.purpose,
        provider: 'openai',
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        estimatedCostUsd: estimateCostUsd(this.pricing, usage.model, usage.inputTokens, usage.outputTokens),
        createdAt: new Date().toISOString(),
      };
      await this.usageStore.append(record);
    }
  }
}

export function createSummaryService(config: SummaryConfig): SummaryService {
  const provider = config.provider === 'openai'
    ? new OpenAISummaryProvider({
        apiKey: config.apiKey,
        liveModel: config.liveModel,
        finalModel: config.finalModel,
        liveReasoningEffort: config.liveReasoningEffort,
        finalReasoningEffort: config.finalReasoningEffort,
        maxOutputTokens: config.maxOutputTokens,
      })
    : new MockSummaryProvider();
  return new SummaryService(config, provider, new ApiUsageStore(config.usageFile));
}

export class SummaryServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'SummaryServiceError';
  }
}

function collectPreviousEvidence(summary: LiveMeetingSummary | null): string[] {
  if (!summary) return [];
  return [...summary.keyPoints, ...summary.decisions, ...summary.actionItems, ...summary.openQuestions]
    .flatMap((item) => item.evidenceSentenceIds);
}
