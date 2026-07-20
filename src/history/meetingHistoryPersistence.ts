import type { MeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { FinalMeetingSummaryRecord, FinalMeetingSummaryState } from '../summary/finalMeetingSummary';
import type { CompletedSentence } from '../transcription/types';
import type { MeetingHistoryRepository } from './meetingHistoryRepository';
import { createMeetingRecord, type MeetingRecord } from './meetingRecord';

export const MEETING_HISTORY_SAVE_WARNING = '会議履歴をこの端末に保存できませんでした。ページを閉じるまでは内容を確認できます。';

export interface EndedMeetingSnapshot {
  readonly meetingId: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string;
  readonly title: string;
  readonly settingsSnapshot: MeetingSettingsSnapshot;
  readonly sentences: readonly CompletedSentence[];
}

export interface CreateEndedMeetingSnapshotInput {
  meetingId: string;
  settingsSnapshot: MeetingSettingsSnapshot;
  title: string;
  startedAt: number | null;
  endedAt: number;
  sentences: readonly CompletedSentence[];
}

export function createEndedMeetingSnapshot(input: CreateEndedMeetingSnapshotInput): EndedMeetingSnapshot {
  const startedAt = input.startedAt === null ? null : toIsoDate(input.startedAt);
  const endedAt = toIsoDate(input.endedAt);
  const sentences = input.sentences.map(cloneCompletedSentence);
  const record = createMeetingRecord({
    meetingId: input.meetingId,
    createdAt: input.settingsSnapshot.createdAt,
    startedAt,
    endedAt,
    updatedAt: endedAt,
    title: input.title,
    settingsSnapshot: input.settingsSnapshot,
    sentences,
    finalSummary: null,
    summaryApiUsed: null,
  });

  return deepFreeze({
    meetingId: record.meetingId,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt,
    title: record.title ?? record.settingsSnapshot.title,
    settingsSnapshot: record.settingsSnapshot,
    sentences,
  });
}

export function createRecordFromEndedMeeting(
  snapshot: EndedMeetingSnapshot,
  finalSummary: FinalMeetingSummaryRecord | null = null,
  summaryApiUsed: boolean | null = null,
): MeetingRecord {
  return createMeetingRecord({
    meetingId: snapshot.meetingId,
    createdAt: snapshot.createdAt,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    updatedAt: finalSummary?.createdAt ?? snapshot.endedAt,
    title: snapshot.title,
    settingsSnapshot: snapshot.settingsSnapshot,
    sentences: snapshot.sentences,
    finalSummary,
    summaryApiUsed: finalSummary ? summaryApiUsed : null,
  });
}

export class MeetingHistoryPersistenceCoordinator {
  private activeSnapshot: EndedMeetingSnapshot | null = null;
  private initialSave: { snapshot: EndedMeetingSnapshot; promise: Promise<boolean> } | null = null;
  private finalSaves = new Map<string, Promise<boolean>>();
  private generation = 0;
  private disposed = false;
  private warningShown = false;

  constructor(
    private readonly repository: MeetingHistoryRepository | null,
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}

  saveEndedMeeting(snapshot: EndedMeetingSnapshot): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.activeSnapshot !== snapshot) {
      this.generation += 1;
      this.activeSnapshot = snapshot;
      this.initialSave = null;
      this.finalSaves.clear();
      this.warningShown = false;
    }
    if (this.initialSave?.snapshot === snapshot) return this.initialSave.promise;
    const generation = this.generation;
    const promise = this.persist(() => createRecordFromEndedMeeting(snapshot), generation, snapshot);
    this.initialSave = { snapshot, promise };
    return promise;
  }

  saveFinalSummary(
    snapshot: EndedMeetingSnapshot,
    finalSummary: FinalMeetingSummaryRecord,
    summaryApiUsed: boolean | null,
  ): Promise<boolean> {
    if (!this.isCurrent(snapshot) || finalSummary.meetingId !== snapshot.meetingId) {
      return Promise.resolve(false);
    }
    const key = `${finalSummary.meetingId}:${finalSummary.createdAt}`;
    const existing = this.finalSaves.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const promise = this.persist(
      () => createRecordFromEndedMeeting(snapshot, finalSummary, summaryApiUsed),
      generation,
      snapshot,
    );
    this.finalSaves.set(key, promise);
    return promise;
  }

  isActive(snapshot: EndedMeetingSnapshot): boolean {
    return this.isCurrent(snapshot);
  }

  reset(): void {
    this.generation += 1;
    this.activeSnapshot = null;
    this.initialSave = null;
    this.finalSaves.clear();
    this.warningShown = false;
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  private async persist(
    createRecord: () => MeetingRecord,
    generation: number,
    snapshot: EndedMeetingSnapshot,
  ): Promise<boolean> {
    try {
      if (!this.repository) throw new Error('Meeting history storage is unavailable.');
      const record = createRecord();
      if (!this.isCurrent(snapshot) || generation !== this.generation) return false;
      await this.repository.save(record);
      return true;
    } catch {
      if (this.isCurrent(snapshot) && generation === this.generation) this.notifyWarning();
      return false;
    }
  }

  private isCurrent(snapshot: EndedMeetingSnapshot): boolean {
    return !this.disposed && this.activeSnapshot === snapshot;
  }

  private notifyWarning(): void {
    if (this.warningShown) return;
    this.warningShown = true;
    try {
      this.onWarning(MEETING_HISTORY_SAVE_WARNING);
    } catch {
      // A presentation callback must not break meeting completion.
    }
  }
}

export function saveSucceededFinalSummary(
  persistence: MeetingHistoryPersistenceCoordinator,
  snapshot: EndedMeetingSnapshot,
  state: FinalMeetingSummaryState,
  summaryApiUsed: boolean | null,
): Promise<boolean> {
  if (state.status !== 'succeeded') return Promise.resolve(false);
  return persistence.saveFinalSummary(snapshot, state.record, summaryApiUsed);
}

function toIsoDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) throw new Error('Meeting timestamp is invalid.');
  return new Date(timestamp).toISOString();
}

function cloneCompletedSentence(sentence: CompletedSentence): CompletedSentence {
  return {
    ...sentence,
    rawSegmentIds: [...sentence.rawSegmentIds],
    correction: sentence.correction ? {
      ...sentence.correction,
      changes: sentence.correction.changes.map((change) => ({ ...change })),
      uncertainParts: sentence.correction.uncertainParts.map((part) => ({ ...part })),
      sourceSegmentIds: [...sentence.correction.sourceSegmentIds],
    } : undefined,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
