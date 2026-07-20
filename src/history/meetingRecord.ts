import type { CorrectionStatus } from '../../shared/correction';
import { validateFinalMeetingSummary, type FinalMeetingSummary } from '../../shared/summary';
import type { MeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { FinalMeetingSummaryRecord, FinalMeetingTodo } from '../summary/finalMeetingSummary';
import type { SummaryStatus } from '../summary/summaryClient';
import type { CompletedSentence, TranscriptLanguage } from '../transcription/types';

export const MEETING_RECORD_SCHEMA_VERSION = 1 as const;

export type PersistedCorrectionStatus = Exclude<CorrectionStatus, 'queued' | 'processing' | 'pending'>;

export interface PersistedUtterance {
  sentenceId: string;
  sequence: number;
  revision: number;
  sourceSegmentIds: string[];
  rawText: string;
  correctedText: string | null;
  correctionStatus: PersistedCorrectionStatus | null;
  language: TranscriptLanguage;
  startTime: number;
  endTime: number;
}

export type PersistedFinalSummaryTodo = FinalMeetingTodo;

export interface PersistedFinalSummary {
  summary: FinalMeetingSummary;
  todos: PersistedFinalSummaryTodo[];
  createdAt: string;
  provider: SummaryStatus['provider'] | null;
  apiUsed: boolean | null;
}

export interface MeetingRecord {
  schemaVersion: typeof MEETING_RECORD_SCHEMA_VERSION;
  meetingId: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  title: string | null;
  settingsSnapshot: MeetingSettingsSnapshot;
  transcript: {
    utterances: PersistedUtterance[];
  };
  finalSummary: PersistedFinalSummary | null;
}

export interface CreateMeetingRecordInput {
  meetingId: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  title?: string | null;
  settingsSnapshot: MeetingSettingsSnapshot;
  sentences: readonly CompletedSentence[];
  finalSummary?: FinalMeetingSummaryRecord | null;
  summaryApiUsed?: boolean | null;
}

const PERSISTED_CORRECTION_STATUSES = new Set<PersistedCorrectionStatus>([
  'disabled',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'fallback',
  'completed',
]);

const TRANSCRIPTION_PROVIDERS = new Set(['browser', 'mock', 'websocket', 'local-whisper']);

export class MeetingRecordValidationError extends Error {
  constructor(message = '会議履歴レコードが不正です。') {
    super(message);
    this.name = 'MeetingRecordValidationError';
  }
}

export function createMeetingRecord(input: CreateMeetingRecordInput): MeetingRecord {
  return parseMeetingRecord({
    schemaVersion: MEETING_RECORD_SCHEMA_VERSION,
    meetingId: input.meetingId,
    createdAt: input.createdAt,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    updatedAt: input.updatedAt,
    title: input.title === undefined ? input.settingsSnapshot.title : input.title,
    settingsSnapshot: input.settingsSnapshot,
    transcript: {
      utterances: input.sentences.map(toPersistedUtterance),
    },
    finalSummary: input.finalSummary
      ? toPersistedFinalSummary(input.finalSummary, input.summaryApiUsed ?? null)
      : null,
  });
}

export function toPersistedUtterance(sentence: CompletedSentence, sequence: number): PersistedUtterance {
  const correctionStatus = sentence.correction && PERSISTED_CORRECTION_STATUSES.has(sentence.correction.status as PersistedCorrectionStatus)
    ? sentence.correction.status as PersistedCorrectionStatus
    : null;
  const correctionSucceeded = correctionStatus === 'completed' || correctionStatus === 'succeeded';

  return {
    sentenceId: sentence.id,
    sequence,
    revision: sentence.revision,
    sourceSegmentIds: [...sentence.rawSegmentIds],
    rawText: sentence.rawText,
    correctedText: correctionSucceeded ? sentence.correction?.correctedText ?? null : null,
    correctionStatus,
    language: sentence.language,
    startTime: sentence.startTime,
    endTime: sentence.endTime,
  };
}

export function toPersistedFinalSummary(
  record: FinalMeetingSummaryRecord,
  apiUsed: boolean | null,
): PersistedFinalSummary {
  return {
    summary: cloneFinalSummary(record.summary),
    todos: record.todos.map((todo) => ({ ...todo })),
    createdAt: record.createdAt,
    provider: record.provider,
    apiUsed,
  };
}

export function parseMeetingRecord(value: unknown): MeetingRecord {
  if (!isJsonSafe(value)) throw new MeetingRecordValidationError();
  const record = requireRecord(value);
  if (record.schemaVersion !== MEETING_RECORD_SCHEMA_VERSION) throw new MeetingRecordValidationError('未対応の会議履歴schemaです。');

  const meetingId = requireIdentifier(record.meetingId);
  const createdAt = requireIsoDate(record.createdAt);
  const startedAt = requireNullableIsoDate(record.startedAt);
  const endedAt = requireNullableIsoDate(record.endedAt);
  const updatedAt = requireIsoDate(record.updatedAt);
  const title = parseTitle(record.title);
  const settingsSnapshot = parseSettingsSnapshot(record.settingsSnapshot);
  const transcript = requireRecord(record.transcript);
  if (!Array.isArray(transcript.utterances)) throw new MeetingRecordValidationError();
  const utterances = transcript.utterances.map(parsePersistedUtterance);
  validateUniqueUtterances(utterances);
  const finalSummary = record.finalSummary === null
    ? null
    : parsePersistedFinalSummary(record.finalSummary, new Set(utterances.map((utterance) => utterance.sentenceId)));

  return {
    schemaVersion: MEETING_RECORD_SCHEMA_VERSION,
    meetingId,
    createdAt,
    startedAt,
    endedAt,
    updatedAt,
    title,
    settingsSnapshot,
    transcript: { utterances },
    finalSummary,
  };
}

export function serializeMeetingRecord(record: MeetingRecord): string {
  return JSON.stringify(parseMeetingRecord(record));
}

export function deserializeMeetingRecord(serialized: string): MeetingRecord {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new MeetingRecordValidationError();
  }
  return parseMeetingRecord(value);
}

