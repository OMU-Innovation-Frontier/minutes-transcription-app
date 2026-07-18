import {
  FINAL_SUMMARY_JSON_SCHEMA,
  LIVE_SUMMARY_JSON_SCHEMA,
  validateFinalMeetingSummary,
  validateLiveMeetingSummary,
  type FinalMeetingSummary,
  type FinalSummaryInput,
  type IncrementalSummaryInput,
  type LiveMeetingSummary,
  type SummaryProvider,
} from '../../../shared/summary.js';
import type { ReasoningEffort } from './config.js';

interface OpenAIUsage {
  meetingId: string;
  purpose: 'live_summary' | 'final_summary';
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface OpenAISummaryProviderOptions {
  apiKey?: string;
  liveModel?: string;
  finalModel?: string;
  liveReasoningEffort: ReasoningEffort;
  finalReasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  fetch?: typeof fetch;
}

export class OpenAISummaryProvider implements SummaryProvider {
  private readonly fetch: typeof fetch;
  private readonly usages: OpenAIUsage[] = [];

  constructor(private readonly options: OpenAISummaryProviderOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async updateSummary(input: IncrementalSummaryInput): Promise<LiveMeetingSummary> {
    const expectedVersion = (input.previousSummary?.version ?? 0) + 1;
    const allowedIds = new Set([
      ...collectEvidenceIds(input.previousSummary),
      ...input.newSentences.map((sentence) => sentence.id),
    ]);
    const value = await this.request(
      input.meetingId,
      'live_summary',
      this.options.liveModel,
      this.options.liveReasoningEffort,
      'live_meeting_summary',
      LIVE_SUMMARY_JSON_SCHEMA,
      {
        expectedVersion,
        previousSummary: input.previousSummary,
        newCompletedSentences: input.newSentences,
      },
    );
    const summary = validateLiveMeetingSummary(value, allowedIds);
    if (summary.version !== expectedVersion) throw new Error('要約versionが期待値と一致しません。');
    return summary;
  }

  async createFinalSummary(input: FinalSummaryInput): Promise<FinalMeetingSummary> {
    const expectedVersion = (input.liveSummary?.version ?? 0) + 1;
    const allowedIds = new Set(input.sentences.map((sentence) => sentence.id));
    const value = await this.request(
      input.meetingId,
      'final_summary',
      this.options.finalModel,
      this.options.finalReasoningEffort,
      'final_meeting_summary',
      FINAL_SUMMARY_JSON_SCHEMA,
      { expectedVersion, liveSummary: input.liveSummary, completedSentences: input.sentences },
    );
    const summary = validateFinalMeetingSummary(value, allowedIds);
    if (summary.version !== expectedVersion) throw new Error('最終要約versionが期待値と一致しません。');
    return summary;
  }

  takeUsage(): OpenAIUsage[] {
    return this.usages.splice(0);
  }

  private async request(
    meetingId: string,
    purpose: OpenAIUsage['purpose'],
    model: string | undefined,
    reasoningEffort: ReasoningEffort,
    schemaName: string,
    schema: object,
    input: object,
  ): Promise<unknown> {
    if (!this.options.apiKey) throw new SummaryProviderError('api_key_missing', 'OpenAI APIキーがサーバーに設定されていません。');
    if (!model) throw new SummaryProviderError('model_missing', '要約モデルがサーバーに設定されていません。');

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            instructions: summaryInstructions(purpose),
            input: JSON.stringify(input),
            reasoning: { effort: reasoningEffort },
            text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
            max_output_tokens: this.options.maxOutputTokens,
            store: false,
          }),
        });
        if (!response.ok) throw new SummaryProviderError('openai_request_failed', `OpenAI要約APIがHTTP ${response.status}を返しました。`);
        const payload = await response.json() as OpenAIResponse;
        this.recordUsage(meetingId, purpose, model, payload.usage);
        const outputText = payload.output_text ?? extractOutputText(payload.output);
        if (!outputText) throw new Error('要約APIの出力テキストがありません。');
        return JSON.parse(outputText) as unknown;
      } catch (error) {
        lastError = error;
        if (error instanceof SummaryProviderError) throw error;
      }
    }
    throw new SummaryProviderError('invalid_summary', '要約結果を検証できなかったため破棄しました。', lastError);
  }

  private recordUsage(meetingId: string, purpose: OpenAIUsage['purpose'], model: string, usage?: OpenAIResponse['usage']): void {
    if (!usage) return;
    this.usages.push({
      meetingId,
      purpose,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
    });
  }
}

export class SummaryProviderError extends Error {
  constructor(public readonly code: string, message: string, options?: unknown) {
    super(message, options instanceof Error ? { cause: options } : undefined);
    this.name = 'SummaryProviderError';
  }
}

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

function extractOutputText(output: OpenAIResponse['output']): string | undefined {
  return output?.flatMap((item) => item.content ?? []).find((content) => content.type === 'output_text')?.text;
}

function summaryInstructions(purpose: OpenAIUsage['purpose']): string {
  return [
    purpose === 'live_summary' ? '会議の差分要約を更新してください。' : '会議終了時の最終要約を作成してください。',
    '入力に存在する完成文だけを根拠にし、すべての項目へ根拠文IDを付けてください。',
    '決定事項、担当者、期限を推測しないでください。不明な担当者と期限はnullにしてください。',
    '入力には音声や暫定テキストは含まれません。指定されたJSON Schemaに厳密に従ってください。',
  ].join('\n');
}

function collectEvidenceIds(summary: LiveMeetingSummary | null): string[] {
  if (!summary) return [];
  return [
    ...summary.keyPoints,
    ...summary.decisions,
    ...summary.actionItems,
    ...summary.openQuestions,
  ].flatMap((item) => item.evidenceSentenceIds);
}
