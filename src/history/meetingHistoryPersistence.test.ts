import { describe, expect, it, vi } from 'vitest';
import { createMeetingSettingsSnapshot, type MeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { FinalMeetingSummaryRecord, FinalMeetingSummaryState } from '../summary/finalMeetingSummary';
import type { CompletedSentence } from '../transcription/types';
import { InMemoryMeetingHistoryRepository } from './inMemoryMeetingHistoryRepository';
import type { MeetingHistoryRepository } from './meetingHistoryRepository';
import type { MeetingRecord } from './meetingRecord';
import {
  createEndedMeetingSnapshot,
  MEETING_HISTORY_SAVE_WARNING,
  MeetingHistoryPersistenceCoordinator,
  saveSucceededFinalSummary,
  type EndedMeetingSnapshot,
} from './meetingHistoryPersistence';

describe('ended meeting snapshot', () => {
  it('captures identifiers, lifecycle timestamps, the final title, fixed settings, and completed sentences', () => {
    const settings = settingsFixture();
    const snapshot = createEndedMeetingSnapshot({
      meetingId: 'meeting-1',
      settingsSnapshot: settings,
      title: '終了時のタイトル',
      startedAt: Date.parse('2026-07-20T01:05:00.000Z'),
      endedAt: Date.parse('2026-07-20T01:30:00.000Z'),
      sentences: [sentenceFixture('sentence-1')],
    });

    expect(snapshot).toMatchObject({
      meetingId: 'meeting-1',
      createdAt: '2026-07-20T01:00:00.000Z',
      startedAt: '2026-07-20T01:05:00.000Z',
      endedAt: '2026-07-20T01:30:00.000Z',
      title: '終了時のタイトル',
      settingsSnapshot: { title: '作成時のタイトル' },
    });
    expect(snapshot.sentences.map(({ id }) => id)).toEqual(['sentence-1']);
    expect('interim' in snapshot).toBe(false);
  });

  it('keeps startedAt null when recording never started', () => {
    expect(snapshotFixture({ startedAt: null }).startedAt).toBeNull();
  });

  it('supports an empty completed transcript', () => {
    expect(snapshotFixture({ sentences: [] }).sentences).toEqual([]);
  });

  it('does not change after source settings, sentences, or nested correction data are mutated', () => {
    const settings = settingsFixture();
    const sentence = sentenceFixture('sentence-1', true);
    const snapshot = createEndedMeetingSnapshot({
      meetingId: 'meeting-1',
      settingsSnapshot: settings,
      title: '終了時のタイトル',
      startedAt: null,
      endedAt: Date.parse('2026-07-20T01:30:00.000Z'),
      sentences: [sentence],
    });

    (settings as { title: string }).title = '変更後の設定';
    sentence.rawText = '変更後の発話';
    sentence.rawSegmentIds.push('late-segment');
    sentence.correction?.changes.push({ before: 'a', after: 'b', reason: 'spelling' });

    expect(snapshot.settingsSnapshot.title).toBe('作成時のタイトル');
    expect(snapshot.sentences[0]?.rawText).toBe('確定済み発話 sentence-1');
    expect(snapshot.sentences[0]?.rawSegmentIds).toEqual(['segment-sentence-1']);
    expect(snapshot.sentences[0]?.correction?.changes).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe('MeetingHistoryPersistenceCoordinator', () => {
  it('saves one initial record with finalSummary null before any summary update', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture();

    await expect(persistence.saveEndedMeeting(snapshot)).resolves.toBe(true);

    expect(repository.saveCalls).toHaveLength(1);
    expect(repository.saveCalls[0]).toMatchObject({
      meetingId: 'meeting-1',
      startedAt: null,
      endedAt: '2026-07-20T01:30:00.000Z',
      updatedAt: '2026-07-20T01:30:00.000Z',
      title: '終了時のタイトル',
      finalSummary: null,
    });
    expect(repository.saveCalls[0]?.transcript.utterances).toHaveLength(1);
  });

  it('shares a repeated initial save for the same ended snapshot', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture();

    await Promise.all([
      persistence.saveEndedMeeting(snapshot),
      persistence.saveEndedMeeting(snapshot),
    ]);

    expect(repository.saveCalls).toHaveLength(1);
  });

  it('saves one ended meeting without changing another meeting record', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const first = snapshotFixture();
    await persistence.saveEndedMeeting(first);
    persistence.reset();
    const second = snapshotFixture({ meetingId: 'meeting-2', sentences: [] });

    await persistence.saveEndedMeeting(second);

    expect(await repository.getById('meeting-1')).not.toBeNull();
    expect((await repository.getById('meeting-2'))?.transcript.utterances).toEqual([]);
  });

  it('updates the same record only for a succeeded final summary and preserves meeting timestamps', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture({ startedAt: Date.parse('2026-07-20T01:05:00.000Z') });
    await persistence.saveEndedMeeting(snapshot);

    await expect(saveSucceededFinalSummary(
      persistence,
      snapshot,
      { status: 'succeeded', record: finalSummaryFixture() },
      true,
    )).resolves.toBe(true);

    expect(repository.saveCalls).toHaveLength(2);
    const stored = await repository.getById('meeting-1');
    expect(stored).toMatchObject({
      meetingId: 'meeting-1',
      createdAt: '2026-07-20T01:00:00.000Z',
      startedAt: '2026-07-20T01:05:00.000Z',
      endedAt: '2026-07-20T01:30:00.000Z',
      updatedAt: '2026-07-20T01:31:00.000Z',
      finalSummary: {
        createdAt: '2026-07-20T01:31:00.000Z',
        provider: 'mock',
        apiUsed: true,
        summary: { overview: '最終要約' },
        todos: [{ content: 'テストを確認する', assignee: null, dueDate: null, completed: false }],
      },
    });
  });

  it.each<FinalMeetingSummaryState>([
    { status: 'idle' },
    { status: 'processing' },
    { status: 'disabled', reason: 'provider' },
    { status: 'disabled', reason: 'meeting_setting' },
    { status: 'failed', reason: 'status_unavailable' },
    { status: 'failed', reason: 'final_api_failed' },
    { status: 'failed', reason: 'empty_transcript' },
  ])('does not persist transient or unsuccessful final summary state: $status', async (state) => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture();
    await persistence.saveEndedMeeting(snapshot);

    await expect(saveSucceededFinalSummary(persistence, snapshot, state, null)).resolves.toBe(false);

    expect(repository.saveCalls).toHaveLength(1);
    expect((await repository.getById(snapshot.meetingId))?.finalSummary).toBeNull();
  });

  it('creates a complete record after an initial save failure when final summary succeeds', async () => {
    const repository = new RecordingRepository();
    repository.failNextSaves = 1;
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture();

    await expect(persistence.saveEndedMeeting(snapshot)).resolves.toBe(false);
    await expect(saveSucceededFinalSummary(
      persistence,
      snapshot,
      { status: 'succeeded', record: finalSummaryFixture() },
      false,
    )).resolves.toBe(true);

    const stored = await repository.getById(snapshot.meetingId);
    expect(stored?.transcript.utterances).toHaveLength(1);
    expect(stored?.finalSummary?.summary.overview).toBe('最終要約');
  });

  it('keeps the transcript and successful summary when later unsuccessful states occur', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture();
    await persistence.saveEndedMeeting(snapshot);
    await saveSucceededFinalSummary(persistence, snapshot, { status: 'succeeded', record: finalSummaryFixture() }, false);

    await saveSucceededFinalSummary(persistence, snapshot, { status: 'failed', reason: 'final_api_failed' }, null);

    expect((await repository.getById(snapshot.meetingId))?.finalSummary?.summary.overview).toBe('最終要約');
    expect((await repository.getById(snapshot.meetingId))?.transcript.utterances).toHaveLength(1);
  });

  it('deduplicates simultaneous final-summary saves for the same result', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture();
    await persistence.saveEndedMeeting(snapshot);
    const state = { status: 'succeeded', record: finalSummaryFixture() } as const;

    await Promise.all([
      saveSucceededFinalSummary(persistence, snapshot, state, false),
      saveSucceededFinalSummary(persistence, snapshot, state, false),
    ]);

    expect(repository.saveCalls).toHaveLength(2);
  });

  it('does not read current transcript state when a retry saves the fixed ended snapshot', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const source = [sentenceFixture('sentence-1')];
    const snapshot = snapshotFixture({ sentences: source });
    await persistence.saveEndedMeeting(snapshot);
    source.push(sentenceFixture('sentence-after-end'));

    await saveSucceededFinalSummary(persistence, snapshot, { status: 'succeeded', record: finalSummaryFixture() }, false);

    expect((await repository.getById(snapshot.meetingId))?.transcript.utterances.map(({ sentenceId }) => sentenceId)).toEqual(['sentence-1']);
  });

  it('ignores delayed summary results after reset or after another meeting becomes active', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const oldSnapshot = snapshotFixture();
    await persistence.saveEndedMeeting(oldSnapshot);
    persistence.reset();

    await expect(saveSucceededFinalSummary(
      persistence,
      oldSnapshot,
      { status: 'succeeded', record: finalSummaryFixture() },
      false,
    )).resolves.toBe(false);

    const newSnapshot = snapshotFixture({ meetingId: 'meeting-2' });
    await persistence.saveEndedMeeting(newSnapshot);
    await expect(saveSucceededFinalSummary(
      persistence,
      oldSnapshot,
      { status: 'succeeded', record: finalSummaryFixture() },
      false,
    )).resolves.toBe(false);
    expect(await repository.getById('meeting-2')).not.toBeNull();
    expect(repository.saveCalls).toHaveLength(2);
  });

  it('rejects a summary record for another meeting ID', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture();
    await persistence.saveEndedMeeting(snapshot);

    await expect(persistence.saveFinalSummary(snapshot, finalSummaryFixture('meeting-2'), false)).resolves.toBe(false);
    expect(repository.saveCalls).toHaveLength(1);
  });

  it('contains repository failures, emits one safe warning, and never exposes the raw error', async () => {
    const repository = new RecordingRepository();
    repository.failNextSaves = 2;
    const onWarning = vi.fn();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository, onWarning);
    const snapshot = snapshotFixture();

    await expect(persistence.saveEndedMeeting(snapshot)).resolves.toBe(false);
    await expect(saveSucceededFinalSummary(
      persistence,
      snapshot,
      { status: 'succeeded', record: finalSummaryFixture() },
      false,
    )).resolves.toBe(false);

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(MEETING_HISTORY_SAVE_WARNING);
    expect(onWarning.mock.calls.flat().join(' ')).not.toContain('raw IndexedDB failure');
  });

  it('keeps meeting features usable when IndexedDB is unavailable', async () => {
    const onWarning = vi.fn();
    const persistence = new MeetingHistoryPersistenceCoordinator(null, onWarning);

    await expect(persistence.saveEndedMeeting(snapshotFixture())).resolves.toBe(false);

    expect(onWarning).toHaveBeenCalledWith(MEETING_HISTORY_SAVE_WARNING);
  });

  it('ignores saves after dispose without producing an unhandled failure', async () => {
    const repository = new RecordingRepository();
    const persistence = new MeetingHistoryPersistenceCoordinator(repository);
    const snapshot = snapshotFixture();
    persistence.dispose();

    await expect(persistence.saveEndedMeeting(snapshot)).resolves.toBe(false);
    await expect(persistence.saveFinalSummary(snapshot, finalSummaryFixture(), false)).resolves.toBe(false);
    expect(repository.saveCalls).toHaveLength(0);
  });
});

