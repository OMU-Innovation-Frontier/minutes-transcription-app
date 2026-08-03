// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GroqWhisperUsageGuard } from './groqWhisperUsageGuard.js';

describe('GroqWhisperUsageGuard', () => {
  it('counts sent audio conservatively and enforces session, hour, and day limits', () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const guard = new GroqWhisperUsageGuard({ maxSessionSeconds: 2, maxHourSeconds: 3, maxDaySeconds: 4 }, () => now);
    guard.beginSession('one');
    guard.reserve('one', 2_000);
    expect(() => guard.reserve('one', 1)).toThrowError(expect.objectContaining({ code: 'groq_usage_limit' }));
    guard.endSession('one');
    guard.beginSession('two');
    guard.reserve('two', 1_000);
    expect(() => guard.reserve('two', 1)).toThrowError(expect.objectContaining({ code: 'groq_usage_limit' }));
    guard.endSession('two');
    now += 3_600_000;
    guard.beginSession('three');
    guard.reserve('three', 1_000);
    expect(() => guard.reserve('three', 1)).toThrowError(expect.objectContaining({ code: 'groq_usage_limit' }));
  });

  it('allows the exact boundary, separates sessions, and resets hour/day buckets by time key', () => {
    let now = Date.parse('2026-01-01T23:59:59Z');
    const guard = new GroqWhisperUsageGuard({ maxSessionSeconds: 2, maxHourSeconds: 2, maxDaySeconds: 2 }, () => now);
    guard.beginSession('one');
    guard.reserve('one', 1_000);
    guard.beginSession('two');
    guard.reserve('two', 1_000);
    expect(() => guard.reserve('two', 1)).toThrowError(expect.objectContaining({ code: 'groq_usage_limit' }));
    now += 1_000;
    guard.reserve('two', 1_000);
    expect(() => guard.reserve('two', 1)).toThrowError(expect.objectContaining({ code: 'groq_usage_limit' }));
  });

  it('starts with empty counters in a new guard instance', () => {
    const first = new GroqWhisperUsageGuard({ maxSessionSeconds: 1, maxHourSeconds: 1, maxDaySeconds: 1 });
    first.beginSession('one');
    first.reserve('one', 1_000);
    const restarted = new GroqWhisperUsageGuard({ maxSessionSeconds: 1, maxHourSeconds: 1, maxDaySeconds: 1 });
    restarted.beginSession('two');
    expect(() => restarted.reserve('two', 1_000)).not.toThrow();
  });
});