function parsePersistedUtterance(value: unknown): PersistedUtterance {
  const utterance = requireRecord(value);
  const sentenceId = requireIdentifier(utterance.sentenceId);
  if (!Number.isSafeInteger(utterance.sequence) || (utterance.sequence as number) < 0) throw new MeetingRecordValidationError();
  if (!Number.isSafeInteger(utterance.revision) || (utterance.revision as number) < 0) throw new MeetingRecordValidationError();
  if (!Array.isArray(utterance.sourceSegmentIds)) throw new MeetingRecordValidationError();
  const sourceSegmentIds = utterance.sourceSegmentIds.map(requireIdentifier);
  const rawText = requireText(utterance.rawText);
  const correctedText = utterance.correctedText === null ? null : requireText(utterance.correctedText);
  const correctionStatus = utterance.correctionStatus === null
    ? null
    : parsePersistedCorrectionStatus(utterance.correctionStatus);
  const correctionSucceeded = correctionStatus === 'completed' || correctionStatus === 'succeeded';
  if (correctionSucceeded !== (correctedText !== null)) throw new MeetingRecordValidationError();
  if (utterance.language !== 'ja' && utterance.language !== 'en') throw new MeetingRecordValidationError();
  const startTime = requireNonNegativeFiniteNumber(utterance.startTime);
  const endTime = requireNonNegativeFiniteNumber(utterance.endTime);
  if (endTime < startTime) throw new MeetingRecordValidationError();

  return {
    sentenceId,
    sequence: utterance.sequence as number,
    revision: utterance.revision as number,
    sourceSegmentIds,
    rawText,
    correctedText,
    correctionStatus,
    language: utterance.language,
    startTime,
    endTime,
  };
}

function parsePersistedFinalSummary(value: unknown, evidenceIds: ReadonlySet<string>): PersistedFinalSummary {
  const finalSummary = requireRecord(value);
  let summary: FinalMeetingSummary;
  try {
    summary = validateFinalMeetingSummary(finalSummary.summary, evidenceIds);
  } catch {
    throw new MeetingRecordValidationError();
  }
  if (!Array.isArray(finalSummary.todos)) throw new MeetingRecordValidationError();
  const todos = finalSummary.todos.map(parseTodo);
  const createdAt = requireIsoDate(finalSummary.createdAt);
  const provider = finalSummary.provider;
  if (provider !== null && provider !== 'mock' && provider !== 'openai') throw new MeetingRecordValidationError();
  const apiUsed = finalSummary.apiUsed;
  if (apiUsed !== null && typeof apiUsed !== 'boolean') throw new MeetingRecordValidationError();
  return {
    summary: cloneFinalSummary(summary),
    todos,
    createdAt,
    provider,
    apiUsed,
  };
}

function parseTodo(value: unknown): PersistedFinalSummaryTodo {
  const todo = requireRecord(value);
  const content = requireText(todo.content);
  const assignee = parseNullableNonEmptyString(todo.assignee);
  const dueDate = parseNullableNonEmptyString(todo.dueDate);
  if (typeof todo.completed !== 'boolean') throw new MeetingRecordValidationError();
  return { content, assignee, dueDate, completed: todo.completed };
}

