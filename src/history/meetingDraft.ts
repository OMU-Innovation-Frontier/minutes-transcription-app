import { parseMeetingRecord, type MeetingRecord } from './meetingRecord';

const prefix = 'minutes.active-meeting.';

export function saveMeetingDraft(record: MeetingRecord): void {
  localStorage.setItem(prefix + record.meetingId, JSON.stringify(record));
}

export function removeMeetingDraft(meetingId: string): void {
  localStorage.removeItem(prefix + meetingId);
}

export function loadMeetingDraft(): MeetingRecord | null {
  const drafts: MeetingRecord[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const record = parseMeetingRecord(JSON.parse(localStorage.getItem(key) ?? 'null'));
      if (record.endedAt === null && key === prefix + record.meetingId) drafts.push(record);
    } catch {
      // A damaged draft must not prevent other drafts from being recovered.
    }
  }
  return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}
