// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { validateSummaryInput } from '../src/summary/summaryInput';
import { SummaryService } from '../src/summary/summaryService';
import { MockSummaryProvider } from '../src/summary/mockSummaryProvider';
import { ApiUsageStore } from '../src/summary/usageStore';
import { loadSummaryConfig } from '../src/summary/config';

const sentence = { id: 's1', text: '架空のテスト発言です。', startTime: 0, endTime: 1 };
const input = { meetingId: 'meeting-1', sentences: [sentence], liveSummary: null };
describe('summary request boundary', () => {
  it('accepts bounded text-only completed sentences', () => {
    expect(validateSummaryInput(input, true)).toEqual(input);
    expect(validateSummaryInput({ meetingId: 'meeting-1', newSentences: [sentence], previousSummary: null }, false).newSentences).toEqual([sentence]);
  });
  it.each([
    null, [], {}, { ...input, meetingId: '../secret' }, { ...input, extra: 'do not transmit' },
    { ...input, audio: 'do not transmit' }, { ...input, sentences: [] }, { ...input, sentences: [sentence, sentence] },
    { ...input, sentences: [{ ...sentence, interim: true }] }, { ...input, sentences: [{ ...sentence, text: '' }] },
    { ...input, sentences: [{ ...sentence, endTime: -1 }] }, { ...input, sentences: [{ ...sentence, startTime: NaN }] },
    { ...input, sentences: [{ ...sentence, text: 'a'.repeat(20001) }] },
    { ...input, sentences: Array.from({ length: 8 }, (_, i) => ({ ...sentence, id: `s${i}`, text: 'a'.repeat(20000) })) },
  ])('rejects invalid request data without calling the provider', async (value) => {
    const provider = new MockSummaryProvider();
    const finalize = vi.spyOn(provider, 'createFinalSummary');
    const service = new SummaryService({ ...loadSummaryConfig({}), enabled: true }, provider, new ApiUsageStore());
    await expect(service.finalize(value as never)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(finalize).not.toHaveBeenCalled();
  });
});
