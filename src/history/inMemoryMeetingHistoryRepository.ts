import {
  compareMeetingRecords,
  isValidMeetingHistoryId,
  type MeetingHistoryRepository,
} from './meetingHistoryRepository';
import { parseMeetingRecord, type MeetingRecord } from './meetingRecord';

export class InMemoryMeetingHistoryRepository implements MeetingHistoryRepository {
  private readonly records = new Map<string, MeetingRecord>();

  async save(record: MeetingRecord, { preserveTitle = false } = {}): Promise<void> {
    const previous = preserveTitle ? this.records.get(record.meetingId) : undefined;
    const copy = parseMeetingRecord(previous ? { ...record, title: previous.title } : record);
    this.records.set(copy.meetingId, copy);
  }

  async renameById(meetingId: string, title: string): Promise<boolean> {
    const record = this.records.get(meetingId);
    if (!record) return false;
    this.records.set(meetingId, parseMeetingRecord({ ...record, title }));
    return true;
  }

  async getById(meetingId: string): Promise<MeetingRecord | null> {
    if (!isValidMeetingHistoryId(meetingId)) return null;
    const record = this.records.get(meetingId);
    return record ? parseMeetingRecord(record) : null;
  }

  async list(): Promise<MeetingRecord[]> {
    return [...this.records.values()]
      .map((record) => parseMeetingRecord(record))
      .sort(compareMeetingRecords);
  }

  async deleteById(meetingId: string): Promise<boolean> {
    if (!isValidMeetingHistoryId(meetingId)) return false;
    return this.records.delete(meetingId);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}
