import { beforeEach, describe, expect, it } from 'vitest';
import type { FinalMeetingSummary } from '../../shared/summary';
import { createMeetingSettingsSnapshot, createInitialMeetingSetupDraft } from '../meetingSetup/meetingSetup';
import { createFinalMeetingSummaryRecord } from '../summary/finalMeetingSummary';
import type { CompletedSentence } from '../transcription/types';
import {
  IndexedDbMeetingHistoryRepository,
  MEETING_HISTORY_DATABASE_NAME,
  MEETING_HISTORY_DATABASE_VERSION,
  MEETING_HISTORY_STORE_KEY_PATH,
  MEETING_HISTORY_STORE_NAME,
  MeetingHistoryRepositoryError,
} from './indexedDbMeetingHistoryRepository';
import { createMeetingRecord, MEETING_RECORD_SCHEMA_VERSION, type MeetingRecord } from './meetingRecord';
import { FakeIndexedDbFactory } from './test/fakeIndexedDb';

const createdAt = '2026-07-20T00:00:00.000Z';
const updatedAt = '2026-07-20T01:00:00.000Z';
const otherStore = 'unrelated-data';

let factory: FakeIndexedDbFactory;
let repository: IndexedDbMeetingHistoryRepository;

beforeEach(() => {
  factory = new FakeIndexedDbFactory();
  repository = new IndexedDbMeetingHistoryRepository(factory.factory);
});

describe('IndexedDbMeetingHistoryRepository database lifecycle', () => {
  it('creates its dedicated versioned database, store, and meetingId key path', async () => {
    await expect(repository.list()).resolves.toEqual([]);

    expect(factory.databaseVersion(MEETING_HISTORY_DATABASE_NAME)).toBe(MEETING_HISTORY_DATABASE_VERSION);
    expect(factory.storeNames(MEETING_HISTORY_DATABASE_NAME)).toEqual([MEETING_HISTORY_STORE_NAME]);
    expect(factory.keyPath(MEETING_HISTORY_DATABASE_NAME, MEETING_HISTORY_STORE_NAME)).toBe(
      MEETING_HISTORY_STORE_KEY_PATH,
    );
    expect(MEETING_RECORD_SCHEMA_VERSION).toBe(1);
  });

  it('does not recreate an existing store or alter another store', async () => {
    factory.precreateStore(
      MEETING_HISTORY_DATABASE_NAME,
      MEETING_HISTORY_DATABASE_VERSION,
      MEETING_HISTORY_STORE_NAME,
      MEETING_HISTORY_STORE_KEY_PATH,
    );
    factory.precreateStore(
      MEETING_HISTORY_DATABASE_NAME,
      MEETING_HISTORY_DATABASE_VERSION,
      otherStore,
      'key',
    );

    await repository.list();

    expect(factory.createObjectStoreCalls).toBe(0);
    expect(factory.storeNames(MEETING_HISTORY_DATABASE_NAME)).toEqual([
      MEETING_HISTORY_STORE_NAME,
      otherStore,
    ]);
  });

  it('rejects an existing history store with an incompatible key path', async () => {
    factory.precreateStore(
      MEETING_HISTORY_DATABASE_NAME,
      MEETING_HISTORY_DATABASE_VERSION,
      MEETING_HISTORY_STORE_NAME,
      'wrongKey',
    );

    await expect(repository.list()).rejects.toMatchObject({ code: 'open_failed' });
    expect(factory.keyPath(MEETING_HISTORY_DATABASE_NAME, MEETING_HISTORY_STORE_NAME)).toBe('wrongKey');
  });

  it('shares one successful open across concurrent repository calls', async () => {
    await Promise.all([repository.list(), repository.getById('missing')]);
    await repository.list();

    expect(factory.openCalls).toBe(1);
  });

  it('clears a failed open attempt so the next operation can retry', async () => {
    factory.failNextOpen = true;

    await expect(repository.list()).rejects.toMatchObject({ code: 'open_failed' });
    await expect(repository.list()).resolves.toEqual([]);
    expect(factory.openCalls).toBe(2);
  });

  it('treats a blocked open as retryable instead of caching its failure', async () => {
    factory.blockNextOpen = true;

    await expect(repository.list()).rejects.toMatchObject({ code: 'open_failed' });
    await expect(repository.list()).resolves.toEqual([]);
    expect(factory.openCalls).toBe(2);
  });

  it('closes on versionchange and reconnects on the next operation', async () => {
    await repository.list();
    factory.triggerVersionChange(MEETING_HISTORY_DATABASE_NAME);

    expect(factory.closeCalls).toBe(1);
    await repository.list();
    expect(factory.openCalls).toBe(2);
  });

  it('allows explicit close for test cleanup and reconnects afterward', async () => {
    await repository.list();
    await repository.close();
    await repository.list();

    expect(factory.closeCalls).toBe(1);
    expect(factory.openCalls).toBe(2);
  });
});

