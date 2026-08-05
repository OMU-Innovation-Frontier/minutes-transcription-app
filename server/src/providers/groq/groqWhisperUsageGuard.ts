import { groqError } from './groqWhisperClient.js';

export interface GroqUsageLimits {
  maxSessionSeconds: number;
  maxHourSeconds: number;
  maxDaySeconds: number;
}

export class GroqWhisperUsageGuard {
  private readonly sessions = new Map<string, number>();
  private readonly hours = new Map<string, number>();
  private readonly days = new Map<string, number>();

  constructor(private readonly limits: GroqUsageLimits, private readonly now: () => number = Date.now) {}

  beginSession(sessionId: string): void {
    if (!sessionId || this.sessions.has(sessionId)) throw groqError('groq_session_inactive', false);
    this.sessions.set(sessionId, 0);
  }

  reserve(sessionId: string, audioDurationMs: number): void {
    if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0) throw groqError('groq_pcm_invalid', false);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw groqError('groq_session_inactive', false);
    const date = new Date(this.now());
    const hourKey = date.toISOString().slice(0, 13);
    const dayKey = date.toISOString().slice(0, 10);
    const nextSession = session + audioDurationMs;
    const nextHour = (this.hours.get(hourKey) ?? 0) + audioDurationMs;
    const nextDay = (this.days.get(dayKey) ?? 0) + audioDurationMs;
    if (nextSession > this.limits.maxSessionSeconds * 1_000
      || nextHour > this.limits.maxHourSeconds * 1_000
      || nextDay > this.limits.maxDaySeconds * 1_000) {
      throw groqError('groq_usage_limit', false);
    }
    this.sessions.set(sessionId, nextSession);
    this.hours.set(hourKey, nextHour);
    this.days.set(dayKey, nextDay);
  }

  endSession(sessionId: string): void { this.sessions.delete(sessionId); }
}
