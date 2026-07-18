import { describe, expect, it } from 'vitest';
import { TranscriptStore } from './transcriptStore';
import type { TranscriptUpdate } from './types';

function update(overrides: Partial<TranscriptUpdate> = {}): TranscriptUpdate {
  return {
    sessionId: 'session-1',
    segmentId: 'segment-1',
    sequence: 0,
    revision: 0,
    text: '暫定テキスト',
    isFinal: false,
    language: 'ja-JP',
    provider: 'test',
    startTime: 1_000,
    createdAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('TranscriptStore', () => {
  it('replaces interim text only with a newer event', () => {
    const store = new TranscriptStore();
    store.startSession('session-1');

    expect(store.apply(update())).toBe(true);
    expect(store.apply(update({ sequence: 1, revision: 1, text: '新しい暫定テキスト' }))).toBe(true);
    expect(store.apply(update({ sequence: 0, revision: 0, text: '古い結果' }))).toBe(false);

    expect(store.snapshot().interim?.rawText).toBe('新しい暫定テキスト');
  });

  it('moves a segment to final once and ignores duplicates', () => {
    const store = new TranscriptStore();
    store.startSession('session-1');
    store.apply(update());

    expect(store.apply(update({ sequence: 1, revision: 1, text: '確定テキスト', isFinal: true }))).toBe(true);
    expect(store.apply(update({ sequence: 2, revision: 2, text: '重複', isFinal: true }))).toBe(false);

    expect(store.snapshot().interim).toBeNull();
    expect(store.snapshot().finalSegments.map(({ rawText }) => rawText)).toEqual(['確定テキスト']);
  });

  it('ignores results from an old session', () => {
    const store = new TranscriptStore();
    store.startSession('session-2');

    expect(store.apply(update())).toBe(false);
    expect(store.snapshot().finalSegments).toHaveLength(0);
  });

  it('finalizes the remaining interim text when recording stops', () => {
    const store = new TranscriptStore();
    store.startSession('session-1');
    store.apply(update({ text: '停止直前の発言' }));

    expect(store.finalizeInterim()).toBe(true);
    expect(store.snapshot().interim).toBeNull();
    expect(store.snapshot().finalSegments[0]).toMatchObject({
      rawText: '停止直前の発言',
      isFinal: true,
    });
    expect(store.finalizeInterim()).toBe(false);
  });

  it('keeps final history across sessions until the user clears it', () => {
    const store = new TranscriptStore();
    store.startSession('session-1');
    store.apply(update({ isFinal: true, text: '日本語の履歴' }));

    store.startSession('session-2');
    store.apply(update({
      sessionId: 'session-2',
      isFinal: true,
      language: 'en-US',
      text: 'English history',
    }));

    expect(store.snapshot().finalSegments.map(({ rawText, language }) => [rawText, language])).toEqual([
      ['日本語の履歴', 'ja-JP'],
      ['English history', 'en-US'],
    ]);

    store.clear();
    expect(store.snapshot().finalSegments).toHaveLength(0);
  });

  it('keeps raw segment IDs while displaying one completed sentence', () => {
    const store = new TranscriptStore({ createId: () => 'sentence-1' });
    store.startSession('session-1');
    store.apply(update({ segmentId: 'one', text: '今日は', isFinal: true, endTime: 1_100 }));
    store.apply(update({ segmentId: 'two', sequence: 1, text: '説明します。', isFinal: true, startTime: 1_100, endTime: 1_200 }));
    store.finalizeRecording();
    const snapshot = store.snapshot();
    expect(snapshot.completedSentences[0]).toMatchObject({
      id: 'sentence-1', rawText: '今日は説明します。', displayText: '今日は説明します。',
      rawSegmentIds: ['session-1:one', 'session-1:two'],
    });
    expect(snapshot.rawSegments.map((segment) => segment.text)).toEqual(['今日は', '説明します。']);
  });

  it('updates interim recognition on the same display line', () => {
    const store = new TranscriptStore();
    store.startSession('session-1');
    store.apply(update({ text: '今日は' }));
    store.apply(update({ sequence: 1, revision: 1, text: '今日は議事録アプリの' }));
    expect(store.snapshot().interimDisplayText).toBe('今日は議事録アプリの');
    expect(store.snapshot().completedSentences).toHaveLength(0);
  });

  it('can manually complete the current interim line', () => {
    const store = new TranscriptStore({ now: () => 1_500, createId: () => 'manual-sentence' });
    store.startSession('session-1');
    store.apply(update({ text: '手動で確定' }));
    expect(store.finalizeSentenceManually()).toBe(true);
    expect(store.snapshot().completedSentences[0]).toMatchObject({
      id: 'manual-sentence', rawText: '手動で確定', completionReason: 'manual',
    });
  });
});
