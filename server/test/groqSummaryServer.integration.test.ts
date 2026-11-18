// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranscriptionServer, type RunningTranscriptionServer } from '../src/server';
import { loadServerConfig } from '../src/config';
import { loadSummaryConfig } from '../src/summary/config';
import { GroqSummaryProvider } from '../src/summary/groqSummaryProvider';
import { SummaryService } from '../src/summary/summaryService';
import { ApiUsageStore } from '../src/summary/usageStore';

const servers: RunningTranscriptionServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });
const body = { meetingId: 'synthetic-meeting', liveSummary: null, sentences: [{ id: 's1', text: 'テスト項目を確認します。', startTime: 0, endTime: 1 }] };
const summary = { version: 1, overview: 'テストを確認。', agenda: [], keyPoints: [], decisions: [], unresolvedItems: [], actionItems: [], nextChecks: [] };
async function start(success = true, maxInputBytes = 12_000, httpStatus = 401) {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => success ? new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(summary) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { headers: { 'content-type': 'application/json', 'x-summary-provider': 'groq' } }) : new Response('private provider detail', { status: httpStatus }));
  const config = { ...loadSummaryConfig({}), enabled: true, provider: 'groq' as const, apiKey: 'synthetic-key', finalModel: 'openai/gpt-oss-20b',
    pricingJson: JSON.stringify({ 'openai/gpt-oss-20b': { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } }) };
  const provider = new GroqSummaryProvider({ ...config, fetch: request, maxInputBytes });
  const server = createTranscriptionServer({ config: { ...loadServerConfig({}), port: 0 }, summaryService: new SummaryService(config, provider, new ApiUsageStore()) });
  servers.push(server);
  const address = await server.start();
  return { base: `http://127.0.0.1:${address.port}`, request };
}

describe('Groq summary HTTP boundary with Fake HTTP', () => {
  it('serves a final summary and token-only usage without exposing credentials', async () => {
    const { base, request } = await start();
    const status = await fetch(`${base}/api/summary/status`).then((res) => res.text());
    expect(JSON.parse(status)).toMatchObject({ enabled: true, provider: 'groq', apiUsed: true });
    expect(status).not.toContain('synthetic-key');
    const result = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-summary-provider': 'groq' }, body: JSON.stringify(body) });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(summary);
    const usage = await fetch(`${base}/api/summary/usage?meetingId=synthetic-meeting`).then((res) => res.json());
    expect(usage).toMatchObject({ requestCount: 1, inputTokens: 10, outputTokens: 5, pricingConfigured: true });
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects untrusted origins and malformed input before any external call', async () => {
    const { base, request } = await start();
    const forbidden = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { origin: 'https://untrusted.test', 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    expect(forbidden.status).toBe(403);
    const invalid = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-summary-provider': 'groq' }, body: JSON.stringify({ ...body, audio: 'unexpected' }) });
    expect(invalid.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });
  it('uses safe errors and does not retry failed external calls', async () => {
    const { base, request } = await start(false);
    const result = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-summary-provider': 'groq' }, body: JSON.stringify(body) });
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ code: 'summary_failed', message: '要約処理に失敗しました。' });
    expect(request).toHaveBeenCalledOnce();
  });
  it('rejects oversized requests locally and returns a safe actionable code', async () => {
    const { base, request } = await start(true, 1);
    const result = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-summary-provider': 'groq' }, body: JSON.stringify(body) });
    expect(result.status).toBe(413);
    expect(await result.json()).toMatchObject({ code: 'summary_input_too_large' });
    expect(request).not.toHaveBeenCalled();
  });
  it('returns a safe rate-limit response without retries or response details', async () => {
    const { base, request } = await start(false, 12000, 429);
    const result = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-summary-provider': 'groq' }, body: JSON.stringify(body) });
    expect(result.status).toBe(429);
    expect(await result.json()).toEqual({ code: 'summary_rate_limited', message: '要約サービスの利用制限に達しました。' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects an old client or a stale provider selection before any Groq transmission', async () => {
    const { base, request } = await start();
    for (const expected of [undefined, 'openai', 'mock']) {
      const result = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json', ...(expected ? { 'x-summary-provider': expected } : {}) }, body: JSON.stringify(body) });
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ code: 'summary_provider_changed' });
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('allows the provider confirmation header on the configured browser origin', async () => {
    const { base } = await start();
    const result = await fetch(`${base}/api/summary/final`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-headers': 'content-type,x-summary-provider' } });
    expect(result.headers.get('access-control-allow-headers')).toContain('x-summary-provider');
  });

});
