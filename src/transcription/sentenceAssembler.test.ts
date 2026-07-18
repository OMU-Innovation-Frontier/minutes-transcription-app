import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentenceAssembler, hasSentenceEnding } from './sentenceAssembler';
import type { CompletedSentence, RawTranscriptSegment } from './types';

afterEach(() => vi.useRealTimers());

function segment(text: string, overrides: Partial<RawTranscriptSegment> = {}): RawTranscriptSegment {
  return {
    id: `raw-${text}`, sessionId: 'session-1', text, isFinal: true,
    startTime: 0, endTime: 100, language: 'ja', provider: 'test', revision: 0, ...overrides,
  };
}

function harness() {
  vi.useFakeTimers();
  let now = 0;
  const sentences: CompletedSentence[] = [];
  const assembler = new SentenceAssembler({
    silenceMs: 1_200, maxDurationMs: 20_000, maxCharsJa: 12, maxCharsEn: 30,
    now: () => now, createId: () => `sentence-${sentences.length + 1}`,
    onSentence: (sentence) => sentences.push(sentence),
  });
  return { assembler, sentences, setNow: (value: number) => { now = value; } };
}

describe('SentenceAssembler', () => {
  it('completes Japanese text at sentence punctuation', () => {
    const h = harness();
    h.assembler.add(segment('今日は'));
    h.assembler.add(segment('説明します。', { id: 'raw-2', startTime: 100 }));
    expect(h.sentences).toHaveLength(0);
    vi.advanceTimersByTime(1_200);
    expect(h.sentences[0]).toMatchObject({ rawText: '今日は説明します。', completionReason: 'punctuation' });
    expect(h.sentences[0]?.rawSegmentIds).toEqual(['raw-今日は', 'raw-2']);
  });

  it('keeps interim-sized final segments on one line until silence', () => {
    const h = harness();
    h.assembler.add(segment('今日は'));
    h.setNow(800);
    vi.advanceTimersByTime(800);
    expect(h.sentences).toHaveLength(0);
    h.assembler.add(segment('議事録について', { id: 'raw-2', startTime: 100 }));
    h.setNow(2_000);
    vi.advanceTimersByTime(1_200);
    expect(h.sentences[0]).toMatchObject({ rawText: '今日は議事録について', displayText: '今日は議事録について。', completionReason: 'silence' });
  });

  it('does not complete during a pause shorter than the silence threshold', () => {
    const h = harness();
    h.assembler.add(segment('短い発言'));
    h.setNow(1_199);
    vi.advanceTimersByTime(1_199);
    expect(h.sentences).toHaveLength(0);
  });

  it('completes when maximum Japanese length is reached', () => {
    const h = harness();
    h.assembler.add(segment('これはかなり長い発言テキストです'));
    expect(h.sentences[0]?.completionReason).toBe('max_length');
  });

  it('completes when maximum duration is reached', () => {
    const h = harness();
    h.setNow(20_000);
    h.assembler.add(segment('継続中', { startTime: 0, endTime: 20_000 }));
    expect(h.sentences[0]?.completionReason).toBe('max_duration');
  });

  it('supports manual and recording-stopped completion reasons', () => {
    const h = harness();
    h.assembler.add(segment('手動'));
    expect(h.assembler.flush('manual')?.completionReason).toBe('manual');
    h.assembler.add(segment('停止'));
    expect(h.assembler.flush('recording_stopped')?.completionReason).toBe('recording_stopped');
  });

  it('merges ように。 followed by a short します。 continuation', () => {
    const h = harness();
    const first = segment('このHTMLファイルに機能を追加するように。', { id: 'raw-1', startTime: 0, endTime: 500 });
    const second = segment('します。', { id: 'raw-2', startTime: 700, endTime: 900 });
    h.assembler.add(first);
    h.assembler.add(second);
    vi.advanceTimersByTime(1_200);
    expect(h.sentences[0]).toMatchObject({
      rawText: 'このHTMLファイルに機能を追加するように。します。',
      displayText: 'このHTMLファイルに機能を追加するようにします。',
      completionReason: 'merged_short_continuation',
    });
    expect(h.sentences[0]?.rawSegmentIds).toEqual(['raw-1', 'raw-2']);
    expect([first.text, second.text]).toEqual(['このHTMLファイルに機能を追加するように。', 'します。']);
  });

  it('merges ことに。 followed by a short なります。 continuation', () => {
    const h = harness();
    h.assembler.add(segment('次回からこの方式を使うことに。', { id: 'raw-1', endTime: 500 }));
    h.assembler.add(segment('なります。', { id: 'raw-2', startTime: 600, endTime: 800 }));
    vi.advanceTimersByTime(1_200);
    expect(h.sentences[0]).toMatchObject({
      displayText: '次回からこの方式を使うことになります。',
      completionReason: 'merged_short_continuation',
    });
  });

  it('keeps independent Japanese sentences separate', () => {
    const h = harness();
    h.assembler.add(segment('問題ありません。', { id: 'raw-1', endTime: 500 }));
    h.assembler.add(segment('次に進みます。', { id: 'raw-2', startTime: 600, endTime: 800 }));
    vi.advanceTimersByTime(1_200);
    expect(h.sentences.map((item) => item.displayText)).toEqual(['問題ありません。', '次に進みます。']);
  });

  it('does not merge a standalone short response', () => {
    const h = harness();
    h.assembler.add(segment('これは重要です。', { id: 'raw-1', endTime: 500 }));
    h.assembler.add(segment('はい。', { id: 'raw-2', startTime: 600, endTime: 800 }));
    vi.advanceTimersByTime(1_200);
    expect(h.sentences.map((item) => item.displayText)).toEqual(['これは重要です。', 'はい。']);
  });

  it('does not merge a short continuation after a long timestamp gap', () => {
    const h = harness();
    h.assembler.add(segment('この方式を使うように。', { id: 'raw-1', endTime: 100 }));
    h.setNow(2_000);
    h.assembler.add(segment('します。', { id: 'raw-2', startTime: 2_000, endTime: 2_200 }));
    vi.advanceTimersByTime(1_200);
    expect(h.sentences.map((item) => item.displayText)).toEqual(['この方式を使うように。', 'します。']);
    expect(h.sentences.every((item) => item.completionReason === 'punctuation')).toBe(true);
  });

  it('does not lose a punctuation candidate when recording stops during the merge window', () => {
    const h = harness();
    h.assembler.add(segment('停止前に保存します。', { id: 'raw-1' }));
    expect(h.sentences).toHaveLength(0);
    expect(h.assembler.flush('recording_stopped')).toMatchObject({
      rawText: '停止前に保存します。',
      completionReason: 'punctuation',
    });
    expect(h.sentences).toHaveLength(1);
  });

  it('recognizes English punctuation but avoids common abbreviations and decimals', () => {
    expect(hasSentenceEnding('We are done.', 'en')).toBe(true);
    expect(hasSentenceEnding('Dr.', 'en')).toBe(false);
    expect(hasSentenceEnding('The value is 3.14', 'en')).toBe(false);
  });

  it('joins English segments with spaces without changing raw segment text', () => {
    const h = harness();
    h.assembler.add(segment('This is', { language: 'en', id: 'en-1' }));
    h.assembler.add(segment('complete.', { language: 'en', id: 'en-2' }));
    expect(h.sentences[0]).toMatchObject({ rawText: 'This is complete.', displayText: 'This is complete.' });
  });
});
