import { SummaryProviderError, readBoundedJson, summaryInstructions, collectEvidenceIds, withAbort, isObject } from './summaryProviderCommon.js';
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

interface GroqUsage {
  meetingId: string;
  purpose: 'live_summary' | 'final_summary';
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GroqSummaryProviderOptions {
  apiKey?: string;
  liveModel?: string;
  finalModel?: string;
  maxInputBytes?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

export class GroqSummaryProvider implements SummaryProvider {
  private readonly fetch: typeof fetch;
  private readonly usages: GroqUsage[] = [];
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(private readonly options: GroqSummaryProviderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
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
      'final_meeting_summary',
      FINAL_SUMMARY_JSON_SCHEMA,
      { expectedVersion, liveSummary: input.liveSummary, completedSentences: input.sentences },
    );
    const summary = validateFinalMeetingSummary(value, allowedIds);
    if (summary.version !== expectedVersion) throw new Error('最終要約versionが期待値と一致しません。');
    return summary;
  }

  takeUsage(): GroqUsage[] {
    return this.usages.splice(0);
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
  }

  private async request(
    meetingId: string,
    purpose: GroqUsage['purpose'],
    model: string | undefined,
    schemaName: string,
    schema: object,
    input: object,
  ): Promise<unknown> {
    if (!this.options.apiKey) throw new SummaryProviderError('api_key_missing', 'Groq要約のAPIキーがサーバーに設定されていません。');
    if (model !== 'openai/gpt-oss-20b' && model !== 'openai/gpt-oss-120b') throw new SummaryProviderError('model_missing', '要約モデルがサーバーに設定されていません。');

    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > (this.options.maxInputBytes ?? 12_000)) throw new SummaryProviderError('summary_input_too_large', 'Groq要約へ送れる文章量の上限を超えています。文字起こしは保持しています。');

    if (this.disposed) throw new SummaryProviderError('summary_cancelled', '要約処理は終了しています。');
    if (this.controller) throw new SummaryProviderError('summary_busy', '別の要約処理を実行中です。');
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      return await withAbort(controller.signal, async () => {
        const response = await this.fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: summaryInstructions(purpose) },
              { role: 'user', content: JSON.stringify(input) },
            ],
            temperature: 0,
            reasoning_effort: 'low',
            stream: false,
            response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
            max_completion_tokens: this.options.maxOutputTokens ?? 2048,
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new SummaryProviderError(response.status === 429 ? 'rate_limited' : 'groq_request_failed', 'Groq要約APIを利用できませんでした。');
        }
        const payload = await readResponse(response, this.options.maxResponseBytes ?? 262_144);
        if (controller.signal.aborted) throw new Error('aborted');
        this.recordUsage(meetingId, purpose, model, payload.usage);
        if (payload.error != null) {
          throw new SummaryProviderError('incomplete_summary', '要約結果が完成していないため破棄しました。');
        }
        const outputText = extractOutputText(payload.choices);
        if (!outputText) throw new SummaryProviderError('invalid_summary', '要約結果を検証できなかったため破棄しました。');
        return JSON.parse(outputText) as unknown;
      });
    } catch (error) {
      if (controller.signal.aborted) throw new SummaryProviderError(this.disposed ? 'summary_cancelled' : 'summary_timeout', '要約処理を完了できませんでした。');
      if (error instanceof SummaryProviderError) throw error;
      throw new SummaryProviderError('invalid_summary', '要約結果を検証できなかったため破棄しました。');
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }

  private recordUsage(meetingId: string, purpose: GroqUsage['purpose'], model: string, usage?: GroqResponse['usage']): void {
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

interface GroqResponse {
  error?: unknown;
  choices?: unknown;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

function extractOutputText(choices: unknown): string | undefined {
  if (!Array.isArray(choices) || choices.length !== 1) return undefined;
  const choice = choices[0];
  if (!isObject(choice) || choice.finish_reason !== 'stop' || !isObject(choice.message)) return undefined;
  const message = choice.message;
  if (message.role !== 'assistant' || typeof message.content !== 'string' || message.refusal != null
    || message.tool_calls != null || message.function_call != null) return undefined;
  return message.content;
}

async function readResponse(response: Response, maxBytes: number): Promise<GroqResponse> {
  const data = await readBoundedJson(response, maxBytes);
  const rawUsage = data.usage;
  if (!isObject(rawUsage)) throw new Error('invalid usage');
  const usage: Record<string, unknown> = { input_tokens: rawUsage.prompt_tokens, output_tokens: rawUsage.completion_tokens, total_tokens: rawUsage.total_tokens };
  if (!isObject(usage) || !['input_tokens', 'output_tokens', 'total_tokens'].every((key) =>
    Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)
    || usage.total_tokens !== (usage.input_tokens as number) + (usage.output_tokens as number)) throw new Error('invalid usage');
  return { ...data, usage } as unknown as GroqResponse;
}