class RecordingRepository implements MeetingHistoryRepository {
  readonly delegate = new InMemoryMeetingHistoryRepository();
  readonly saveCalls: MeetingRecord[] = [];
  failNextSaves = 0;

  async save(record: MeetingRecord): Promise<void> {
    this.saveCalls.push(record);
    if (this.failNextSaves > 0) {
      this.failNextSaves -= 1;
      throw new Error('raw IndexedDB failure');
    }
    await this.delegate.save(record);
  }

  getById(meetingId: string): Promise<MeetingRecord | null> {
    return this.delegate.getById(meetingId);
  }

  list(): Promise<MeetingRecord[]> {
    return this.delegate.list();
  }

  deleteById(meetingId: string): Promise<boolean> {
    return this.delegate.deleteById(meetingId);
  }

  clear(): Promise<void> {
    return this.delegate.clear();
  }
}

function settingsFixture(): MeetingSettingsSnapshot {
  return {
    ...createMeetingSettingsSnapshot({
      title: '作成時のタイトル',
      language: 'ja-JP',
      transcriptionProvider: 'mock',
      correctionEnabled: true,
      liveSummaryEnabled: true,
      finalSummaryEnabled: true,
      historyRetention: 'page-session',
      externalProcessingAcknowledged: false,
    }, '2026-07-20T01:00:00.000Z'),
  };
}

