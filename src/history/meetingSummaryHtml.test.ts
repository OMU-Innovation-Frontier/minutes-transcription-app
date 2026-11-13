import { expect, it } from 'vitest';
import { createMeetingRecord } from './meetingRecord';
import { createInitialMeetingSetupDraft, createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import { createFinalMeetingSummaryRecord } from '../summary/finalMeetingSummary';
import { createMeetingSummaryHtml } from './meetingSummaryHtml';

const date = '2026-11-12T01:00:00.000Z';
function record(withSummary = true) {
  return createMeetingRecord({
    meetingId: 'synthetic-summary-export', createdAt: date, updatedAt: date, startedAt: date, endedAt: date,
    title: '<img src=x onerror=alert(1)> 合成会議',
    settingsSnapshot: createMeetingSettingsSnapshot(createInitialMeetingSetupDraft('mock'), date),
    sentences: [{ id: 'sentence-1', sessionId: 'synthetic', rawSegmentIds: ['segment-1'],
      rawText: 'PDFに含めない合成の文字起こし', displayText: '合成発言', revision: 1,
      language: 'ja', startTime: 0, endTime: 1000, completionReason: 'recording_stopped' }],
    finalSummary: withSummary ? createFinalMeetingSummaryRecord('synthetic-summary-export', {
      version: 1, overview: '合成の概要です。', agenda: [], keyPoints: [],
      decisions: [{ text: '次回日程を決定', evidenceSentenceIds: ['sentence-1'] }],
      unresolvedItems: [], nextChecks: [],
      actionItems: [{ task: '会場を予約', assignee: '合成担当', dueDate: '翌週', evidenceSentenceIds: ['sentence-1'] }],
    }, date, 'mock') : null,
  });
}

it('renders all final summary sections and TODOs without transcript or executable user markup', () => {
  const source = record();
  const before = JSON.stringify(source);
  const html = createMeetingSummaryHtml(source);
  expect(html.textContent).toContain('合成の概要です。');
  expect(html.textContent).toContain('次回日程を決定');
  expect(html.textContent).toContain('会場を予約');
  expect(html.textContent).toContain('合成担当');
  expect(html.textContent).toContain('翌週');
  expect(html.textContent).not.toContain('PDFに含めない合成の文字起こし');
  expect(html.querySelectorAll('img, script, iframe')).toHaveLength(0);
  expect(html.querySelector('h1')?.textContent).toContain('<img');
  expect(JSON.stringify(source)).toBe(before);
});

it('requires a saved final summary', () => {
  expect(() => createMeetingSummaryHtml(record(false))).toThrow('最終要約');
});
