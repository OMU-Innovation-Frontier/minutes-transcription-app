import { describe, expect, it, vi } from 'vitest';
import type { AudioChunk } from '../audio/types';
import { MockSpeechToTextProvider } from './mockProvider';
import type { TranscriptUpdate, TranscriptionState } from './types';

function chunk(sequence: number): AudioChunk {
  return {
    sequence,
    capturedAt: sequence * 1_000,
    mimeType: 'audio/webm',
    data: new Blob(['audio']),
  };
}

describe('MockSpeechToTextProvider', () => {
  it('emits Japanese interim results followed by one final result', async () => {
    const updates: TranscriptUpdate[] = [];
    const states: TranscriptionState[] = [];
    const provider = new MockSpeechToTextProvider();

    await provider.start({
      sessionId: 'ja-session',
      language: 'ja-JP',
      audioFormat: 'audio/webm;codecs=opus',
      callbacks: {
        onTranscript: (value) => updates.push(value),
        onStateChange: (value) => states.push(value),
      },
    });
    provider.acceptChunk(chunk(0));
    provider.acceptChunk(chunk(1));
    provider.acceptChunk(chunk(2));

    expect(states).toEqual(['connecting', 'transcribing']);
    expect(updates.map(({ isFinal }) => isFinal)).toEqual([false, false, true]);
    expect(updates[2]?.text).toContain('文字起こししています');
    expect(updates[2]).toMatchObject({ provider: 'mock', language: 'ja-JP' });
    expect(new Set(updates.map(({ segmentId }) => segmentId)).size).toBe(1);
  });

  it('can switch from Japanese to English between sessions', async () => {
    const updates: TranscriptUpdate[] = [];
    const provider = new MockSpeechToTextProvider();

    await provider.start({
      sessionId: 'ja-session',
      language: 'ja-JP',
      audioFormat: 'audio/webm;codecs=opus',
      callbacks: { onTranscript: (value) => updates.push(value) },
    });
    provider.acceptChunk(chunk(0));
    await provider.stop();

    await provider.start({
      sessionId: 'en-session',
      language: 'en-US',
      audioFormat: 'audio/webm;codecs=opus',
      callbacks: { onTranscript: (value) => updates.push(value) },
    });
    provider.acceptChunk(chunk(1));
    await provider.stop();

    expect(updates.some(({ language }) => language === 'ja-JP')).toBe(true);
    expect(updates.some(({ language }) => language === 'en-US')).toBe(true);
  });

  it('supports English and finalizes partial text on stop', async () => {
    const updates: TranscriptUpdate[] = [];
    const onStateChange = vi.fn();
    const provider = new MockSpeechToTextProvider();

    await provider.start({
      sessionId: 'en-session',
      language: 'en-US',
      audioFormat: 'audio/webm;codecs=opus',
      callbacks: { onTranscript: (value) => updates.push(value), onStateChange },
    });
    provider.acceptChunk(chunk(0));
    await provider.stop();

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ isFinal: false, language: 'en-US' });
    expect(updates[1]).toMatchObject({ isFinal: true, text: 'Microphone audio' });
    expect(onStateChange).toHaveBeenLastCalledWith('disconnected');
  });
});
