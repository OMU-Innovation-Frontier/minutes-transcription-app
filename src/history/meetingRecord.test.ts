import { describe, expect, it } from 'vitest';
import type { TranscriptCorrection } from '../../shared/correction';
import type { FinalMeetingSummary } from '../../shared/summary';
import { createMeetingSettingsSnapshot, createInitialMeetingSetupDraft } from '../meetingSetup/meetingSetup';
import { createFinalMeetingSummaryRecord } from '../summary/finalMeetingSummary';
import type { CompletedSentence } from '../transcription/types';
import {
  createMeetingRecord,
  deserializeMeetingRecord,
  MEETING_RECORD_SCHEMA_VERSION,
  MeetingRecordValidationError,
  parseMeetingRecord,
  serializeMeetingRecord,
  toPersistedUtterance,
  type MeetingRecord,
} from './meetingRecord';

const createdAt = '2026-07-20T00:00:00.000Z';
const updatedAt = '2026-07-20T01:00:00.000Z';

function sentence(index = 0, correction?: TranscriptCorrection): CompletedSentence {
  return {
    id: `sentence-${index + 1}`,
    sessionId: 'meeting-1',
    rawSegmentIds: [`segment-${index + 1}`],
    rawText: `raw text ${index + 1}`,
    revision: 1,
    displayText: correction?.correctedText ?? `raw text ${index + 1}`,
    language: 'ja',
    startTime: index * 100,
    endTime: index * 100 + 50,
    completionReason: 'silence',
    correction,
  };
}

function successfulCorrection(index = 0): TranscriptCorrection {
  return {
    rawText: `raw text ${index + 1}`,
    correctedText: `corrected text ${index + 1}`,
    status: 'completed',
    changes: [],
    uncertainParts: [],
    sourceSegmentIds: [`segment-${index + 1}`],
  };
}

function finalSummary(): FinalMeetingSummary {
  return {
    version: 1,
    overview: 'Meeting overview',
    agenda: [{ text: 'Agenda', evidenceSentenceIds: ['sentence-1'] }],
    keyPoints: [],
    decisions: [],
    unresolvedItems: [],
    actionItems: [{ task: 'Review tests', assignee: null, dueDate: null, evidenceSentenceIds: ['sentence-1'] }],
    nextChecks: [],
  };
}

function record(overrides: Partial<Parameters<typeof createMeetingRecord>[0]> = {}): MeetingRecord {
  const settingsSnapshot = createMeetingSettingsSnapshot(
    { ...createInitialMeetingSetupDraft('mock'), title: 'History test', finalSummaryEnabled: true },
    createdAt,
  );
  return createMeetingRecord({
    meetingId: 'meeting-1',
    createdAt,
    startedAt: null,
    endedAt: null,
    updatedAt,
    settingsSnapshot,
    sentences: [sentence()],
    ...overrides,
  });
}

function editable(value: MeetingRecord): Record<string, unknown> {
  return JSON.parse(serializeMeetingRecord(value)) as Record<string, unknown>;
}

describe('MeetingRecord model and conversion', () => {
  it('creates the minimum valid record with the centralized schema version', () => {
    const value = record();

    expect(value.schemaVersion).toBe(MEETING_RECORD_SCHEMA_VERSION);
    expect(value.meetingId).toBe('meeting-1');
    expect(value.finalSummary).toBeNull();
    expect(value.transcript.utterances).toHaveLength(1);
  });

  it('keeps multiple completed utterances in their original order', () => {
    const value = record({ sentences: [sentence(0), sentence(1)] });

    expect(value.transcript.utterances.map((utterance) => [utterance.sentenceId, utterance.sequence])).toEqual([
      ['sentence-1', 0],
      ['sentence-2', 1],
    ]);
  });

  it('stores corrected text only for a successful correction', () => {
    const corrected = record({ sentences: [sentence(0, successfulCorrection())] });
    const uncorrected = record({ sentences: [sentence()] });

    expect(corrected.transcript.utterances[0]).toMatchObject({
      rawText: 'raw text 1', correctedText: 'corrected text 1', correctionStatus: 'completed',
    });
    expect(uncorrected.transcript.utterances[0]).toMatchObject({ correctedText: null, correctionStatus: null });
  });

  it('does not persist transient correction execution states', () => {
    const pending = successfulCorrection();
    pending.status = 'processing';

    expect(toPersistedUtterance(sentence(0, pending), 0)).toMatchObject({
      correctedText: null,
      correctionStatus: null,
    });
  });

  it('stores a successful final summary, nullable TODO metadata, API use, and completion state', () => {
    const summaryRecord = createFinalMeetingSummaryRecord('meeting-1', finalSummary(), updatedAt, 'mock');
    const completedRecord = {
      ...summaryRecord,
      todos: summaryRecord.todos.map((todo) => ({ ...todo, completed: true })),
    };
    const value = record({ finalSummary: completedRecord, summaryApiUsed: false });

    expect(value.finalSummary).toMatchObject({
      summary: { overview: 'Meeting overview' },
      createdAt: updatedAt,
      provider: 'mock',
      apiUsed: false,
      todos: [{ content: 'Review tests', assignee: null, dueDate: null, completed: true }],
    });
  });

  it('preserves an incomplete TODO without inventing assignee or due date values', () => {
    const summaryRecord = createFinalMeetingSummaryRecord('meeting-1', finalSummary(), updatedAt, 'mock');
    const value = record({ finalSummary: summaryRecord });

    expect(value.finalSummary?.todos).toEqual([
      { content: 'Review tests', assignee: null, dueDate: null, completed: false },
    ]);
  });

  it('preserves canonical ISO timestamps and nullable lifecycle timestamps', () => {
    expect(record()).toMatchObject({ createdAt, startedAt: null, endedAt: null, updatedAt });
    expect(record({ startedAt: createdAt, endedAt: updatedAt })).toMatchObject({
      startedAt: createdAt,
      endedAt: updatedAt,
    });
  });

  it('keeps an explicitly absent display title as null without changing the fixed snapshot', () => {
    const value = record({ title: null });

    expect(value.title).toBeNull();
    expect(value.settingsSnapshot.title).toBe('History test');
  });

  it('round-trips through a JSON serialization boundary without retaining object identity', () => {
    const original = record({ sentences: [sentence(0, successfulCorrection())] });
    const restored = deserializeMeetingRecord(serializeMeetingRecord(original));

    expect(restored).toEqual(original);
    expect(restored).not.toBe(original);
    expect(restored.transcript.utterances).not.toBe(original.transcript.utterances);
  });
});

