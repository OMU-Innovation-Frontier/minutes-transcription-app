import type { MeetingHistoryRepository } from './meetingHistoryRepository';
import { parseMeetingRecord, type MeetingRecord } from './meetingRecord';

export class InMemoryMeetingHistoryRepository implements MeetingHistoryRepository {
  private readonly records = new Map<string, MeetingRecord>();

  async save(record: MeetingRecord): Promise<void> {
    const copy = parseMeetingRecord(record);
    this.records.set(copy.meetingId, copy);
  }

  async getById(meetingId: string): Promise<MeetingRecord | null> {
    if (!isRepositoryId(meetingId)) return null;
    const record = this.records.get(meetingId);
    return record ? parseMeetingRecord(record) : null;
  }

  async list(): Promise<MeetingRecord[]> {
    return [...this.records.values()]
      .map((record) => parseMeetingRecord(record))
      .sort(compareMeetingRecords);
  }

  async deleteById(meetingId: string): Promise<boolean> {
    if (!isRepositoryId(meetingId)) return false;
    return this.records.delete(meetingId);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

function compareMeetingRecords(left: MeetingRecord, right: MeetingRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || left.meetingId.localeCompare(right.meetingId);
}

function isRepositoryId(value: string): boolean {
  return Boolean(value) && value.length <= 200 && value.trim() === value;
}
