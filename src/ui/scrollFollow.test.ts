import { describe, expect, it } from 'vitest';
import { followStateAfterScroll, isNearScrollEnd, shouldFollowTranscriptUpdate } from './scrollFollow';

describe('transcript auto-follow decisions', () => {
  it('treats the bottom position as following', () => {
    expect(isNearScrollEnd({ scrollTop: 700, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
  });

  it('allows a small distance from the bottom', () => {
    expect(isNearScrollEnd({ scrollTop: 620, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
  });

  it('stops following when the user scrolls into older speech', () => {
    expect(followStateAfterScroll({ scrollTop: 350, clientHeight: 300, scrollHeight: 1000 })).toBe(false);
  });

  it('follows a newly added sentence only while already following', () => {
    expect(shouldFollowTranscriptUpdate(true, 2, 3, false)).toBe(true);
    expect(shouldFollowTranscriptUpdate(false, 2, 3, false)).toBe(false);
  });

  it('follows interim text changes at the latest position', () => {
    expect(shouldFollowTranscriptUpdate(true, 2, 2, true)).toBe(true);
  });

  it('does not move for correction-only updates', () => {
    expect(shouldFollowTranscriptUpdate(true, 2, 2, false)).toBe(false);
  });

  it('supports a custom near-bottom threshold', () => {
    const metrics = { scrollTop: 650, clientHeight: 300, scrollHeight: 1000 };
    expect(isNearScrollEnd(metrics, 40)).toBe(false);
    expect(isNearScrollEnd(metrics, 60)).toBe(true);
  });
});