describe('IndexedDbMeetingHistoryRepository save and getById', () => {
  it('saves, reads, updates one ID, and leaves another ID intact', async () => {
    const first = record('meeting-1');
    const second = record('meeting-2');
    await repository.save(first);
    await repository.save(second);
    await repository.save({ ...first, title: 'Updated', updatedAt: '2026-07-20T02:00:00.000Z' });

    await expect(repository.getById('meeting-1')).resolves.toMatchObject({ title: 'Updated' });
    await expect(repository.getById('meeting-2')).resolves.toMatchObject({ meetingId: 'meeting-2' });
    await expect(repository.getById('missing')).resolves.toBeNull();
    await expect(repository.getById('')).resolves.toBeNull();
  });

  it('rejects an invalid record before opening a transaction', async () => {
    const invalid = { ...record('meeting-1'), meetingId: '' } as MeetingRecord;

    await expect(repository.save(invalid)).rejects.toEqual(expect.objectContaining({
      code: 'invalid_record',
    }));
    expect(factory.openCalls).toBe(0);
  });

  it('does not replace an existing record after an invalid save', async () => {
    const valid = record('meeting-1');
    await repository.save(valid);

    await expect(repository.save({ ...valid, updatedAt: 'invalid' } as MeetingRecord)).rejects.toBeInstanceOf(
      MeetingHistoryRepositoryError,
    );
    await expect(repository.getById('meeting-1')).resolves.toEqual(valid);
  });

  it('waits for transaction completion instead of resolving after request success', async () => {
    factory.holdTransactionCompletion = true;
    let resolved = false;
    const saving = repository.save(record('meeting-1')).then(() => {
      resolved = true;
    });
    await flushMicrotasks();

    expect(resolved).toBe(false);
    expect(factory.read(MEETING_HISTORY_DATABASE_NAME, MEETING_HISTORY_STORE_NAME, 'meeting-1')).toBeUndefined();

    factory.releaseTransactions();
    await saving;
    expect(resolved).toBe(true);
  });

  it('rejects aborted, failed, and request-error transactions without committing data', async () => {
    factory.abortNextTransaction = true;
    await expect(repository.save(record('aborted'))).rejects.toMatchObject({ code: 'aborted' });

    factory.failNextRequest = true;
    await expect(repository.save(record('request-error'))).rejects.toMatchObject({ code: 'request_failed' });

    factory.failNextTransaction = true;
    await expect(repository.save(record('transaction-error'))).rejects.toMatchObject({ code: 'transaction_failed' });

    await expect(repository.list()).resolves.toEqual([]);
  });

  it('supports concurrent saves without losing either meeting', async () => {
    await Promise.all([repository.save(record('meeting-1')), repository.save(record('meeting-2'))]);

    await expect(repository.list()).resolves.toHaveLength(2);
    const [first, second] = await Promise.all([
      repository.getById('meeting-1'),
      repository.getById('meeting-2'),
    ]);
    expect(first?.meetingId).toBe('meeting-1');
    expect(second?.meetingId).toBe('meeting-2');
  });
});

