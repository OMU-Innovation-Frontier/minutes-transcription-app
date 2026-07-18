import { describe, expect, it } from 'vitest';
import { toMicrophoneError } from './errors';

describe('toMicrophoneError', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'device-not-found'],
    ['DevicesNotFoundError', 'device-not-found'],
    ['NotReadableError', 'device-busy'],
  ])('maps %s to %s', (domExceptionName, expectedCode) => {
    const result = toMicrophoneError(new DOMException('browser message', domExceptionName));
    expect(result.code).toBe(expectedCode);
  });

  it('returns a safe message for unknown failures', () => {
    const result = toMicrophoneError(new Error('sensitive implementation detail'));
    expect(result.code).toBe('unknown');
    expect(result.message).not.toContain('sensitive implementation detail');
  });
});
