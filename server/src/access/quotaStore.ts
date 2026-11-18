import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AccessConfig } from './config.js';

export class AccessError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export type Counter = 'starts' | 'summary' | 'correction' | 'audioBytes';
export interface QuotaLedger {
  initialize(): Promise<void>;
  reserve(counter: Counter, amount?: number): Promise<void>;
  settled(): Promise<void>;
}
interface State { version: 1; day: string; starts: number; summary: number; correction: number; audioBytes: number }

/** One Node process and a persistent, private volume. Reserve before calling a provider. */
export class AccessQuotaStore {
  private tail: Promise<unknown> = Promise.resolve();
  private ready = false;
  constructor(private readonly config: AccessConfig, private readonly now: () => number = Date.now) {}

  initialize(): Promise<void> {
    return this.serial(async () => {
      await mkdir(dirname(this.config.quotaFile), { recursive: true, mode: 0o700 });
      try {
        await this.read();
        const marker = await open(this.config.quotaFile + '.initialized', 'a', 0o600);
        await marker.close();
      }
      catch (error) {
        if (!missing(error)) throw error;
        // A marker makes accidental deletion of an established quota file fail closed.
        let marker;
        try { marker = await open(this.config.quotaFile + '.initialized', 'wx', 0o600); }
        catch { throw unavailable(); }
        await marker.close();
        await this.write(this.empty());
      }
      this.ready = true;
    });
  }

  reserve(counter: Counter, amount = 1): Promise<void> {
    return this.serial(async () => {
      if (!this.ready || !Number.isSafeInteger(amount) || amount < 1) throw unavailable();
      const saved = await this.read();
      const currentDay = this.empty().day;
      // Never reset backwards when the clock moves backwards.
      const state = saved.day < currentDay ? this.empty() : saved;
      const limits = { starts: this.config.dailyStarts, summary: this.config.dailySummary,
        correction: this.config.dailyCorrection, audioBytes: this.config.dailyAudioSeconds * 32_000 };
      if (state[counter] + amount > limits[counter]) throw new AccessError(429, 'access_daily_limit', '今日の利用上限に達しました。');
      state[counter] += amount;
      await this.write(state);
    });
  }

  async settled(): Promise<void> { await this.tail; }
  private empty(): State { return { version: 1, day: new Date(this.now()).toISOString().slice(0, 10), starts: 0, summary: 0, correction: 0, audioBytes: 0 }; }
  private async read(): Promise<State> {
    try {
      const raw = await readFile(this.config.quotaFile, 'utf8');
      if (raw.length > 1024) throw unavailable();
      const value = JSON.parse(raw) as Partial<State>;
      if (value.version !== 1 || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
        || !['starts', 'summary', 'correction', 'audioBytes'].every(key => Number.isSafeInteger(value[key as Counter]) && Number(value[key as Counter]) >= 0)) throw unavailable();
      return value as State;
    } catch (error) { if (missing(error)) throw error; throw unavailable(); }
  }
  private async write(state: State): Promise<void> {
    const temporary = this.config.quotaFile + '.tmp';
    try {
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.config.quotaFile);
    } catch { await unlink(temporary).catch(() => undefined); throw unavailable(); }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
function missing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function unavailable(): AccessError { return new AccessError(503, 'access_limits_unavailable', '利用上限を確認できません。管理者に連絡してください。'); }
