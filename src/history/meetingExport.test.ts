import { afterEach, expect, it, vi } from 'vitest';
import { createMeetingRecord } from './meetingRecord';
import { createInitialMeetingSetupDraft, createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import { meetingExportFilename, meetingExportText, shareMeeting } from './meetingExport';

const date = '2026-11-06T01:00:00.000Z';
function record() {
  return createMeetingRecord({ meetingId: 'synthetic-meeting', createdAt: date, updatedAt: date,
    startedAt: date, endedAt: date, title: '<架空の会議>:/', sentences: [],
    settingsSnapshot: createMeetingSettingsSnapshot(createInitialMeetingSetupDraft('mock'), date),
  });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('exports readable meeting content without internal identifiers or configuration', () => {
  const text = meetingExportText(record());
  expect(text).toContain('<架空の会議>:/');
  expect(text).toContain('最終要約はありません');
  expect(text).not.toContain('synthetic-meeting');
  expect(text).not.toContain('settingsSnapshot');
  expect(meetingExportFilename(record(), 'pdf')).toBe('Minutes-_架空の会議___.pdf');
});

it('shares a text file only after explicitly invoking sharing', async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { share, canShare: () => true });
  expect(share).not.toHaveBeenCalled();
  expect(await shareMeeting(record())).toBe('shared');
  expect(share.mock.calls[0]?.[0].files[0].name).toMatch(/\.txt$/);
});

it('treats native share cancellation as cancellation without downloading or retrying', async () => {
  const share = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
  vi.stubGlobal('navigator', { share, canShare: () => true });
  expect(await shareMeeting(record())).toBe('cancelled');
  expect(share).toHaveBeenCalledTimes(1);
});

it('downloads a text file when native file sharing is unavailable and releases its URL', async () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn().mockReturnValue('blob:synthetic');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  vi.stubGlobal('navigator', {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  expect(await shareMeeting(record())).toBe('downloaded');
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(click).toHaveBeenCalledTimes(1);
  expect(document.querySelector('a[download]')).toBeNull();
  vi.runAllTimers();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
  click.mockRestore();
});