function sentenceFixture(id: string, corrected = false): CompletedSentence {
  return {
    id,
    sessionId: 'session-1',
    rawSegmentIds: [`segment-${id}`],
    rawText: `確定済み発話 ${id}`,
    revision: 1,
    displayText: corrected ? `整文済み発話 ${id}` : `確定済み発話 ${id}`,
    language: 'ja',
    startTime: 100,
    endTime: 200,
    completionReason: 'recording_stopped',
    correction: corrected ? {
      rawText: `確定済み発話 ${id}`,
      correctedText: `整文済み発話 ${id}`,
      status: 'succeeded',
      changes: [],
      uncertainParts: [],
      sourceSegmentIds: [`segment-${id}`],
    } : undefined,
  };
}

function snapshotFixture(overrides: Partial<{
  meetingId: string;
  startedAt: number | null;
  sentences: CompletedSentence[];
}> = {}): EndedMeetingSnapshot {
  return createEndedMeetingSnapshot({
    meetingId: overrides.meetingId ?? 'meeting-1',
    settingsSnapshot: settingsFixture(),
    title: '終了時のタイトル',
    startedAt: overrides.startedAt === undefined ? null : overrides.startedAt,
    endedAt: Date.parse('2026-07-20T01:30:00.000Z'),
    sentences: overrides.sentences ?? [sentenceFixture('sentence-1')],
  });
}

function finalSummaryFixture(meetingId = 'meeting-1'): FinalMeetingSummaryRecord {
  return {
    meetingId,
    summary: {
      version: 1,
      overview: '最終要約',
      agenda: [],
      keyPoints: [{ text: '要点', evidenceSentenceIds: ['sentence-1'] }],
      decisions: [],
      unresolvedItems: [],
      actionItems: [{
        task: 'テストを確認する',
        assignee: null,
        dueDate: null,
        evidenceSentenceIds: ['sentence-1'],
      }],
      nextChecks: [],
    },
    todos: [{ content: 'テストを確認する', assignee: null, dueDate: null, completed: false }],
    createdAt: '2026-07-20T01:31:00.000Z',
    provider: 'mock',
  };
}
