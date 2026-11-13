import { afterEach, expect, it, vi } from 'vitest';
import { createMeetingPdf } from './meetingPdf';
import { createMeetingRecord } from './meetingRecord';
import { createInitialMeetingSetupDraft, createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import { createFinalMeetingSummaryRecord } from '../summary/finalMeetingSummary';

const { render, from } = vi.hoisted(() => ({ render: vi.fn(), from: vi.fn() }));
vi.mock('html2pdf.js', () => ({ default: () => ({
  set: () => ({ from: (element: HTMLElement) => {
    from(element);
    const overlay = document.createElement('div');
    overlay.className = 'html2pdf__overlay';
    document.body.append(overlay);
    return { toContainer: () => ({ get: async () => overlay, outputPdf: render }) };
  } }),
}) }));
const date = '2026-11-12T01:00:00.000Z';
function record() {
  return createMeetingRecord({
    meetingId: 'synthetic-pdf', createdAt: date, updatedAt: date, startedAt: date, endedAt: date,
    settingsSnapshot: createMeetingSettingsSnapshot(createInitialMeetingSetupDraft('mock'), date),
    sentences: [],
    finalSummary: createFinalMeetingSummaryRecord('synthetic-pdf', {
      version: 1, overview: '合成の最終要約です。', agenda: [], keyPoints: [], decisions: [],
      unresolvedItems: [], actionItems: [], nextChecks: [],
    }, date, 'mock'),
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('converts summary HTML into PDF bytes and removes temporary content', async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
  render.mockResolvedValue(new Uint8Array([37, 80, 68, 70]).buffer);
  const before = document.body.childElementCount;
  expect(await createMeetingPdf(record())).toEqual(new Uint8Array([37, 80, 68, 70]));
  expect(from.mock.calls[0]?.[0].textContent).toContain('合成の最終要約です。');
  expect(document.body.childElementCount).toBe(before);
});
it('cleans up the temporary document when conversion fails', async () => {
  render.mockRejectedValueOnce(new Error('synthetic conversion failure'));
  const before = document.body.childElementCount;
  await expect(createMeetingPdf(record())).rejects.toThrow('synthetic conversion failure');
  expect(document.body.childElementCount).toBe(before);
});
