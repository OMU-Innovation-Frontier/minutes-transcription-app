import type { MeetingRecord } from './meetingRecord';

export interface MeetingHistoryRepository {
  save(record: MeetingRecord): Promise<void>;
  getById(meetingId: string): Promise<MeetingRecord | null>;
  list(): Promise<MeetingRecord[]>;
  deleteById(meetingId: string): Promise<boolean>;
  clear(): Promise<void>;
}
