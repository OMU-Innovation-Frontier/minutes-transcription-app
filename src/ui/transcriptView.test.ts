import { describe, expect, it } from 'vitest';
import { createFallbackCorrection } from '../../shared/correction';
import type { CompletedSentence } from '../transcription/types';
import { createSentenceElement, transcriptPosition } from './transcriptView';

function sentence(id: string, rawText: string, correction?: CompletedSentence['correction']): CompletedSentence {
  return {
    id,
    sessionId: 'session-1',
    rawSegmentIds: [`session-1:${id}`],
    rawText,
    displayText: rawText,
    language: 'ja',
    revision: 0,
    startTime: 0,
    endTime: 1,
    completionReason: 'silence',
    correction,
  };
}

const timeFormatter = () => '10:00:00';

describe('Spotify-style transcript presentation', () => {
  it('distinguishes past, previous, and latest positions', () => {
    expect([0, 1, 2].map((index) => transcriptPosition(index, 3))).toEqual(['past', 'previous', 'latest']);
  });

  it('shows rawText immediately while correction is pending', () => {
    const pending = createFallbackCorrection('確認します', 'pending', ['session-1:sentence-1']);
    const item = createSentenceElement(sentence('sentence-1', '確認します', pending), 0, 1, { timeFormatter });
    expect(item.querySelector('.utterance__text')?.textContent).toBe('確認します');
    expect(item.textContent).toContain('文章を整えています');
  });

  it('updates to correctedText after correction completes', () => {
    const correction = {
      ...createFallbackCorrection('確認します', 'pending', ['session-1:sentence-1']),
      status: 'completed' as const,
      correctedText: '確認します。',
      changes: [{ before: 'す', after: 'す。', reason: 'punctuation' as const }],
    };
    const item = createSentenceElement(sentence('sentence-1', '確認します', correction), 0, 1, { timeFormatter });
    expect(item.querySelector('.utterance__text')?.textContent).toBe('確認します。');
  });

  it('falls back to rawText after correction failure', () => {
    const failed = createFallbackCorrection('原文を保持', 'failed', ['session-1:sentence-1']);
    const item = createSentenceElement(sentence('sentence-1', '原文を保持', failed), 0, 1, { timeFormatter });
    expect(item.querySelector('.utterance__text')?.textContent).toBe('原文を保持');
    expect(item.textContent).toContain('原文を表示しています');
  });

  it('keeps transcript order and gives only the last item the latest class', () => {
    const values = ['一つ目', '二つ目', '三つ目'];
    const items = values.map((text, index) => createSentenceElement(sentence(`sentence-${index}`, text), index, values.length));
    expect(items.map((item) => item.querySelector('.utterance__text')?.textContent)).toEqual(values);
    expect(items[1]?.classList.contains('transcript-item--previous')).toBe(true);
    expect(items[2]?.classList.contains('transcript-item--latest')).toBe(true);
  });

  it('keeps Whisper raw text available in expandable details', () => {
    const item = createSentenceElement(sentence('sentence-1', 'Whisper原文'), 0, 1, { timeFormatter });
    const details = item.querySelector('details');
    expect(details).not.toBeNull();
    expect(item.textContent).toContain('Whisper原文');
    expect(item.textContent).toContain('整文状態');
  });

  it('shows uncertain parts with user-facing reason labels', () => {
    const correction = {
      ...createFallbackCorrection('型番 SDK-1', 'pending', ['session-1:sentence-1']),
      status: 'completed' as const,
      uncertainParts: [{ text: 'SDK-1', reason: 'technical_term' as const }],
    };
    const item = createSentenceElement(sentence('sentence-1', '型番 SDK-1', correction), 0, 1, { timeFormatter });
    expect(item.textContent).toContain('確認が必要な箇所');
    expect(item.textContent).toContain('SDK-1（技術用語）');
  });

  it('keeps the full text instead of truncating long speech', () => {
    const longText = '長い発言です。'.repeat(80);
    const item = createSentenceElement(sentence('sentence-1', longText), 0, 1);
    expect(item.querySelector('.utterance__text')?.textContent).toBe(longText);
  });

  it('marks only a newly added sentence for the entry animation', () => {
    const item = createSentenceElement(sentence('sentence-1', '新しい発言'), 0, 1, { enteringSentenceId: 'sentence-1' });
    expect(item.classList.contains('transcript-item--entering')).toBe(true);
  });
});