describe('MeetingRecord validation', () => {
  it.each([null, [], 'record'])('rejects non-record input: %j', (value) => {
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects an empty meeting ID', () => {
    const value = editable(record());
    value.meetingId = '';
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects an unsupported schema version', () => {
    const value = editable(record());
    value.schemaVersion = MEETING_RECORD_SCHEMA_VERSION + 1;
    expect(() => parseMeetingRecord(value)).toThrow(/schema/u);
  });

  it.each(['createdAt', 'updatedAt'] as const)('rejects an invalid required timestamp in %s', (field) => {
    const value = editable(record());
    value[field] = 'not-a-date';
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects invalid nullable lifecycle timestamps', () => {
    const value = editable(record());
    value.startedAt = '2026-02-30T00:00:00.000Z';
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects an invalid settings snapshot instead of treating it as a draft', () => {
    const value = editable(record());
    (value.settingsSnapshot as Record<string, unknown>).language = 'invalid';
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects a non-array transcript and invalid utterance text', () => {
    const nonArray = editable(record());
    (nonArray.transcript as Record<string, unknown>).utterances = {};
    expect(() => parseMeetingRecord(nonArray)).toThrow(MeetingRecordValidationError);

    const invalidText = editable(record());
    const utterances = (invalidText.transcript as { utterances: Array<Record<string, unknown>> }).utterances;
    if (utterances[0]) utterances[0].rawText = '';
    expect(() => parseMeetingRecord(invalidText)).toThrow(MeetingRecordValidationError);
  });

  it('rejects duplicate sentence IDs or ordering values', () => {
    const value = editable(record({ sentences: [sentence(0), sentence(1)] }));
    const utterances = (value.transcript as { utterances: Array<Record<string, unknown>> }).utterances;
    if (utterances[1]) utterances[1].sentenceId = 'sentence-1';
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects success correction metadata without corrected text', () => {
    const value = editable(record({ sentences: [sentence(0, successfulCorrection())] }));
    const utterances = (value.transcript as { utterances: Array<Record<string, unknown>> }).utterances;
    if (utterances[0]) utterances[0].correctedText = null;
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects a transient correction status in a persisted utterance', () => {
    const value = editable(record());
    const utterances = (value.transcript as { utterances: Array<Record<string, unknown>> }).utterances;
    if (utterances[0]) utterances[0].correctionStatus = 'processing';
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects malformed final summary and TODO structures', () => {
    const summaryRecord = createFinalMeetingSummaryRecord('meeting-1', finalSummary(), updatedAt, 'mock');
    const invalidSummary = editable(record({ finalSummary: summaryRecord }));
    ((invalidSummary.finalSummary as Record<string, unknown>).summary as Record<string, unknown>).overview = null;
    expect(() => parseMeetingRecord(invalidSummary)).toThrow();

    const invalidTodo = editable(record({ finalSummary: summaryRecord }));
    const todos = (invalidTodo.finalSummary as { todos: Array<Record<string, unknown>> }).todos;
    if (todos[0]) todos[0].completed = 'false';
    expect(() => parseMeetingRecord(invalidTodo)).toThrow(MeetingRecordValidationError);
  });

  it('rejects non-plain or non-JSON values', () => {
    const value = record() as MeetingRecord & { callback?: () => void };
    value.callback = () => undefined;
    expect(() => parseMeetingRecord(value)).toThrow(MeetingRecordValidationError);
  });

  it('rejects invalid serialized JSON safely', () => {
    expect(() => deserializeMeetingRecord('{invalid')).toThrow(MeetingRecordValidationError);
  });
});