describe('IndexedDbMeetingHistoryRepository list', () => {
  it('returns an empty array and sorts independently of insertion order', async () => {
    await expect(repository.list()).resolves.toEqual([]);

    await repository.save(record('meeting-b', '2026-07-20T03:00:00.000Z', '2026-07-20T00:00:00.000Z'));
    await repository.save(record('meeting-c', '2026-07-20T03:00:00.000Z', '2026-07-20T01:00:00.000Z'));
    await repository.save(record('meeting-a', '2026-07-20T03:00:00.000Z', '2026-07-20T01:00:00.000Z'));
    await repository.save(record('meeting-newest', '2026-07-20T04:00:00.000Z'));

    const listed = await repository.list();
    expect(listed.map(({ meetingId }) => meetingId)).toEqual([
      'meeting-newest',
      'meeting-a',
      'meeting-c',
      'meeting-b',
    ]);
  });

  it('fails the entire list for a corrupt record without deleting it', async () => {
    await repository.list();
    factory.seed(MEETING_HISTORY_DATABASE_NAME, MEETING_HISTORY_STORE_NAME, 'corrupt', {
      meetingId: 'corrupt',
      schemaVersion: MEETING_RECORD_SCHEMA_VERSION,
    });

    await expect(repository.list()).rejects.toMatchObject({ code: 'corrupt_record' });
    expect(factory.read(MEETING_HISTORY_DATABASE_NAME, MEETING_HISTORY_STORE_NAME, 'corrupt')).toBeDefined();
  });

  it('rejects an unsupported MeetingRecord schema read from the database', async () => {
    await repository.list();
    const unsupported = { ...record('future'), schemaVersion: MEETING_RECORD_SCHEMA_VERSION + 1 };
    factory.seed(MEETING_HISTORY_DATABASE_NAME, MEETING_HISTORY_STORE_NAME, 'future', unsupported);

    await expect(repository.getById('future')).rejects.toMatchObject({ code: 'corrupt_record' });
    await expect(repository.list()).rejects.toMatchObject({ code: 'corrupt_record' });
  });
});

describe('IndexedDbMeetingHistoryRepository delete and clear', () => {
  it('deletes only an existing meeting and distinguishes a missing ID', async () => {
    await repository.save(record('meeting-1'));
    await repository.save(record('meeting-2'));

    await expect(repository.deleteById('meeting-1')).resolves.toBe(true);
    await expect(repository.deleteById('meeting-1')).resolves.toBe(false);
    await expect(repository.deleteById('')).resolves.toBe(false);
    await expect(repository.getById('meeting-2')).resolves.toMatchObject({ meetingId: 'meeting-2' });
  });

  it('clears only meeting history without deleting the database or another store', async () => {
    factory.precreateStore(
      MEETING_HISTORY_DATABASE_NAME,
      MEETING_HISTORY_DATABASE_VERSION,
      MEETING_HISTORY_STORE_NAME,
      MEETING_HISTORY_STORE_KEY_PATH,
    );
    factory.precreateStore(
      MEETING_HISTORY_DATABASE_NAME,
      MEETING_HISTORY_DATABASE_VERSION,
      otherStore,
      'key',
    );
    factory.seed(MEETING_HISTORY_DATABASE_NAME, otherStore, 'other-1', { key: 'other-1', value: 'preserved' });
    await repository.save(record('meeting-1'));

    await repository.clear();

    await expect(repository.list()).resolves.toEqual([]);
    expect(factory.read(MEETING_HISTORY_DATABASE_NAME, otherStore, 'other-1')).toEqual({
      key: 'other-1', value: 'preserved',
    });
    expect(factory.storeNames(MEETING_HISTORY_DATABASE_NAME)).toContain(MEETING_HISTORY_STORE_NAME);
    expect(factory.deleteDatabaseCalls).toBe(0);
  });
});

