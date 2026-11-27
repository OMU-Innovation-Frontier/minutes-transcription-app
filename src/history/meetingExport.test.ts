import { afterEach, expect, it, vi } from 'vitest';
import { createMeetingRecord } from './meetingRecord';
import { createInitialMeetingSetupDraft, createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import { downloadMeetingFile, meetingPdfFilename } from './meetingExport';

const date = '2026-11-06T01:00:00.000Z';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('sanitizes the meeting title for the PDF filename', () => {
  const record = createMeetingRecord({ meetingId: 'synthetic-meeting', createdAt: date, updatedAt: date,
    startedAt: date, endedAt: date, title: '<架空の会議>:/', sentences: [],
    settingsSnapshot: createMeetingSettingsSnapshot(createInitialMeetingSetupDraft('mock'), date),
  });
  expect(meetingPdfFilename(record)).toBe('Minutes-_架空の会議___.pdf');
});

it('downloads a PDF and releases its object URL', () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn().mockReturnValue('blob:synthetic');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const file = new File([], 'test.pdf', { type: 'application/pdf' });
  downloadMeetingFile(file, file.name);
  expect(createObjectURL).toHaveBeenCalledWith(file);
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector('a[download]')).toBeNull();
  vi.runAllTimers();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
  click.mockRestore();
});
