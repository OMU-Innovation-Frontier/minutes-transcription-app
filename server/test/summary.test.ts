// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  validateLiveMeetingSummary,
  type ApiUsageRecord,
  type IncrementalSummaryInput,
  type LiveMeetingSummary,
  type SummaryProvider,
} from '../../shared/summary';
import type { SummaryConfig } from '../src/summary/config';
import { MockSummaryProvider } from '../src/summary/mockSummaryProvider';
import { OpenAISummaryProvider } from '../src/summary/openAISummaryProvider';
import { SummaryService } from '../src/summary/summaryService';
import { ApiUsageStore } from '../src/summary/usageStore';

const input: IncrementalSummaryInput = {
  meetingId: 'meeting-1',
  previousSummary: null,
  newSentences: [{ id: 'sentence-1', text: '新しい完成文です。', startTime: 0, endTime: 1_000 }],
};

describe('summary providers and budgets', () => {
  it('runs the mock summary provider without an API key', async () => {
    const service = new SummaryService(config({ provider: 'mock' }), new MockSummaryProvider(), new ApiUsageStore());
    const result = await service.update(input);
    expect(result).toMatchObject({ version: 1, keyPoints: [{ evidenceSentenceIds: ['sentence-1'] }] });
    expect((await service.usage('meeting-1')).requestCount).toBe(0);
  });

  it('extracts only explicitly marked TODOs without inventing an assignee or due date', async () => {
    const provider = new MockSummaryProvider();
    const result = await provider.createFinalSummary({
      meetingId: 'meeting-1',
      liveSummary: null,
      sentences: [
        { id: 'sentence-1', text: 'TODO: 人工データを確認する', startTime: 0, endTime: 1 },
        { id: 'sentence-2', text: '通常の確定済み発話', startTime: 1, endTime: 2 },
      ],
    });
    expect(result.actionItems).toEqual([{
      task: '人工データを確認する',
      assignee: null,
      dueDate: null,
      evidenceSentenceIds: ['sentence-1'],
    }]);
  });

  it('rejects summary items that do not contain evidence sentence IDs', () => {
    expect(() => validateLiveMeetingSummary({
      version: 1, topic: null, keyPoints: [{ text: '根拠なし', evidenceSentenceIds: [] }],
      decisions: [], actionItems: [], openQuestions: [],
    })).toThrow('根拠文ID');
  });

  it('uses structured Responses API output and records usage without sending audio', async () => {
    const responseSummary: LiveMeetingSummary = {
      version: 1,
      topic: 'テスト',
      keyPoints: [{ text: '新しい完成文です。', evidenceSentenceIds: ['sentence-1'] }],
      decisions: [], actionItems: [], openQuestions: [],
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify(responseSummary),
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new OpenAISummaryProvider({
      apiKey: 'server-only-test-key', liveModel: 'configured-live-model', finalModel: 'configured-final-model',
      liveReasoningEffort: 'low', finalReasoningEffort: 'medium', maxOutputTokens: 500, fetch: request,
    });
    const service = new SummaryService(config({
      provider: 'openai', liveModel: 'configured-live-model', finalModel: 'configured-final-model',
      pricingJson: JSON.stringify({
        'configured-live-model': { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
      }),
    }), provider, new ApiUsageStore());

    await service.update(input);
    const body = JSON.parse(String(vi.mocked(request).mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'configured-live-model', reasoning: { effort: 'low' }, max_output_tokens: 500, store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(String(body.input)).toContain('newCompletedSentences');
    expect(String(body.input)).not.toContain('audio');
    expect(String(body)).not.toContain('server-only-test-key');
    expect(await service.usage('meeting-1')).toMatchObject({ inputTokens: 20, outputTokens: 10, totalTokens: 30, requestCount: 1 });
  });

  it('stops new summary calls at the meeting request limit', async () => {
    const usageStore = new ApiUsageStore();
    const record: ApiUsageRecord = {
      meetingId: 'meeting-1', purpose: 'live_summary', provider: 'openai', model: 'configured-live-model',
      inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0.001, createdAt: new Date().toISOString(),
    };
    await usageStore.append(record);
    const provider = new MockSummaryProvider();
    const update = vi.spyOn(provider, 'updateSummary');
    const service = new SummaryService(config({
      provider: 'openai', maxRequestsPerMeeting: 1, liveModel: 'configured-live-model',
    }), provider, usageStore);
    await expect(service.update(input)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an older summary version', async () => {
    const staleProvider: SummaryProvider = {
      updateSummary: async () => ({
        version: 1, topic: null, keyPoints: [], decisions: [], actionItems: [], openQuestions: [],
      }),
      createFinalSummary: async () => ({
        version: 1, overview: '', agenda: [], keyPoints: [], decisions: [], unresolvedItems: [], actionItems: [], nextChecks: [],
      }),
    };
    const service = new SummaryService(config({ provider: 'mock' }), staleProvider, new ApiUsageStore());
    await expect(service.update({ ...input, previousSummary: {
      version: 1, topic: null, keyPoints: [], decisions: [], actionItems: [], openQuestions: [],
    } })).rejects.toMatchObject({ code: 'stale_summary' });
  });
});

function config(overrides: Partial<SummaryConfig> = {}): SummaryConfig {
  return {
    enabled: true,
    provider: 'mock',
    liveReasoningEffort: 'low',
    finalReasoningEffort: 'medium',
    intervalSeconds: 10,
    stopOnBudgetExceeded: true,
    ...overrides,
  };
}