describe('IndexedDbMeetingHistoryRepository immutable boundaries', () => {
  it('copies the value before save completes', async () => {
    const input = recordWithSummary('meeting-1');
    const saving = repository.save(input);
    input.title = 'Mutated input';
    input.transcript.utterances[0]!.rawText = 'Mutated utterance';
    input.finalSummary!.todos[0]!.content = 'Mutated TODO';
    await saving;

    const stored = await repository.getById('meeting-1');
    expect(stored).toMatchObject({ title: 'Meeting meeting-1' });
    expect(stored?.transcript.utterances[0]?.rawText).toBe('raw text');
    expect(stored?.finalSummary?.todos[0]?.content).toBe('Review tests');
  });

  it('does not expose stored references through getById', async () => {
    await repository.save(recordWithSummary('meeting-1'));
    const first = await repository.getById('meeting-1');
    first!.transcript.utterances.length = 0;
    first!.finalSummary!.todos[0]!.content = 'Mutated TODO';

    const second = await repository.getById('meeting-1');
    expect(second?.transcript.utterances).toHaveLength(1);
    expect(second?.finalSummary?.todos[0]?.content).toBe('Review tests');
  });

  it('does not expose stored arrays or nested records through list', async () => {
    await repository.save(recordWithSummary('meeting-1'));
    const listed = await repository.list();
    listed.push(record('extra'));
    listed[0]!.transcript.utterances.length = 0;
    listed[0]!.finalSummary!.todos.length = 0;

    const next = await repository.list();
    expect(next).toHaveLength(1);
    expect(next[0]?.transcript.utterances).toHaveLength(1);
    expect(next[0]?.finalSummary?.todos).toHaveLength(1);
  });
});

function record(
  meetingId: string,
  recordUpdatedAt = updatedAt,
  recordCreatedAt = createdAt,
): MeetingRecord {
  const draft = createInitialMeetingSetupDraft('mock');
  draft.title = `Meeting ${meetingId}`;
  draft.correctionEnabled = true;
  draft.liveSummaryEnabled = true;
  draft.finalSummaryEnabled = true;
  const settingsSnapshot = createMeetingSettingsSnapshot(draft, recordCreatedAt);
  return createMeetingRecord({
    meetingId,
    createdAt: recordCreatedAt,
    startedAt: recordCreatedAt,
    endedAt: recordUpdatedAt,
    updatedAt: recordUpdatedAt,
    settingsSnapshot,
    sentences: [sentence(meetingId)],
  });
}

function recordWithSummary(meetingId: string): MeetingRecord {
  const value = record(meetingId);
  return createMeetingRecord({
    meetingId,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    updatedAt: value.updatedAt,
    settingsSnapshot: value.settingsSnapshot,
    sentences: [sentence(meetingId)],
    finalSummary: createFinalMeetingSummaryRecord(meetingId, finalSummary(meetingId), updatedAt, 'mock'),
    summaryApiUsed: false,
  });
}

function sentence(meetingId: string): CompletedSentence {
  return {
    id: `${meetingId}-sentence-1`,
    sessionId: meetingId,
    rawSegmentIds: [`${meetingId}-segment-1`],
    rawText: 'raw text',
    revision: 1,
    displayText: 'raw text',
    language: 'ja',
    startTime: 0,
    endTime: 1,
    completionReason: 'silence',
  };
}

function finalSummary(meetingId: string): FinalMeetingSummary {
  const sentenceId = `${meetingId}-sentence-1`;
  return {
    version: 1,
    overview: 'Meeting overview',
    agenda: [{ text: 'Testing', evidenceSentenceIds: [sentenceId] }],
    keyPoints: [{ text: 'Tests need review.', evidenceSentenceIds: [sentenceId] }],
    decisions: [],
    actionItems: [{ task: 'Review tests', assignee: null, dueDate: null, evidenceSentenceIds: [sentenceId] }],
    unresolvedItems: [],
    nextChecks: [],
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
