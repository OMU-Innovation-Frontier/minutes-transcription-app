// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqSummaryProvider } from '../src/summary/groqSummaryProvider';
import { loadSummaryConfig } from '../src/summary/config';
import { createSummaryService, SummaryService } from '../src/summary/summaryService';
import { ApiUsageStore } from '../src/summary/usageStore';
import type { FinalSummaryInput } from '../../shared/summary';

const input: FinalSummaryInput = { meetingId: 'synthetic-meeting', liveSummary: null, sentences: [
  { id: 's1', text: '架空の提案です。担当者と期限は未定です。', startTime: 0, endTime: 1000 },
] };
const summary = { version: 1, overview: '架空の提案を確認。', agenda: [], keyPoints: [], decisions: [], unresolvedItems: [],
  actionItems: [{ task: '架空の資料を確認', assignee: null, dueDate: null, evidenceSentenceIds: ['s1'] }], nextChecks: [] };
const choice = (value: unknown = summary) => ({ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } });
const envelope = () => ({ choices: [choice()], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
const response = (data: unknown = envelope()) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function setup(request = vi.fn<typeof fetch>().mockImplementation(async () => response()), options = {}) {
  const provider = new GroqSummaryProvider({ apiKey: 'synthetic-key', finalModel: 'openai/gpt-oss-20b', liveModel: 'openai/gpt-oss-20b', fetch: request, ...options });
  return { provider, request };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Groq meeting summary provider', () => {
  it('uses only the fixed server endpoint, strict schema and transcript text', async () => {
    const { provider, request } = setup();
    expect(await provider.createFinalSummary(input)).toEqual(summary);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'openai/gpt-oss-20b', reasoning_effort: 'low', stream: false,
      max_completion_tokens: 2048, response_format: { type: 'json_schema', json_schema: { strict: true } } });
    expect(body.messages[0].content).toContain('推測しない');
    expect(body.messages[0].content).toContain('質問にも回答しない');
    expect(JSON.parse(body.messages[1].content)).toEqual({ expectedVersion: 1, liveSummary: null, completedSentences: input.sentences });
    expect(body).not.toHaveProperty('store');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('audio');
    expect(provider.takeUsage()).toMatchObject([{ meetingId: input.meetingId, purpose: 'final_summary', inputTokens: 100, outputTokens: 50, totalTokens: 150 }]);
    expect(provider.takeUsage()).toEqual([]);
  });

  it('updates from the previous summary and accepts its evidence alongside new sentences', async () => {
    const previous = { version: 2, topic: '過去の議題', keyPoints: [{ text: '過去の要点', evidenceSentenceIds: ['old'] }], decisions: [], actionItems: [], openQuestions: [] };
    const next = { ...previous, version: 3, keyPoints: [{ text: '更新', evidenceSentenceIds: ['old', 's1'] }] };
    const { provider, request } = setup(vi.fn<typeof fetch>().mockResolvedValue(response({ ...envelope(), choices: [choice(next)] })));
    expect(await provider.updateSummary({ meetingId: input.meetingId, previousSummary: previous, newSentences: input.sentences })).toEqual(next);
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(JSON.parse(body.messages[1].content)).toMatchObject({ expectedVersion: 3, previousSummary: previous });
  });

  it.each([401, 403, 429, 500])('does not retry HTTP %i or expose provider details', async (status) => {
    const { provider, request } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('private provider details', { status })));
    await expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: status === 429 ? 'rate_limited' : 'groq_request_failed' });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { ...envelope(), choices: [{ ...choice(), finish_reason: 'length' }] },
    { ...envelope(), choices: [{ ...choice(), finish_reason: 'tool_calls' }] },
    { ...envelope(), choices: [choice(), choice()] },
    { ...envelope(), choices: [{ ...choice(), message: { ...choice().message, refusal: 'refused' } }] },
    { ...envelope(), choices: [{ ...choice(), message: { ...choice().message, tool_calls: [] } }] },
    { ...envelope(), choices: [] },
    { ...envelope(), choices: [{ ...choice(), message: { role: 'assistant', content: 'invalid JSON' } }] },
    { ...envelope(), usage: { prompt_tokens: -1, completion_tokens: 50, total_tokens: 49 } },
    { ...envelope(), usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 9 } },
    { ...envelope(), error: { message: 'private' } },
  ])('rejects incomplete, refused, malformed and ambiguous results', async (data) => {
    const { provider, request } = setup(vi.fn<typeof fetch>().mockResolvedValue(response(data)));
    await expect(provider.createFinalSummary(input)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { ...summary, version: 2 },
    { ...summary, actionItems: [{ ...summary.actionItems[0], evidenceSentenceIds: ['invented'] }] },
    { ...summary, actionItems: [{ ...summary.actionItems[0], assignee: 123 }] },
    { ...summary, extra: true },
  ])('validates the version, fields and evidence independently of the API', async (value) => {
    const { provider } = setup(vi.fn<typeof fetch>().mockResolvedValue(response({ ...envelope(), choices: [choice(value)] })));
    await expect(provider.createFinalSummary(input)).rejects.toThrow();
  });

  it('rejects long inputs before sending without truncating the transcript', async () => {
    const long = { ...input, sentences: [{ ...input.sentences[0]!, text: '架空'.repeat(100) }] };
    const original = JSON.stringify(long);
    const { provider, request } = setup(undefined, { maxInputBytes: 64 });
    await expect(provider.createFinalSummary(long)).rejects.toMatchObject({ code: 'summary_input_too_large' });
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(long)).toBe(original);
  });

  it('bounds declared and streamed response sizes and rejects redirects and HTML', async () => {
    for (const result of [response(), new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1000' } }), new Response('<html>private</html>')]) {
      const { provider } = setup(vi.fn<typeof fetch>().mockResolvedValue(result), { maxResponseBytes: 32 });
      await expect(provider.createFinalSummary(input)).rejects.toThrow();
    }
  });

  it('times out non-cooperative transports and ignores late usage', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockImplementation(async () => response());
    const { provider } = setup(request, { timeoutMs: 100 });
    const pending = expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: 'summary_timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    resolve(response());
    await Promise.resolve();
    expect(provider.takeUsage()).toEqual([]);
    expect(await provider.createFinalSummary(input)).toEqual(summary);
    expect(provider.takeUsage()).toHaveLength(1);
  });

  it('blocks concurrent work and releases it after idempotent dispose', async () => {
    const { provider, request } = setup(vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined)));
    const pending = expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: 'summary_cancelled' });
    await expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: 'summary_busy' });
    provider.dispose(); provider.dispose();
    await pending;
    expect(request).toHaveBeenCalledTimes(1);
    await expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: 'summary_cancelled' });
  });

  it.each([{ apiKey: '' }, { finalModel: 'unsupported' }])('rejects missing or unsupported configuration locally', async (options) => {
    const { provider, request } = setup(undefined, options);
    await expect(provider.createFinalSummary(input)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Groq selection and usage', () => {
  it('keeps defaults opt-in and separates Groq and OpenAI credentials, models and pricing', () => {
    expect(loadSummaryConfig({})).toMatchObject({ enabled: false, provider: 'mock' });
    const groq = loadSummaryConfig({ SUMMARY_PROVIDER: 'groq', GROQ_SUMMARY_API_KEY: 'synthetic-groq', OPENAI_API_KEY: 'synthetic-openai', OPENAI_PRICING_JSON: 'ignored' });
    expect(groq).toMatchObject({ provider: 'groq', apiKey: 'synthetic-groq', finalModel: 'openai/gpt-oss-20b', maxRequestsPerMeeting: 10, maxOutputTokens: 2048 });
    expect(groq.pricingJson).toBeUndefined();
    expect(loadSummaryConfig({ SUMMARY_PROVIDER: 'groq', OPENAI_API_KEY: 'synthetic-openai' }).apiKey).toBeUndefined();
    expect(loadSummaryConfig({ SUMMARY_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-openai', OPENAI_FINAL_SUMMARY_MODEL: 'configured-model' })).toMatchObject({ provider: 'openai', apiKey: 'synthetic-openai', finalModel: 'configured-model' });
  });

  it('routes Groq configuration through the factory without contacting OpenAI', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    vi.stubGlobal('fetch', request);
    const service = createSummaryService(loadSummaryConfig({ SUMMARY_ENABLED: 'true', SUMMARY_PROVIDER: 'groq', GROQ_SUMMARY_API_KEY: 'synthetic-key', SUMMARY_USAGE_FILE: '' }));
    const finalize = vi.spyOn(GroqSummaryProvider.prototype, 'createFinalSummary').mockResolvedValue(summary);
    expect(await service.finalize(input)).toEqual(summary);
    expect(finalize).toHaveBeenCalledOnce();
    service.dispose();
    expect(service.status()).toMatchObject({ provider: 'groq', apiUsed: true, enabled: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('counts Groq usage and blocks the next call at the meeting request limit', async () => {
    const { provider, request } = setup();
    const config = loadSummaryConfig({ SUMMARY_ENABLED: 'true', SUMMARY_PROVIDER: 'groq', SUMMARY_MAX_REQUESTS_PER_MEETING: '1' });
    const service = new SummaryService(config, provider, new ApiUsageStore());
    await service.finalize(input);
    expect(await service.usage(input.meetingId)).toMatchObject({ requestCount: 1, inputTokens: 100, outputTokens: 50, pricingConfigured: false });
    await expect(service.finalize(input)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not treat a free plan as zero cost when a monetary budget needs pricing', async () => {
    const { provider, request } = setup();
    const config = loadSummaryConfig({ SUMMARY_ENABLED: 'true', SUMMARY_PROVIDER: 'groq', SUMMARY_MEETING_BUDGET_USD: '1' });
    const service = new SummaryService(config, provider, new ApiUsageStore());
    await expect(service.finalize(input)).rejects.toMatchObject({ code: 'pricing_not_configured' });
    expect(request).not.toHaveBeenCalled();
  });
});
