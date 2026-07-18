// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  calculateCharacterErrorRate,
  calculateHotwordAccuracy,
  calculateRealTimeFactor,
  calculateWordErrorRate,
  evaluateSttProvider,
} from '../src/providers/evaluationHarness';
import { MockServerSpeechToTextProvider } from '../src/providers/mockProvider';

describe('STT evaluation harness', () => {
  it('records comparable latency fields without logging audio content', async () => {
    let now = 1_000;
    const record = await evaluateSttProvider({
      provider: new MockServerSpeechToTextProvider(),
      model: 'mock-model',
      sessionId: 'evaluation-1',
      language: 'ja',
      audioFormat: 'audio/webm;codecs=opus',
      audioDurationSeconds: 3,
      chunks: [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
    }, () => { now += 10; return now; });
    expect(record).toMatchObject({
      provider: 'server-mock', model: 'mock-model', language: 'ja', audioDurationSeconds: 3,
    });
    expect(record.firstPartialLatencyMs).toBeDefined();
    expect(record.finalLatencyMs).toBeDefined();
    expect(record.transcript).not.toBe('');
    expect(record).not.toHaveProperty('audio');
  });

  it('calculates Japanese character error rate without inventing WER tokenization', () => {
    expect(calculateCharacterErrorRate('日本語です', '日本語てす')).toBe(0.2);
  });

  it('calculates whitespace-tokenized English word error rate', () => {
    expect(calculateWordErrorRate('the quick fox', 'the slow fox')).toBeCloseTo(1 / 3);
  });

  it('calculates explicit hotword accuracy', () => {
    expect(calculateHotwordAccuracy(['Codex', 'AmiVoice'], 'Codex を評価します')).toBe(0.5);
  });

  it('calculates processing-time real-time factor', () => {
    expect(calculateRealTimeFactor(2_500, 5)).toBe(0.5);
  });
});
