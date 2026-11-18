// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { loadAccessConfig } from '../src/access/config';
import { SupabaseQuotaStore } from '../src/access/supabaseQuotaStore';

const settings = () => ({ ...loadAccessConfig({}), dailySummary: 2 });
const json = (value: unknown) => new Response(JSON.stringify(value));
const day = '2026-11-19';
const now = () => Date.parse(day + 'T10:00:00Z');
describe('remote quota ledger', () => {
  it('requires initialization and does not send meeting data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(true)).mockResolvedValue(json({ day, granted: 1 }));
    const store = new SupabaseQuotaStore(settings(), fetcher, now);
    await expect(store.reserve('summary')).rejects.toMatchObject({ status: 503 });
    await store.initialize(); await store.reserve('summary');
    const request = fetcher.mock.calls[1]![1]!;
    expect(JSON.parse(request.body as string)).toEqual({ p_counter: 'summary', p_amount: 1, p_batch: 1, p_limit: 2 });
    expect(request.redirect).toBe('error'); expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.headers).not.toHaveProperty('Authorization');
  });
  it('prepays audio in ten second batches and never reuses credits after restart', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('health') ? json(true) : json({ day, granted: 320000 }));
    const store = new SupabaseQuotaStore(settings(), fetcher, now); await store.initialize();
    await Promise.all(Array.from({ length: 10 }, () => store.reserve('audioBytes', 32000)));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await store.reserve('audioBytes', 32000); expect(fetcher).toHaveBeenCalledTimes(3);
    const restarted = new SupabaseQuotaStore(settings(), fetcher, now); await restarted.initialize();
    await restarted.reserve('audioBytes', 32000); expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('discards unused credits on a new UTC day', async () => {
    let time = now();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(true)).mockImplementation(async () => json({ day, granted: 320000 }));
    const store = new SupabaseQuotaStore(settings(), fetcher, () => time); await store.initialize();
    await store.reserve('audioBytes', 32000); time += 86400000;
    await store.reserve('audioBytes', 32000); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('preserves remote denial across instances and recovers the serial queue after failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('health') ? json(true) : json({ day, granted: 0 }));
    for (let i = 0; i < 2; i++) {
      const store = new SupabaseQuotaStore(settings(), fetcher, now); await store.initialize();
      await expect(store.reserve('summary')).rejects.toMatchObject({ status: 429 });
      await expect(store.reserve('summary')).rejects.toMatchObject({ status: 429 });
      await store.settled();
    }
  });
  it.each([null, { day, granted: -1 }, { day, granted: 2 }, { day, granted: '1' }, { granted: 1 }])('rejects malformed reservation replies', async reply => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json(reply));
    const store = new SupabaseQuotaStore(settings(), fetcher, now); await store.initialize();
    await expect(store.reserve('summary')).rejects.toMatchObject({ status: 503 });
  });
  it('fails closed without retry, response leakage, or local fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(new Response('private upstream response', { status: 503 }));
    const store = new SupabaseQuotaStore(settings(), fetcher, now); await store.initialize();
    await expect(store.reserve('summary')).rejects.toMatchObject({ status: 503, message: '利用上限を確認できません。管理者に連絡してください。' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects oversized replies and unhealthy initialization', async () => {
    await expect(new SupabaseQuotaStore(settings(), vi.fn<typeof fetch>().mockResolvedValue(json(false))).initialize()).rejects.toMatchObject({ status: 503 });
    await expect(new SupabaseQuotaStore(settings(), vi.fn<typeof fetch>().mockResolvedValue(new Response(' '.repeat(1025)))).initialize()).rejects.toMatchObject({ status: 503 });
  });
  it('requires remote storage on Render and validates server-only connection settings', () => {
    const env = { APP_ACCESS_ENABLED: 'true', APP_ACCESS_PASSPHRASE: 'synthetic-passphrase-for-tests', RENDER_EXTERNAL_URL: 'https://example.onrender.com', APP_QUOTA_FILE: 'quota.json' };
    expect(() => loadAccessConfig(env)).toThrow();
    expect(() => loadAccessConfig({ ...env, APP_QUOTA_BACKEND: 'supabase', APP_QUOTA_SUPABASE_URL: 'http://localhost' })).toThrow();
    expect(() => loadAccessConfig({ ...env, APP_QUOTA_BACKEND: 'supabase', APP_QUOTA_SUPABASE_URL: 'https://example.supabase.co', APP_QUOTA_SUPABASE_SECRET_KEY: ['sb', 'secret', 'synthetic'].join('_') })).not.toThrow();
  });
});
