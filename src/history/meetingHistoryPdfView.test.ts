import { expect, it, vi } from 'vitest';
import { renderMeetingHistoryList } from './meetingHistoryListView';
import { createMeetingRecord } from './meetingRecord';
import { createInitialMeetingSetupDraft, createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';

it('starts PDF export for the selected persisted meeting and prevents duplicate requests while busy', () => {
  const date = '2026-11-12T01:00:00.000Z';
  const record = createMeetingRecord({
    meetingId: 'synthetic-history-pdf', createdAt: date, updatedAt: date,
    startedAt: date, endedAt: date, sentences: [],
    settingsSnapshot: createMeetingSettingsSnapshot(createInitialMeetingSetupDraft('mock'), date),
  });
  const elements = {
    list: document.createElement('ol'), empty: document.createElement('div'),
    status: document.createElement('div'), statusMessage: document.createElement('div'),
    retryButton: document.createElement('button'),
  };
  const onPdf = vi.fn();
  let busy = false;
  const actions = { onPdf, onDelete: vi.fn(), disabled: () => busy };
  const render = () => renderMeetingHistoryList(elements, { status: 'ready', records: [record] },
    null, (value) => value, vi.fn(), actions);
  const pdfButton = () => [...elements.list.querySelectorAll('button')]
    .find((button) => button.textContent === 'PDFとしてダウンロード');
  render();
  pdfButton()?.click();
  expect(onPdf).toHaveBeenCalledExactlyOnceWith('synthetic-history-pdf');
  busy = true;
  render();
  expect(pdfButton()?.disabled).toBe(true);
  pdfButton()?.click();
  expect(onPdf).toHaveBeenCalledTimes(1);
});
