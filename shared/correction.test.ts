import { describe, expect, it } from 'vitest';
import {
  CorrectionValidationError,
  extractProtectedTokens,
  validateCorrectionOutput,
  type CorrectionInput,
} from './correction';

function input(overrides: Partial<CorrectionInput> = {}): CorrectionInput {
  return {
    targetSegmentId: 'sentence-1',
    targetRawText: '売上は100円です',
    previousSegments: [],
    language: 'ja',
    glossary: [],
    correctionPolicyVersion: 'safe-correction-v1',
    removeFillers: false,
    sourceSegmentIds: ['session-1:segment-1'],
    ...overrides,
  };
}

describe('safe correction validation', () => {
  it('accepts strict JSON and keeps raw input immutable', () => {
    const target = input();
    const result = validateCorrectionOutput(JSON.stringify({
      correctedText: '売上は100円です。',
      changes: [{ before: 'す', after: 'す。', reason: 'punctuation' }],
      uncertainParts: [{ text: '100円', reason: 'number' }],
    }), target, { removeFillers: false });
    expect(result.correctedText).toBe('売上は100円です。');
    expect(target.targetRawText).toBe('売上は100円です');
    expect(result.uncertainParts).toEqual([{ text: '100円', reason: 'number' }]);
  });

  it('rejects invalid JSON', () => {
    expect(() => validateCorrectionOutput('{bad', input(), { removeFillers: false }))
      .toThrowError(CorrectionValidationError);
  });

  it('rejects an unknown change reason', () => {
    expect(() => validateCorrectionOutput({
      correctedText: '売上は100円です。',
      changes: [{ before: 'す', after: 'す。', reason: 'creative' }],
      uncertainParts: [],
    }, input(), { removeFillers: false })).toThrow(/changes/u);
  });

  it('rejects changes that cannot reconstruct correctedText', () => {
    expect(() => validateCorrectionOutput({
      correctedText: '別の文章です。',
      changes: [{ before: 'す', after: 'す。', reason: 'punctuation' }],
      uncertainParts: [],
    }, input(), { removeFillers: false })).toThrow(/再構成/u);
  });

  it('rejects a changed number', () => {
    expect(() => validateCorrectionOutput({
      correctedText: '売上は200円です',
      changes: [{ before: '100', after: '200', reason: 'grammar' }],
      uncertainParts: [],
    }, input(), { removeFillers: false })).toThrow(/保護対象/u);
  });

  it('rejects a changed URL', () => {
    const target = input({ targetRawText: '詳細はhttps://example.test/aです' });
    expect(() => validateCorrectionOutput({
      correctedText: '詳細はhttps://example.test/bです',
      changes: [{ before: 'https://example.test/a', after: 'https://example.test/b', reason: 'spelling' }],
      uncertainParts: [],
    }, target, { removeFillers: false })).toThrow(/保護対象/u);
  });

  it('rejects an extremely long output', () => {
    expect(() => validateCorrectionOutput({
      correctedText: '売上は100円です'.repeat(10),
      changes: [],
      uncertainParts: [],
    }, input(), { removeFillers: false })).toThrow(/長すぎ/u);
  });

  it('accepts an explicitly allowed glossary token change', () => {
    const target = input({
      targetRawText: '型番はSDK-1です',
      glossary: [{ canonical: 'SDK-2', aliases: ['SDK-1'], language: 'any' }],
    });
    const result = validateCorrectionOutput({
      correctedText: '型番はSDK-2です',
      changes: [{ before: 'SDK-1', after: 'SDK-2', reason: 'glossary' }],
      uncertainParts: [],
    }, target, { removeFillers: false });
    expect(result.correctedText).toContain('SDK-2');
  });

  it('rejects an unregistered glossary change', () => {
    const target = input({ targetRawText: '型番はSDK-1です' });
    expect(() => validateCorrectionOutput({
      correctedText: '型番はSDK-2です',
      changes: [{ before: 'SDK-1', after: 'SDK-2', reason: 'glossary' }],
      uncertainParts: [],
    }, target, { removeFillers: false })).toThrow(/用語集/u);
  });

  it('preserves fillers when removal is disabled', () => {
    const target = input({ targetRawText: 'えっと確認します' });
    expect(() => validateCorrectionOutput({
      correctedText: '確認します',
      changes: [{ before: 'えっと', after: '', reason: 'duplicate' }],
      uncertainParts: [],
    }, target, { removeFillers: false })).toThrow(/フィラー/u);
  });

  it('allows conservative filler removal only when enabled', () => {
    const target = input({ targetRawText: 'えっと確認します', removeFillers: true });
    expect(validateCorrectionOutput({
      correctedText: '確認します',
      changes: [{ before: 'えっと', after: '', reason: 'duplicate' }],
      uncertainParts: [],
    }, target, { removeFillers: true }).correctedText).toBe('確認します');
  });

  it('extracts numbers, URLs, email, technical terms, and file names conservatively', () => {
    const tokens = extractProtectedTokens('12.5% https://example.test a@example.test SDK-2 report.csv');
    expect(tokens).toEqual(expect.arrayContaining(['12.5%', 'https://example.test', 'a@example.test', 'SDK-2', 'report.csv']));
  });
});
