import { describe, expect, it, vi } from 'vitest';
import { createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { MeetingHistoryRepository } from './meetingHistoryRepository';
import { MeetingHistoryDetailController } from './meetingHistoryDetailController';
import { createMeetingRecord, type MeetingRecord } from './meetingRecord';

describe('MeetingHistoryDetailController', () => {
  it('loads a valid meeting through getById and becomes ready', async () => {
    const repository = repositoryStub();
    const record = recordFixture('meeting-1');
    repository.getById.mockResolvedValue(record);
    const states: string[] = [];
    const controller = new MeetingHistoryDetailController(repository, ({ status }) => states.push(status));

    await controller.open('meeting-1');

    expect(repository.getById).toHaveBeenCalledOnce();
    expect(repository.getById).toHaveBeenCalledWith('meeting-1');
    expect(states).toEqual(['loading', 'ready']);
    expect(controller.state).toEqual({ status: 'ready', record });
  });

  it('does not query an invalid ID or an unavailable repository', async () => {
    const repository = repositoryStub();
    const controller = new MeetingHistoryDetailController(repository);
    await controller.open('');
    expect(repository.getById).not.toHaveBeenCalled();
    expect(controller.state.status).toBe('not_found');

    const unavailable = new MeetingHistoryDetailController(null);
    await unavailable.open('meeting-1');
    expect(unavailable.state).toEqual({ status: 'unavailable' });
    await unavailable.retry();
    expect(unavailable.state.status).toBe('unavailable');
  });

  it('distinguishes not found from a safe repository failure', async () => {
    const repository = repositoryStub();
    repository.getById.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('raw database details'));
    const controller = new MeetingHistoryDetailController(repository);

    await controller.open('missing');
    expect(controller.state).toEqual({ status: 'not_found', meetingId: 'missing' });
    await controller.open('failed');
    expect(controller.state).toEqual({ status: 'failed', meetingId: 'failed' });
    expect(JSON.stringify(controller.state)).not.toContain('raw database details');
  });

  it('shares a same-ID request and prevents duplicate retry calls', async () => {
    const repository = repositoryStub();
    const first = deferred<MeetingRecord | null>();
    const retry = deferred<MeetingRecord | null>();
    repository.getById
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('temporary'))
      .mockReturnValueOnce(retry.promise);
    const controller = new MeetingHistoryDetailController(repository);

    const openA = controller.open('meeting-1');
    const openB = controller.open('meeting-1');
    first.resolve(recordFixture('meeting-1'));
    await Promise.all([openA, openB]);
    expect(repository.getById).toHaveBeenCalledTimes(1);

    await controller.open('meeting-2');
    expect(controller.state.status).toBe('failed');
    const retryA = controller.retry();
    const retryB = controller.retry();
    retry.resolve(recordFixture('meeting-2'));
    await Promise.all([retryA, retryB]);
    expect(repository.getById).toHaveBeenCalledTimes(3);
    expect(controller.state.status).toBe('ready');
  });

  it('ignores an older result when another meeting is selected', async () => {
    const repository = repositoryStub();
    const oldRequest = deferred<MeetingRecord | null>();
    repository.getById.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(recordFixture('new'));
    const controller = new MeetingHistoryDetailController(repository);

    const oldOpen = controller.open('old');
    await controller.open('new');
    oldRequest.resolve(recordFixture('old'));
    await oldOpen;

    expect(controller.state.status).toBe('ready');
    if (controller.state.status === 'ready') expect(controller.state.record.meetingId).toBe('new');
  });

  it('ignores an older failure after a newer meeting has loaded', async () => {
    const repository = repositoryStub();
    const oldRequest = deferred<MeetingRecord | null>();
    repository.getById.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(recordFixture('new'));
    const controller = new MeetingHistoryDetailController(repository);

    const oldOpen = controller.open('old');
    await controller.open('new');
    oldRequest.reject(new Error('late failure'));
    await oldOpen;

    expect(controller.state.status).toBe('ready');
    if (controller.state.status === 'ready') expect(controller.state.record.meetingId).toBe('new');
  });

  it('releases a completed in-flight operation so the same ID can be loaded again', async () => {
    const repository = repositoryStub();
    repository.getById.mockResolvedValue(recordFixture('meeting-1'));
    const controller = new MeetingHistoryDetailController(repository);

    await controller.open('meeting-1');
    await controller.open('meeting-1');

    expect(repository.getById).toHaveBeenCalledTimes(2);
  });

  it('ignores delayed results after clear or dispose', async () => {
    const repository = repositoryStub();
    const afterClear = deferred<MeetingRecord | null>();
    const afterDispose = deferred<MeetingRecord | null>();
    repository.getById.mockReturnValueOnce(afterClear.promise).mockReturnValueOnce(afterDispose.promise);
    const onChange = vi.fn();
    const controller = new MeetingHistoryDetailController(repository, onChange);

    const clearOpen = controller.open('clear');
    controller.clear();
    afterClear.resolve(recordFixture('clear'));
    await clearOpen;
    expect(controller.state).toEqual({ status: 'idle' });

    const disposeOpen = controller.open('dispose');
    controller.dispose();
    afterDispose.resolve(recordFixture('dispose'));
    await disposeOpen;
    expect(controller.state).toEqual({ status: 'disposed' });
    const callsBefore = repository.getById.mock.calls.length;
    await controller.open('after-dispose');
    expect(repository.getById).toHaveBeenCalledTimes(callsBefore);
  });

  it('never writes, deletes, or clears history while opening details', async () => {
    const repository = repositoryStub();
    repository.getById.mockResolvedValue(recordFixture('meeting-1'));
    const controller = new MeetingHistoryDetailController(repository);
    await controller.open('meeting-1');

    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.deleteById).not.toHaveBeenCalled();
    expect(repository.clear).not.toHaveBeenCalled();
  });
});

function repositoryStub(): MeetingHistoryRepository & {
  getById: ReturnType<typeof vi.fn<(meetingId: string) => Promise<MeetingRecord | null>>>;
  save: ReturnType<typeof vi.fn>;
  deleteById: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn(async () => undefined),
    getById: vi.fn<(meetingId: string) => Promise<MeetingRecord | null>>(),
    list: vi.fn(async () => []),
    deleteById: vi.fn(async () => false),
    clear: vi.fn(async () => undefined),
  };
}

function recordFixture(meetingId: string): MeetingRecord {
  const settings = createMeetingSettingsSnapshot({
    title: '保存済み会議', language: 'ja-JP', transcriptionProvider: 'mock', correctionEnabled: false,
    liveSummaryEnabled: false, finalSummaryEnabled: false, historyRetention: 'page-session',
    externalProcessingAcknowledged: false,
  }, '2026-07-20T01:00:00.000Z');
  return createMeetingRecord({
    meetingId, createdAt: settings.createdAt, startedAt: null, endedAt: '2026-07-20T01:30:00.000Z',
    updatedAt: '2026-07-20T01:30:00.000Z', settingsSnapshot: settings, sentences: [],
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
