import { describe, expect, it, vi } from 'vitest';
import { createFallbackCorrection } from '../../shared/correction';
import { TranscriptStore } from './transcriptStore';
import type { TranscriptUpdate } from './types';

function completedStore(onChange = vi.fn()): TranscriptStore {
  const store = new TranscriptStore({ createId: () => 'sentence-1', onChange });
  store.startSession('session-1');
  const update: TranscriptUpdate = {
    sessionId: 'session-1', segmentId: 'segment-1', sequence: 0, revision: 0,
    text: 'Whisper原文', isFinal: true, language: 'ja-JP', provider: 'test',
    startTime: 1, endTime: 2, createdAt: '2026-07-17T00:00:00.000Z',
  };
  store.apply(update);
  store.finalizeSentenceManually();
  return store;
}

describe('TranscriptStore correction safety', () => {
  it('stores correctedText separately without mutating rawText', () => {
    const store = completedStore();
    const correction = {
      ...createFallbackCorrection('Whisper原文', 'pending', ['session-1:segment-1']),
      correctedText: 'Whisper原文。',
      status: 'completed' as const,
      changes: [{ before: '文', after: '文。', reason: 'punctuation' as const }],
    };
    expect(store.applyCorrection('session-1', 'sentence-1', correction)).toBe(true);
    expect(store.snapshot().completedSentences[0]).toMatchObject({
      rawText: 'Whisper原文', correction: { rawText: 'Whisper原文', correctedText: 'Whisper原文。' },
    });
  });

  it('rejects a correction for another session or mismatched raw text', () => {
    const store = completedStore();
    expect(store.applyCorrection('old-session', 'sentence-1', createFallbackCorrection('Whisper原文', 'failed', ['session-1:segment-1']))).toBe(false);
    expect(store.applyCorrection('session-1', 'sentence-1', createFallbackCorrection('changed', 'failed', ['session-1:segment-1']))).toBe(false);
    expect(store.snapshot().completedSentences[0]?.correction).toBeUndefined();
  });

  it('does not apply a late second result after completion', () => {
    const store = completedStore();
    const completed = {
      ...createFallbackCorrection('Whisper原文', 'pending', ['session-1:segment-1']),
      status: 'completed' as const,
    };
    expect(store.applyCorrection('session-1', 'sentence-1', completed)).toBe(true);
    expect(store.applyCorrection('session-1', 'sentence-1', createFallbackCorrection('Whisper原文', 'failed', ['session-1:segment-1']))).toBe(false);
    expect(store.snapshot().completedSentences[0]?.correction?.status).toBe('completed');
  });
});