function parseSettingsSnapshot(value: unknown): MeetingSettingsSnapshot {
  const settings = requireRecord(value);
  if (settings.settingsVersion !== 1) throw new MeetingRecordValidationError();
  const title = requireText(settings.title);
  if (title.length > 80 || title.trim() !== title) throw new MeetingRecordValidationError();
  if (settings.language !== 'ja-JP' && settings.language !== 'en-US') throw new MeetingRecordValidationError();
  if (typeof settings.transcriptionProvider !== 'string' || !TRANSCRIPTION_PROVIDERS.has(settings.transcriptionProvider)) {
    throw new MeetingRecordValidationError();
  }
  if (typeof settings.correctionEnabled !== 'boolean'
    || typeof settings.liveSummaryEnabled !== 'boolean'
    || typeof settings.finalSummaryEnabled !== 'boolean'
    || settings.historyRetention !== 'page-session') {
    throw new MeetingRecordValidationError();
  }
  return {
    settingsVersion: 1,
    title,
    language: settings.language,
    transcriptionProvider: settings.transcriptionProvider as MeetingSettingsSnapshot['transcriptionProvider'],
    correctionEnabled: settings.correctionEnabled,
    liveSummaryEnabled: settings.liveSummaryEnabled,
    finalSummaryEnabled: settings.finalSummaryEnabled,
    historyRetention: 'page-session',
    createdAt: requireIsoDate(settings.createdAt),
  };
}

function parsePersistedCorrectionStatus(value: unknown): PersistedCorrectionStatus {
  if (typeof value !== 'string' || !PERSISTED_CORRECTION_STATUSES.has(value as PersistedCorrectionStatus)) {
    throw new MeetingRecordValidationError();
  }
  return value as PersistedCorrectionStatus;
}

function validateUniqueUtterances(utterances: readonly PersistedUtterance[]): void {
  const sentenceIds = new Set<string>();
  const sequences = new Set<number>();
  for (const utterance of utterances) {
    if (sentenceIds.has(utterance.sentenceId) || sequences.has(utterance.sequence)) throw new MeetingRecordValidationError();
    sentenceIds.add(utterance.sentenceId);
    sequences.add(utterance.sequence);
  }
}

function parseTitle(value: unknown): string | null {
  if (value === null) return null;
  const title = requireText(value);
  if (title.length > 80 || title.trim() !== title) throw new MeetingRecordValidationError();
  return title;
}

function parseNullableNonEmptyString(value: unknown): string | null {
  if (value === null) return null;
  return requireText(value);
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== 'string'
    || !value
    || value.length > 200
    || value.trim() !== value
    || hasUnsafeControl(value)) {
    throw new MeetingRecordValidationError();
  }
  return value;
}

function requireText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || hasUnsafeControl(value)) throw new MeetingRecordValidationError();
  return value;
}

function requireIsoDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new MeetingRecordValidationError();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new MeetingRecordValidationError();
  return value;
}

function requireNullableIsoDate(value: unknown): string | null {
  return value === null ? null : requireIsoDate(value);
}

function requireNonNegativeFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new MeetingRecordValidationError();
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MeetingRecordValidationError();
  return value as Record<string, unknown>;
}

function hasUnsafeControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

function isJsonSafe(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const safe = value.every((item) => isJsonSafe(item, seen));
    seen.delete(value);
    return safe;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }
  const safe = Reflect.ownKeys(value).every((key) => typeof key === 'string' && isJsonSafe((value as Record<string, unknown>)[key], seen));
  seen.delete(value);
  return safe;
}

function cloneFinalSummary(summary: FinalMeetingSummary): FinalMeetingSummary {
  const cloneEvidenceItems = (items: FinalMeetingSummary['agenda']) => items.map((item) => ({
    text: item.text,
    evidenceSentenceIds: [...item.evidenceSentenceIds],
  }));
  return {
    version: summary.version,
    overview: summary.overview,
    agenda: cloneEvidenceItems(summary.agenda),
    keyPoints: cloneEvidenceItems(summary.keyPoints),
    decisions: cloneEvidenceItems(summary.decisions),
    unresolvedItems: cloneEvidenceItems(summary.unresolvedItems),
    actionItems: summary.actionItems.map((item) => ({ ...item, evidenceSentenceIds: [...item.evidenceSentenceIds] })),
    nextChecks: cloneEvidenceItems(summary.nextChecks),
  };
}
