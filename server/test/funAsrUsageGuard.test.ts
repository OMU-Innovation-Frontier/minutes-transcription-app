// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FunAsrUsageGuard } from '../src/providers/funAsr/funAsrUsageGuard';

const SECOND = 16_000;

describe('FunAsrUsageGuard', () => {
  it('uses integer PCM frames for session, day, and month limits', () => {
    const guard = createGuard();
    guard.beginSession('one');
    guard.reserveAudioFrames('one', SECOND * 2);
    expect(guard.getSessionFrames('one')).toBe(SECOND * 2);
    expect(guard.getDailyFrames()).toBe(SECOND * 2);
    expect(guard.getMonthlyFrames()).toBe(SECOND * 2);
    expect(() => guard.reserveAudioFrames('one', SECOND + 1)).toThrowError(/利用制限/);
  });

  it('enforces aggregate daily and monthly limits across sessions', () => {
    const guard = createGuard({ session: 10, day: 3, month: 4 });
    guard.beginSession('one');
    guard.reserveAudioFrames('one', SECOND * 2);
    guard.endSession('one');
    guard.beginSession('two');
    guard.reserveAudioFrames('two', SECOND);
    expect(() => guard.reserveAudioFrames('two', 1)).toThrowError(/利用制限/);
  });

  it('enforces a monthly limit across separate UTC days', () => {
    let now = Date.parse('2026-07-01T00:00:00Z');
    const guard = createGuard({ session: 10, day: 10, month: 3, now: () => now });
    guard.beginSession('one');
    guard.reserveAudioFrames('one', SECOND * 2);
    now = Date.parse('2026-07-02T00:00:00Z');
    guard.reserveAudioFrames('one', SECOND);
    expect(() => guard.reserveAudioFrames('one', 1)).toThrowError(/利用制限/);
  });

  it('rolls UTC day and month buckets with an injected clock', () => {
    let now = Date.parse('2026-07-31T23:59:59Z');
    const guard = createGuard({ session: 10, day: 2, month: 2, now: () => now });
    guard.beginSession('one');
    guard.reserveAudioFrames('one', SECOND * 2);
    now = Date.parse('2026-08-01T00:00:00Z');
    expect(guard.getDailyFrames()).toBe(0);
    expect(guard.getMonthlyFrames()).toBe(0);
    guard.reserveAudioFrames('one', SECOND);
    expect(guard.getDailyFrames()).toBe(SECOND);
  });

  it('enforces and releases concurrent session slots', () => {
    const guard = createGuard({ concurrent: 1 });
    guard.beginSession('one');
    expect(() => guard.beginSession('two')).toThrowError(/利用制限/);
    guard.endSession('one');
    guard.beginSession('two');
    expect(guard.activeSessionCount).toBe(1);
  });

  it('makes session release idempotent and never decrements below zero', () => {
    const guard = createGuard({ concurrent: 1 });
    guard.beginSession('one');
    guard.endSession('one');
    guard.endSession('one');
    expect(guard.activeSessionCount).toBe(0);
    guard.beginSession('two');
    expect(guard.activeSessionCount).toBe(1);
  });

  it('rejects unsafe frame counts and limits before accounting', () => {
    expect(() => createGuard({ session: Number.MAX_SAFE_INTEGER })).toThrow();
    const guard = createGuard();
    guard.beginSession('one');
    for (const frames of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      expect(() => guard.reserveAudioFrames('one', frames)).toThrow();
    }
    expect(guard.getSessionFrames('one')).toBe(0);
  });

  it('keeps reservations after a caller encounters a send failure', () => {
    const guard = createGuard();
    guard.beginSession('one');
    guard.reserveAudioFrames('one', 320);
    expect(guard.getDailyFrames()).toBe(320);
    guard.endSession('one');
    expect(guard.getDailyFrames()).toBe(320);
  });
});

function createGuard(options: {
  session?: number; day?: number; month?: number; concurrent?: number; now?: () => number;
} = {}): FunAsrUsageGuard {
  return new FunAsrUsageGuard({
    maxAudioSecondsPerSession: options.session ?? 3,
    maxAudioSecondsPerDay: options.day ?? 10,
    maxAudioSecondsPerMonth: options.month ?? 20,
    maxConcurrentSessions: options.concurrent ?? 2,
  }, options.now);
}
