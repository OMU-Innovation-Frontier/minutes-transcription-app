import { afterEach, expect, it, vi } from 'vitest';
import { createInitialMeetingSetupDraft, createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import { createMeetingRecord } from './meetingRecord';
import { createMeetingPdfFile } from './meetingPdf';
import { initializeMeetingShareDialog } from './meetingShareDialog';

vi.mock('./meetingPdf', () => ({ createMeetingPdfFile: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const date = '2026-11-27T01:00:00.000Z';
  const record = createMeetingRecord({
    meetingId: 'sample', createdAt: date, updatedAt: date, startedAt: date, endedAt: date,
    settingsSnapshot: createMeetingSettingsSnapshot(createInitialMeetingSetupDraft('mock'), date), sentences: [],
  });
  const elements = {
    dialog: document.createElement('dialog'),
    title: document.createElement('p'),
    download: document.createElement('button'),
    nativeShare: document.createElement('button'),
    status: document.createElement('p'),
  };
  elements.dialog.showModal = () => { elements.dialog.open = true; };
  const actions = initializeMeetingShareDialog(elements);
  return { elements, actions, record };
}

it('prepares one PDF and shares only that file on an explicit click', async () => {
  const file = new File(['%PDF'], 'sample.pdf', { type: 'application/pdf' });
  vi.mocked(createMeetingPdfFile).mockResolvedValue(file);
  const share = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { canShare: () => true, share });
  const { elements, actions, record } = setup();

  actions.open(record);
  expect(elements.download.disabled).toBe(true);
  expect(share).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(elements.download.disabled).toBe(false));
  expect(elements.nativeShare.hidden).toBe(false);

  elements.nativeShare.click();
  expect(share).toHaveBeenCalledExactlyOnceWith({ files: [file] });
});

it('can retry PDF preparation and uses the save option if file sharing is unavailable', async () => {
  const file = new File(['%PDF'], 'sample.pdf', { type: 'application/pdf' });
  vi.mocked(createMeetingPdfFile).mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValue(file);
  vi.stubGlobal('navigator', {});
  const { elements, actions, record } = setup();

  actions.open(record);
  await vi.waitFor(() => expect(elements.download.textContent).toBe('PDFを再作成'));
  elements.download.click();
  await vi.waitFor(() => expect(elements.download.disabled).toBe(false));
  expect(elements.download.textContent).toBe('PDFを保存');
  expect(elements.nativeShare.hidden).toBe(true);
});
