// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranscriptionServer, type RunningTranscriptionServer } from '../src/server';
import { loadServerConfig } from '../src/config';
import { loadSummaryConfig } from '../src/summary/config';
import { OpenAISummaryProvider } from '../src/summary/openAISummaryProvider';
import { SummaryService } from '../src/summary/summaryService';
import { ApiUsageStore } from '../src/summary/usageStore';

const servers: RunningTranscriptionServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });
const body = { meetingId: 'synthetic-meeting', liveSummary: null, sentences: [{ id: 's1', text: 'テスト項目を確認します。', startTime: 0, endTime: 1 }] };
const summary = { version: 1, overview: 'テストを確認。', agenda: [], keyPoints: [], decisions: [], unresolvedItems: [], actionItems: [], nextChecks: [] };
async function start(success = true) {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => success ? new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(summary) }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }), { headers: { 'content-type': 'application/json' } }) : new Response('private provider detail', { status: 401 }));
  const config = { ...loadSummaryConfig({}), enabled: true, provider: 'openai' as const, apiKey: 'synthetic-key', finalModel: 'test-model',
    pricingJson: JSON.stringify({ 'test-model': { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } }) };
  const provider = new OpenAISummaryProvider({ ...config, fetch: request });
  const server = createTranscriptionServer({ config: { ...loadServerConfig({}), port: 0 }, summaryService: new SummaryService(config, provider, new ApiUsageStore()) });
  servers.push(server);
  const address = await server.start();
  return { base: `http://127.0.0.1:${address.port}`, request };
}

describe('OpenAI summary HTTP boundary with Fake HTTP', () => {
  it('serves a final summary and token-only usage without exposing credentials', async () => {
    const { base, request } = await start();
    const status = await fetch(`${base}/api/summary/status`).then((res) => res.text());
    expect(JSON.parse(status)).toMatchObject({ enabled: true, provider: 'openai', apiUsed: true });
    expect(status).not.toContain('synthetic-key');
    const result = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
    const invalid = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, audio: 'unexpected' }) });
    expect(invalid.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });
  it('uses safe errors and does not retry failed external calls', async () => {
    const { base, request } = await start(false);
    const result = await fetch(`${base}/api/summary/final`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ code: 'summary_failed', message: '要約処理に失敗しました。' });
    expect(request).toHaveBeenCalledOnce();
  });
});
