import type { MeetingRecord } from './meetingRecord';

export interface MeetingHistoryRepository {
  save(record: MeetingRecord): Promise<void>;
  getById(meetingId: string): Promise<MeetingRecord | null>;
  list(): Promise<MeetingRecord[]>;
  deleteById(meetingId: string): Promise<boolean>;
  clear(): Promise<void>;
}

export function compareMeetingRecords(left: MeetingRecord, right: MeetingRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || left.meetingId.localeCompare(right.meetingId);
}

export function isValidMeetingHistoryId(value: string): boolean {
  return Boolean(value) && value.length <= 200 && value.trim() === value;
}
