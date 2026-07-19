import { describe, expect, it } from 'vitest';
import { createFallbackCorrection } from '../../shared/correction';
import { correctionStatusPresentation, sentencePresentation } from './transcriptPresentation';
import type { CompletedSentence } from '../transcription/types';

function sentence(correction?: CompletedSentence['correction']): CompletedSentence {
  return {
    id: 'sentence-1', sessionId: 'session-1', rawSegmentIds: ['session-1:segment-1'],
    rawText: '原文です', displayText: '原文です。', language: 'ja', startTime: 0, endTime: 1,
    completionReason: 'silence', revision: 0, correction,
  };
}

describe('sentence correction presentation', () => {
  it('shows rawText while correction is disabled', () => {
    expect(sentencePresentation(sentence()).visibleText).toBe('原文です');
  });

  it('shows rawText while correction is pending', () => {
    const result = sentencePresentation(sentence(createFallbackCorrection('原文です', 'pending', ['session-1:segment-1'])));
    expect(result).toMatchObject({ visibleText: '原文です', statusLabel: '整文中（原文表示）' });
  });

  it('shows correctedText only after completion and keeps rawText available', () => {
    const correction = {
      ...createFallbackCorrection('原文です', 'pending', ['session-1:segment-1']),
      correctedText: '原文です。', status: 'completed' as const,
      changes: [{ before: 'す', after: 'す。', reason: 'punctuation' as const }],
    };
    expect(sentencePresentation(sentence(correction))).toMatchObject({
      visibleText: '原文です。', rawText: '原文です', showingCorrection: true,
    });
  });

  it('falls back to rawText after failure', () => {
    const result = sentencePresentation(sentence(createFallbackCorrection('原文です', 'failed', ['session-1:segment-1'])));
    expect(result).toMatchObject({ visibleText: '原文です', statusLabel: '整文失敗（原文表示）' });
  });

  it('exposes uncertainParts for the UI warning', () => {
    const correction = {
      ...createFallbackCorrection('型番SDK-1です', 'pending', ['session-1:segment-1']),
      status: 'completed' as const,
      uncertainParts: [{ text: 'SDK-1', reason: 'technical_term' as const }],
    };
    expect(sentencePresentation(sentence(correction)).uncertainParts).toEqual([{ text: 'SDK-1', reason: 'technical_term' }]);
  });
});

describe('correction status presentation', () => {
  const status = {
    enabled: false, provider: 'mock', externalTransmission: false, concurrency: 1,
    timeoutMs: 8000, maxInputChars: 4000, removeFillers: false,
    correctionPolicyVersion: 'safe-correction-v1', glossaryEntryCount: 0,
    model: 'deterministic-mock-v1', queueLimit: 100, maxAttempts: 3,
  };

  it('labels disabled correction as fully local and states the default', () => {
    const result = correctionStatusPresentation(status);
    expect(result.statusText).toContain('完全ローカル');
    expect(result.privacyText).toContain('既定で無効');
    expect(result.privacyText).toContain('外部送信はありません');
  });

  it('warns when an enabled provider transmits transcript text externally', () => {
    const result = correctionStatusPresentation({
      ...status, enabled: true, provider: 'cloud-example', externalTransmission: true,
    });
    expect(result.statusText).toContain('文字起こし外部送信あり');
    expect(result.privacyText).toContain('文字起こし文章が外部送信されます');
    expect(result.privacyText).not.toContain('完全ローカル');
  });
});
