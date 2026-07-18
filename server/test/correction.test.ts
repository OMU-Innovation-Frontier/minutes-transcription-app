// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { CorrectionInput } from '../../shared/correction';
import { loadCorrectionConfig } from '../src/correction/config';
import { CorrectionService } from '../src/correction/correctionService';
import { MockCorrectionProvider } from '../src/correction/mockCorrectionProvider';
import type { CorrectionProvider } from '../src/correction/provider';

function request(text = 'こんにちわ'): { sessionId: string; input: CorrectionInput } {
  return {
    sessionId: 'session-1',
    input: {
      targetSegmentId: 'sentence-1',
      targetRawText: text,
      previousSegments: [{ segmentId: 'sentence-0', rawText: '前の文です。' }],
      language: 'ja',
      glossary: [],
      correctionPolicyVersion: 'safe-correction-v1',
      removeFillers: false,
      sourceSegmentIds: ['session-1:segment-1'],
    },
  };
}

describe('CorrectionService', () => {
  it('is disabled, single-concurrency, and filler-preserving by default', () => {
    expect(loadCorrectionConfig({})).toMatchObject({
      enabled: false,
      provider: 'mock',
      timeoutMs: 8_000,
      concurrency: 1,
      maxInputChars: 4_000,
      removeFillers: false,
    });
  });

  it('does not call the provider when disabled', async () => {
    const correct = vi.fn();
    const provider = { name: 'test', externalTransmission: false, correct } as CorrectionProvider;
    const service = new CorrectionService(loadCorrectionConfig({}), provider);
    await expect(service.correct(request())).resolves.toMatchObject({
      rawText: 'こんにちわ', correctedText: 'こんにちわ', status: 'disabled',
    });
    expect(correct).not.toHaveBeenCalled();
  });

  it('skips empty text without calling the provider', async () => {
    const correct = vi.fn();
    const provider = { name: 'test', externalTransmission: false, correct } as CorrectionProvider;
    const service = new CorrectionService(loadCorrectionConfig({ LLM_CORRECTION_ENABLED: 'true' }), provider);
    await expect(service.correct(request('  '))).resolves.toMatchObject({ status: 'skipped', errorCode: 'empty_text' });
    expect(correct).not.toHaveBeenCalled();
  });

  it('keeps rawText and stores deterministic correctedText separately', async () => {
    const config = loadCorrectionConfig({ LLM_CORRECTION_ENABLED: 'true' });
    const service = new CorrectionService(config, new MockCorrectionProvider());
    const correction = await service.correct(request());
    expect(correction).toMatchObject({
      rawText: 'こんにちわ', correctedText: 'こんにちは。', status: 'completed', provider: 'mock',
    });
    expect(correction.changes).toEqual([
      { before: 'こんにちわ', after: 'こんにちは', reason: 'spelling' },
      { before: 'は', after: 'は。', reason: 'punctuation' },
    ]);
  });

  it.each([
    ['invalid-json', 'invalid_json'],
    ['number-change', 'inconsistent_output'],
    ['long-output', 'output_too_long'],
  ] as const)('falls back safely for %s', async (scenario, errorCode) => {
    const service = new CorrectionService(
      loadCorrectionConfig({ LLM_CORRECTION_ENABLED: 'true' }),
      new MockCorrectionProvider({ scenario }),
    );
    const correction = await service.correct(request('金額は100円です'));
    expect(correction).toMatchObject({
      rawText: '金額は100円です', correctedText: '金額は100円です', status: 'failed', errorCode,
    });
  });

  it('times out and returns rawText without throwing', async () => {
    const service = new CorrectionService(
      loadCorrectionConfig({ LLM_CORRECTION_ENABLED: 'true', LLM_CORRECTION_TIMEOUT_MS: '20' }),
      new MockCorrectionProvider({ scenario: 'timeout' }),
    );
    await expect(service.correct(request())).resolves.toMatchObject({
      rawText: 'こんにちわ', correctedText: 'こんにちわ', status: 'failed', errorCode: 'timeout',
    });
  });

  it('reports external transmission for an unimplemented non-mock provider without making a request', async () => {
    const config = loadCorrectionConfig({ LLM_CORRECTION_ENABLED: 'true', LLM_CORRECTION_PROVIDER: 'cloud-example' });
    const service = new CorrectionService(config, {
      name: 'cloud-example', externalTransmission: true,
      correct: async () => { throw Object.assign(new Error('unavailable'), { code: 'provider_unavailable' }); },
    });
    expect(service.status()).toMatchObject({ enabled: true, provider: 'cloud-example', externalTransmission: true });
    await expect(service.correct(request())).resolves.toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
  });
});
