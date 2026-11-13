import type { MeetingRecord } from './meetingRecord';

export function meetingExportTitle(record: MeetingRecord): string {
  return record.title?.trim() || record.settingsSnapshot.title.trim() || '無題の会議';
}

export function meetingExportFilename(record: MeetingRecord, extension: 'pdf' | 'txt'): string {
  const safeTitle = Array.from(meetingExportTitle(record).replace(/[<>:"/\\|?*]/g, '_'))
    .map((char) => char.codePointAt(0)! < 32 ? '_' : char).join('').slice(0, 80);
  return `Minutes-${safeTitle}.${extension}`;
}

export function downloadMeetingFile(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Allow the browser to consume the download before releasing its URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
