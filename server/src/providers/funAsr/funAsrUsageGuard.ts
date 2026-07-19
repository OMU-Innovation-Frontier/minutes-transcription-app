import { FUN_ASR_SAMPLE_RATE } from './funAsrProtocol.js';
import { ServerProviderError } from '../types.js';

export interface FunAsrUsageLimits {
  maxAudioSecondsPerSession: number;
  maxAudioSecondsPerDay: number;
  maxAudioSecondsPerMonth: number;
  maxConcurrentSessions: number;
}

interface ActiveUsage {
  frames: number;
}

export class FunAsrUsageGuard {
  private readonly limits: Readonly<{
    sessionFrames: number;
    dayFrames: number;
    monthFrames: number;
    concurrentSessions: number;
  }>;
  private readonly active = new Map<string, ActiveUsage>();
  private readonly dailyFrames = new Map<string, number>();
  private readonly monthlyFrames = new Map<string, number>();

  constructor(limits: FunAsrUsageLimits, private readonly now: () => number = Date.now) {
    this.limits = {
      sessionFrames: secondsToFrames(limits.maxAudioSecondsPerSession),
      dayFrames: secondsToFrames(limits.maxAudioSecondsPerDay),
      monthFrames: secondsToFrames(limits.maxAudioSecondsPerMonth),
      concurrentSessions: positiveInteger(limits.maxConcurrentSessions),
    };
  }

  beginSession(sessionId: string): void {
    if (!sessionId || this.active.has(sessionId)) throw usageError('fun_asr_session_inactive');
    if (this.active.size >= this.limits.concurrentSessions) throw usageError('fun_asr_usage_limit_exceeded');
    this.active.set(sessionId, { frames: 0 });
  }

  reserveAudioFrames(sessionId: string, frames: number): void {
    if (!Number.isSafeInteger(frames) || frames < 0) throw usageError('fun_asr_pcm_invalid');
    const session = this.active.get(sessionId);
    if (!session) throw usageError('fun_asr_session_inactive');
    if (frames === 0) return;
    const now = new Date(this.now());
    const dayKey = now.toISOString().slice(0, 10);
    const monthKey = dayKey.slice(0, 7);
    const nextSession = safeAdd(session.frames, frames);
    const nextDay = safeAdd(this.dailyFrames.get(dayKey) ?? 0, frames);
    const nextMonth = safeAdd(this.monthlyFrames.get(monthKey) ?? 0, frames);
    if (
      nextSession > this.limits.sessionFrames
      || nextDay > this.limits.dayFrames
      || nextMonth > this.limits.monthFrames
    ) {
      throw usageError('fun_asr_usage_limit_exceeded');
    }
    session.frames = nextSession;
    this.dailyFrames.set(dayKey, nextDay);
    this.monthlyFrames.set(monthKey, nextMonth);
  }

  endSession(sessionId: string): void {
    this.active.delete(sessionId);
  }

  get activeSessionCount(): number {
    return this.active.size;
  }

  getSessionFrames(sessionId: string): number {
    return this.active.get(sessionId)?.frames ?? 0;
  }

  getDailyFrames(date = new Date(this.now())): number {
    return this.dailyFrames.get(date.toISOString().slice(0, 10)) ?? 0;
  }

  getMonthlyFrames(date = new Date(this.now())): number {
    return this.monthlyFrames.get(date.toISOString().slice(0, 7)) ?? 0;
  }
}

function secondsToFrames(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw usageError('fun_asr_usage_limits_required');
  const frames = seconds * FUN_ASR_SAMPLE_RATE;
  if (!Number.isSafeInteger(frames) || frames < 1) throw usageError('fun_asr_usage_limits_required');
  return frames;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw usageError('fun_asr_usage_limits_required');
  return value;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw usageError('fun_asr_usage_limit_exceeded');
  return result;
}

function usageError(code: string): ServerProviderError {
  return new ServerProviderError(code, false, 'Fun-ASRの利用制限により処理を開始または継続できません。');
}
