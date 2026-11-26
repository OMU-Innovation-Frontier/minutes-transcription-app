import type { AccessConfig } from './config.js';
import { AccessError, type Counter, type QuotaLedger } from './quotaStore.js';

/** Counters only. Audio credits are prepaid, expire at UTC midnight, and are never refunded. */
export class SupabaseQuotaStore implements QuotaLedger {
  private tail: Promise<unknown> = Promise.resolve();
  private ready = false;
  private audioCredit = 0;
  private creditDay = '';
  constructor(private readonly config: AccessConfig, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    if (await this.rpc('minutes_quota_health', {}) !== true) throw unavailable();
    this.ready = true;
  }
  reserve(counter: Counter, amount = 1): Promise<void> {
    const result = this.tail.then(async () => {
      if (!this.ready || !Number.isSafeInteger(amount) || amount < 1) throw unavailable();
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (this.creditDay !== day) this.audioCredit = 0;
      const audio = counter === 'audioBytes';
      const needed = audio ? Math.max(0, amount - this.audioCredit) : amount;
      if (!needed) { this.audioCredit -= amount; return; }
      const limits = { starts: this.config.dailyStarts, summary: this.config.dailySummary,
        correction: this.config.dailyCorrection, audioBytes: this.config.dailyAudioSeconds * 32_000 };
      const batch = audio ? Math.max(needed, 320_000) : needed;
      const value = await this.rpc('reserve_minutes_quota', {
        p_counter: counter, p_amount: needed, p_batch: batch, p_limit: limits[counter],
      });
      if (!value || typeof value !== 'object' || !('granted' in value) || !('day' in value)
        || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
        || typeof value.granted !== 'number' || !Number.isSafeInteger(value.granted)
        || value.granted < 0 || value.granted > batch) throw unavailable();
      if (value.granted === 0) throw new AccessError(429, 'access_daily_limit', '今日の利用上限に達しました。');
      if (value.granted < needed) throw unavailable();
      if (audio) {
        // Clock disagreement discards unused prepaid credit, never increases the allowance.
        this.audioCredit = value.day === day ? this.audioCredit + value.granted - amount : 0;
        this.creditDay = value.day;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  async settled(): Promise<void> { await this.tail; }
  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await this.fetcher(`${this.config.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
        headers: { apikey: this.config.supabaseSecret || '', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 1024) {
        await response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 1024) throw unavailable();
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch { throw unavailable(); }
  }
}
function unavailable(): AccessError {
  return new AccessError(503, 'access_limits_unavailable', '利用上限を確認できません。管理者に連絡してください。');
}
