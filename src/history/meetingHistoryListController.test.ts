import { describe, expect, it, vi } from 'vitest';
import { createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { MeetingHistoryRepository } from './meetingHistoryRepository';
import { MeetingHistoryListController } from './meetingHistoryListController';
import { createMeetingRecord, type MeetingRecord } from './meetingRecord';

describe('MeetingHistoryListController', () => {
  it('loads repository records once and preserves their order', async () => {
    const records = [recordFixture('meeting-b'), recordFixture('meeting-a')];
    const repository = repositoryStub();
    repository.list.mockResolvedValue(records);
    const states: string[] = [];
    const controller = new MeetingHistoryListController(repository, ({ status }) => states.push(status));

    await controller.load();

    expect(repository.list).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['loading', 'ready']);
    expect(controller.state.records.map(({ meetingId }) => meetingId)).toEqual(['meeting-b', 'meeting-a']);
  });

  it('exposes an empty state for a successful empty load', async () => {
    const repository = repositoryStub();
    repository.list.mockResolvedValue([]);
    const controller = new MeetingHistoryListController(repository);

    await controller.load();

    expect(controller.state).toEqual({ status: 'empty', records: [] });
  });

  it('does not call list and becomes unavailable without a repository', async () => {
    const controller = new MeetingHistoryListController(null);

    await controller.load();

    expect(controller.state).toEqual({ status: 'unavailable', records: [] });
    await controller.retry();
    expect(controller.state.status).toBe('unavailable');
  });

  it('converts an initial repository failure into a safe retryable state', async () => {
    const repository = repositoryStub();
    repository.list.mockRejectedValue(new Error('raw IndexedDB details'));
    const controller = new MeetingHistoryListController(repository);

    await expect(controller.load()).resolves.toBeUndefined();

    expect(controller.state).toEqual({ status: 'failed', phase: 'initial', records: [] });
    expect(JSON.stringify(controller.state)).not.toContain('raw IndexedDB details');
  });

  it('retries an initial failure without overlapping list calls', async () => {
    const repository = repositoryStub();
    repository.list.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce([recordFixture()]);
    const controller = new MeetingHistoryListController(repository);
    await controller.load();

    await Promise.all([controller.retry(), controller.retry()]);

    expect(repository.list).toHaveBeenCalledTimes(2);
    expect(controller.state.status).toBe('ready');
  });

  it('keeps the last successful records after a refresh failure and clears the warning after recovery', async () => {
    const repository = repositoryStub();
    const original = recordFixture('meeting-1');
    const updated = recordFixture('meeting-2');
    repository.list
      .mockResolvedValueOnce([original])
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce([updated]);
    const controller = new MeetingHistoryListController(repository);
    await controller.load();

    await controller.refresh();
    expect(controller.state).toEqual({ status: 'failed', phase: 'refresh', records: [original] });

    await controller.retry();
    expect(controller.state.status).toBe('ready');
    expect(controller.state.records.map(({ meetingId }) => meetingId)).toEqual(['meeting-2']);
  });

  it('queues one follow-up refresh when a save finishes during an active load', async () => {
    const repository = repositoryStub();
    const first = deferred<MeetingRecord[]>();
    repository.list.mockImplementationOnce(() => first.promise).mockResolvedValueOnce([recordFixture('new')]);
    const controller = new MeetingHistoryListController(repository);
    const initialLoad = controller.load();

    const queuedRefresh = controller.refresh();
    void controller.refresh();
    first.resolve([recordFixture('old')]);
    await Promise.all([initialLoad, queuedRefresh]);

    expect(repository.list).toHaveBeenCalledTimes(2);
    expect(controller.state.records.map(({ meetingId }) => meetingId)).toEqual(['new']);
  });

  it('ignores a delayed result after dispose', async () => {
    const repository = repositoryStub();
    const pending = deferred<MeetingRecord[]>();
    repository.list.mockReturnValue(pending.promise);
    const onChange = vi.fn();
    const controller = new MeetingHistoryListController(repository, onChange);
    const load = controller.load();
    controller.dispose();

    pending.resolve([recordFixture()]);
    await load;

    expect(controller.state.status).toBe('disposed');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

function repositoryStub(): MeetingHistoryRepository & { list: ReturnType<typeof vi.fn<() => Promise<MeetingRecord[]>>> } {
  return {
    save: vi.fn(async () => undefined),
    getById: vi.fn(async () => null),
    list: vi.fn<() => Promise<MeetingRecord[]>>(),
    deleteById: vi.fn(async () => false),
    clear: vi.fn(async () => undefined),
  };
}

function recordFixture(meetingId = 'meeting-1'): MeetingRecord {
  const settings = createMeetingSettingsSnapshot({
    title: `会議 ${meetingId}`,
    language: 'ja-JP',
    transcriptionProvider: 'mock',
    correctionEnabled: false,
    liveSummaryEnabled: false,
    finalSummaryEnabled: false,
    historyRetention: 'page-session',
    externalProcessingAcknowledged: false,
  }, '2026-07-20T01:00:00.000Z');
  return createMeetingRecord({
    meetingId,
    createdAt: settings.createdAt,
    startedAt: null,
    endedAt: '2026-07-20T01:30:00.000Z',
    updatedAt: '2026-07-20T01:30:00.000Z',
    settingsSnapshot: settings,
    sentences: [],
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
