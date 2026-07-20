import { describe, expect, it } from 'vitest';
import { createInitialMeetingSetupDraft, createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { CompletedSentence } from '../transcription/types';
import { InMemoryMeetingHistoryRepository } from './inMemoryMeetingHistoryRepository';
import { createMeetingRecord, type MeetingRecord } from './meetingRecord';

const baseDate = '2026-07-20T00:00:00.000Z';

function sentence(meetingId: string): CompletedSentence {
  return {
    id: `sentence-${meetingId}`,
    sessionId: meetingId,
    rawSegmentIds: [`segment-${meetingId}`],
    rawText: `transcript for ${meetingId}`,
    revision: 1,
    displayText: `transcript for ${meetingId}`,
    language: 'en',
    startTime: 0,
    endTime: 10,
    completionReason: 'recording_stopped',
  };
}

function record(
  meetingId: string,
  updatedAt = baseDate,
  createdAt = baseDate,
  title = meetingId,
): MeetingRecord {
  const settingsSnapshot = createMeetingSettingsSnapshot(
    { ...createInitialMeetingSetupDraft('mock'), title },
    createdAt,
  );
  return createMeetingRecord({
    meetingId,
    createdAt,
    startedAt: null,
    endedAt: null,
    updatedAt,
    settingsSnapshot,
    sentences: [sentence(meetingId)],
  });
}

describe('InMemoryMeetingHistoryRepository', () => {
  it('saves and returns a record while unknown or invalid IDs return null', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    const value = record('meeting-1');
    await repository.save(value);

    await expect(repository.getById('meeting-1')).resolves.toEqual(value);
    await expect(repository.getById('missing')).resolves.toBeNull();
    await expect(repository.getById('')).resolves.toBeNull();
    await expect(repository.getById(' invalid ')).resolves.toBeNull();
  });

  it('updates rather than duplicates a record with the same meeting ID', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    await repository.save(record('meeting-1', baseDate, baseDate, 'Before'));
    await repository.save(record('meeting-1', '2026-07-20T02:00:00.000Z', baseDate, 'After'));

    await expect(repository.list()).resolves.toHaveLength(1);
    await expect(repository.getById('meeting-1')).resolves.toMatchObject({ title: 'After' });
  });

  it('lists newest updated records first and uses createdAt then ID as deterministic tie breakers', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    await repository.save(record('meeting-c', '2026-07-20T02:00:00.000Z', '2026-07-20T01:00:00.000Z'));
    await repository.save(record('meeting-b', '2026-07-20T02:00:00.000Z', '2026-07-20T00:00:00.000Z'));
    await repository.save(record('meeting-a', '2026-07-20T02:00:00.000Z', '2026-07-20T00:00:00.000Z'));
    await repository.save(record('meeting-newest', '2026-07-20T03:00:00.000Z'));

    await expect(repository.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ meetingId: 'meeting-newest' }),
      expect.objectContaining({ meetingId: 'meeting-c' }),
      expect.objectContaining({ meetingId: 'meeting-a' }),
      expect.objectContaining({ meetingId: 'meeting-b' }),
    ]));
    expect((await repository.list()).map((item) => item.meetingId)).toEqual([
      'meeting-newest', 'meeting-c', 'meeting-a', 'meeting-b',
    ]);
  });

  it('deletes one record without affecting another and distinguishes a missing ID', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    await repository.save(record('meeting-1'));
    await repository.save(record('meeting-2'));

    await expect(repository.deleteById('meeting-1')).resolves.toBe(true);
    await expect(repository.deleteById('meeting-1')).resolves.toBe(false);
    await expect(repository.deleteById('')).resolves.toBe(false);
    await expect(repository.getById('meeting-2')).resolves.not.toBeNull();
  });

  it('clears all records in only this repository', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    await repository.save(record('meeting-1'));
    await repository.save(record('meeting-2'));

    await repository.clear();

    await expect(repository.list()).resolves.toEqual([]);
  });

  it('does not share records between repository instances', async () => {
    const first = new InMemoryMeetingHistoryRepository();
    const second = new InMemoryMeetingHistoryRepository();
    await first.save(record('meeting-1'));

    await expect(first.list()).resolves.toHaveLength(1);
    await expect(second.list()).resolves.toEqual([]);
  });

  it('copies the input when saving', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    const input = record('meeting-1');
    await repository.save(input);
    input.transcript.utterances[0]!.rawText = 'mutated input';
    input.title = 'mutated input title';

    await expect(repository.getById('meeting-1')).resolves.toMatchObject({
      title: 'meeting-1',
      transcript: { utterances: [{ rawText: 'transcript for meeting-1' }] },
    });
  });

  it('copies values returned by getById', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    await repository.save(record('meeting-1'));
    const returned = await repository.getById('meeting-1');
    if (!returned) throw new Error('test record missing');
    returned.transcript.utterances[0]!.rawText = 'mutated result';
    returned.title = 'mutated result title';

    await expect(repository.getById('meeting-1')).resolves.toMatchObject({
      title: 'meeting-1',
      transcript: { utterances: [{ rawText: 'transcript for meeting-1' }] },
    });
  });

  it('copies the list, its records, and their nested values', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    await repository.save(record('meeting-1'));
    const returned = await repository.list();
    returned[0]!.transcript.utterances[0]!.sourceSegmentIds.push('mutated');
    returned[0]!.title = 'mutated title';
    returned.push(record('injected'));

    const stored = await repository.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ title: 'meeting-1' });
    expect(stored[0]?.transcript.utterances[0]?.sourceSegmentIds).toEqual(['segment-meeting-1']);
  });

  it('rejects an invalid record without replacing a previously saved valid record', async () => {
    const repository = new InMemoryMeetingHistoryRepository();
    const valid = record('meeting-1');
    await repository.save(valid);
    const invalid = { ...valid, updatedAt: 'not-a-date', title: 'Invalid replacement' } as MeetingRecord;

    await expect(repository.save(invalid)).rejects.toThrow();
    await expect(repository.getById('meeting-1')).resolves.toEqual(valid);
  });
});
