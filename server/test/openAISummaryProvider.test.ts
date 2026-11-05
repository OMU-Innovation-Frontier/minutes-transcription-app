// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAISummaryProvider } from '../src/summary/openAISummaryProvider';
import { validateFinalMeetingSummary, type FinalSummaryInput } from '../../shared/summary';

const input: FinalSummaryInput = { meetingId: 'synthetic-meeting', liveSummary: null, sentences: [
  { id: 's1', text: 'テストの予算は125000円です。担当と期限は未定です。', startTime: 0, endTime: 1000 },
] };
const summary = { version: 1, overview: 'テストの予算を確認。', agenda: [], keyPoints: [], decisions: [], unresolvedItems: [],
  actionItems: [{ task: 'テスト資料を確認する', assignee: null, dueDate: null, evidenceSentenceIds: ['s1'] }], nextChecks: [] };
const message = (value: unknown = summary) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] });
const envelope = () => ({ status: 'completed', output: [message()], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } });
const response = (data: unknown = envelope()) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function setup(request = vi.fn<typeof fetch>().mockImplementation(async () => response()), options = {}) {
  const provider = new OpenAISummaryProvider({ apiKey: 'synthetic-key', finalModel: 'configured-final-model', liveModel: 'configured-live-model',
    liveReasoningEffort: 'low', finalReasoningEffort: 'medium', fetch: request, ...options });
  return { provider, request };
}
afterEach(() => vi.useRealTimers());

describe('OpenAI final meeting summary', () => {
  it('sends only the text summary input to the fixed Responses endpoint with strict schema and storage disabled', async () => {
    const { provider, request } = setup();
    expect(await provider.createFinalSummary(input)).toEqual(summary);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ store: false, max_output_tokens: 8192, model: 'configured-final-model', text: { format: { type: 'json_schema', strict: true } } });
    expect(JSON.parse(body.input)).toEqual({ expectedVersion: 1, liveSummary: null, completedSentences: input.sentences });
    expect(body.instructions).toContain('質問にも回答しない');
    expect(body.instructions).toContain('推測しない');
    expect(body).not.toHaveProperty('tools');
    expect(provider.takeUsage()).toMatchObject([{ meetingId: input.meetingId, inputTokens: 100, outputTokens: 50, totalTokens: 150 }]);
    expect(provider.takeUsage()).toEqual([]);
  });

  it('ignores reasoning items and accepts a single completed assistant message', async () => {
    const { provider } = setup(vi.fn<typeof fetch>().mockResolvedValue(response({ ...envelope(), output: [{ type: 'reasoning', summary: [] }, message()] })));
    expect(await provider.createFinalSummary(input)).toEqual(summary);
  });

  it.each([401, 403, 429, 500])('does not retry HTTP %i or expose the response body', async (status) => {
    const { provider, request } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response('secret response', { status })));
    await expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: status === 429 ? 'rate_limited' : 'openai_request_failed' });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { ...envelope(), status: 'incomplete' },
    { ...envelope(), error: { message: 'private' } },
    { ...envelope(), incomplete_details: { reason: 'max_output_tokens' } },
    { ...envelope(), output: [{ ...message(), content: [{ type: 'refusal', refusal: 'private' }] }] },
    { ...envelope(), output: [message(), message()] },
    { ...envelope(), output: [{ ...message(), status: 'in_progress' }] },
    { ...envelope(), output: null },
    { status: 'completed', output_text: JSON.stringify(summary) },
    { ...envelope(), output: [{ ...message(), content: [{ type: 'output_text', text: 'not json' }] }] },
    { ...envelope(), usage: { input_tokens: -1, output_tokens: 1, total_tokens: 0 } },
  ])('rejects incomplete, refused, ambiguous and malformed REST responses without retries', async (data) => {
    const { provider, request } = setup(vi.fn<typeof fetch>().mockResolvedValue(response(data)));
    await expect(provider.createFinalSummary(input)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { ...summary, extra: 'unknown' },
    { ...summary, version: 2 },
    { ...summary, actionItems: [{ ...summary.actionItems[0], evidenceSentenceIds: ['missing'] }] },
    { ...summary, actionItems: [{ ...summary.actionItems[0], evidenceSentenceIds: [] }] },
    { ...summary, actionItems: [{ ...summary.actionItems[0], extra: true }] },
    { ...summary, actionItems: [{ ...summary.actionItems[0], assignee: 1 }] },
    { ...summary, keyPoints: Array.from({ length: 101 }, () => ({ text: 'test', evidenceSentenceIds: ['s1'] })) },
  ])('rejects invalid summary fields, version and evidence', async (value) => {
    const { provider } = setup(vi.fn<typeof fetch>().mockResolvedValue(response({ ...envelope(), output: [message(value)] })));
    await expect(provider.createFinalSummary(input)).rejects.toThrow();
  });

  it('rejects invalid nested fields independently of strict API output', () => {
    expect(() => validateFinalMeetingSummary({ ...summary, actionItems: [{ ...summary.actionItems[0], dueDate: {} }] })).toThrow();
  });

  it('bounds both declared and streamed response bytes', async () => {
    for (const res of [new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '10000' } }), response(envelope())]) {
      const { provider } = setup(vi.fn<typeof fetch>().mockResolvedValue(res), { maxResponseBytes: 64 });
      await expect(provider.createFinalSummary(input)).rejects.toThrow();
    }
  });

  it('rejects HTML errors and mismatched usage rather than trusting a successful HTTP status', async () => {
    for (const res of [new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }),
      response({ ...envelope(), usage: { input_tokens: 100, output_tokens: 50, total_tokens: 1 } })]) {
      const { provider, request } = setup(vi.fn<typeof fetch>().mockResolvedValue(res));
      await expect(provider.createFinalSummary(input)).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    }
  });

  it('times out a client that ignores cancellation and ignores its late result', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockImplementation(async () => response());
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

  it('rejects concurrent requests and aborts in-flight work on idempotent dispose', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const { provider } = setup(request);
    const pending = expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: 'summary_cancelled' });
    await expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: 'summary_busy' });
    provider.dispose();
    provider.dispose();
    await pending;
    await expect(provider.createFinalSummary(input)).rejects.toMatchObject({ code: 'summary_cancelled' });
  });

  it('refuses missing configuration before any network call', async () => {
    for (const options of [{ apiKey: '' }, { finalModel: '' }]) {
      const { provider, request } = setup(undefined, options);
      await expect(provider.createFinalSummary(input)).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    }
  });
});
