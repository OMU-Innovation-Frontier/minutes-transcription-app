import { describe, expect, it, vi } from 'vitest';
import type { MeetingHistoryRepository } from './meetingHistoryRepository';
import { MeetingHistoryDeleteController } from './meetingHistoryDeleteController';

describe('MeetingHistoryDeleteController', () => {
  it('starts idle and fixes the target only when confirmation begins', () => {
    const repository = repositoryStub();
    const controller = new MeetingHistoryDeleteController(repository);

    expect(controller.state).toEqual({ status: 'idle' });
    expect(controller.confirm('meeting-1', '<script>title</script>')).toBe(true);
    expect(controller.state).toEqual({
      status: 'confirming',
      meetingId: 'meeting-1',
      title: '<script>title</script>',
    });
    expect(repository.deleteById).not.toHaveBeenCalled();
  });

  it('rejects invalid IDs without deleting and reports an unavailable repository', () => {
    const repository = repositoryStub();
    const controller = new MeetingHistoryDeleteController(repository);

    expect(controller.confirm('', 'invalid')).toBe(false);
    expect(controller.confirm(' meeting-1', 'invalid')).toBe(false);
    expect(controller.state).toEqual({ status: 'idle' });
    expect(repository.deleteById).not.toHaveBeenCalled();

    const unavailable = new MeetingHistoryDeleteController(null);
    expect(unavailable.confirm('meeting-1', 'title')).toBe(false);
    expect(unavailable.state).toEqual({ status: 'unavailable' });
  });

  it('cancels confirmation without calling deleteById', async () => {
    const repository = repositoryStub();
    const controller = new MeetingHistoryDeleteController(repository);
    controller.confirm('meeting-1', 'title');

    controller.cancel();
    await controller.delete();

    expect(controller.state).toEqual({ status: 'idle' });
    expect(repository.deleteById).not.toHaveBeenCalled();
  });

  it('moves through deleting to deleted for a successful deletion', async () => {
    const repository = repositoryStub();
    const pending = deferred<boolean>();
    repository.deleteById.mockReturnValue(pending.promise);
    const states: string[] = [];
    const controller = new MeetingHistoryDeleteController(repository, ({ status }) => states.push(status));
    controller.confirm('meeting-1', 'title');

    const deletion = controller.delete();
    expect(controller.state).toEqual({ status: 'deleting', meetingId: 'meeting-1', title: 'title' });
    pending.resolve(true);
    await deletion;

    expect(controller.state).toEqual({ status: 'deleted', meetingId: 'meeting-1' });
    expect(states).toEqual(['confirming', 'deleting', 'deleted']);
    expect(repository.deleteById).toHaveBeenCalledOnce();
    expect(repository.deleteById).toHaveBeenCalledWith('meeting-1');
  });

  it('distinguishes a missing target from a repository failure without exposing error details', async () => {
    const repository = repositoryStub();
    const controller = new MeetingHistoryDeleteController(repository);
    repository.deleteById.mockResolvedValueOnce(false).mockRejectedValueOnce(
      new Error('IndexedDB secret internal details'),
    );

    controller.confirm('missing', 'missing title');
    await controller.delete();
    expect(controller.state).toEqual({ status: 'not_found', meetingId: 'missing' });

    controller.confirm('failed', 'fixed title');
    await controller.delete();
    expect(controller.state).toEqual({ status: 'failed', meetingId: 'failed', title: 'fixed title' });
    expect(JSON.stringify(controller.state)).not.toContain('IndexedDB secret internal details');
  });

  it('shares one in-flight deletion across repeated confirmation and delete attempts', async () => {
    const repository = repositoryStub();
    const pending = deferred<boolean>();
    repository.deleteById.mockReturnValue(pending.promise);
    const controller = new MeetingHistoryDeleteController(repository);
    controller.confirm('meeting-1', 'title');

    const first = controller.delete();
    const second = controller.delete();
    expect(second).toBe(first);
    expect(controller.confirm('meeting-2', 'other')).toBe(false);
    pending.resolve(true);
    await Promise.all([first, second]);

    expect(repository.deleteById).toHaveBeenCalledTimes(1);
    expect(repository.deleteById).not.toHaveBeenCalledWith('meeting-2');
  });

  it('retries manually with the fixed target and prevents duplicate retries', async () => {
    const repository = repositoryStub();
    const retry = deferred<boolean>();
    repository.deleteById
      .mockRejectedValueOnce(new Error('temporary'))
      .mockReturnValueOnce(retry.promise);
    const controller = new MeetingHistoryDeleteController(repository);
    controller.confirm('meeting-1', 'fixed title');
    await controller.delete();

    const first = controller.retry();
    const second = controller.retry();
    expect(second).toBe(first);
    expect(controller.state).toEqual({ status: 'deleting', meetingId: 'meeting-1', title: 'fixed title' });
    retry.resolve(true);
    await Promise.all([first, second]);

    expect(repository.deleteById).toHaveBeenCalledTimes(2);
    expect(repository.deleteById.mock.calls).toEqual([['meeting-1'], ['meeting-1']]);
  });

  it('releases the completed in-flight operation and discards an old failed target', async () => {
    const repository = repositoryStub();
    repository.deleteById.mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce(true);
    const controller = new MeetingHistoryDeleteController(repository);
    controller.confirm('old', 'old title');
    await controller.delete();

    expect(controller.confirm('new', 'new title')).toBe(true);
    await controller.delete();

    expect(repository.deleteById.mock.calls).toEqual([['old'], ['new']]);
    expect(controller.state).toEqual({ status: 'deleted', meetingId: 'new' });
  });

  it('invalidates a delayed success after clear and keeps the operation in flight until it settles', async () => {
    const repository = repositoryStub();
    const pending = deferred<boolean>();
    repository.deleteById.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true);
    const states: string[] = [];
    const controller = new MeetingHistoryDeleteController(repository, ({ status }) => states.push(status));
    controller.confirm('meeting-a', 'A');

    const deletion = controller.delete();
    controller.clear();
    expect(controller.state).toEqual({ status: 'idle' });
    expect(controller.confirm('meeting-b', 'B')).toBe(false);

    pending.resolve(true);
    await deletion;

    expect(states).toEqual(['confirming', 'deleting', 'idle']);
    expect(controller.state).toEqual({ status: 'idle' });
    expect(controller.confirm('meeting-b', 'B')).toBe(true);
    await controller.delete();
    expect(repository.deleteById.mock.calls).toEqual([['meeting-a'], ['meeting-b']]);
  });

  it('ignores delayed success and failure after dispose and starts no later deletion', async () => {
    const repository = repositoryStub();
    const success = deferred<boolean>();
    const failure = deferred<boolean>();
    repository.deleteById.mockReturnValueOnce(success.promise).mockReturnValueOnce(failure.promise);
    const successStates: string[] = [];
    const failureStates: string[] = [];

    const successController = new MeetingHistoryDeleteController(
      repository,
      ({ status }) => successStates.push(status),
    );
    successController.confirm('success', 'title');
    const successOperation = successController.delete();
    successController.dispose();
    success.resolve(true);
    await successOperation;
    expect(successController.state).toEqual({ status: 'disposed' });
    expect(successStates).toEqual(['confirming', 'deleting']);

    const failureController = new MeetingHistoryDeleteController(
      repository,
      ({ status }) => failureStates.push(status),
    );
    failureController.confirm('failure', 'title');
    const failureOperation = failureController.delete();
    failureController.dispose();
    failure.reject(new Error('late'));
    await failureOperation;
    expect(failureController.state).toEqual({ status: 'disposed' });
    expect(failureStates).toEqual(['confirming', 'deleting']);

    const callsBefore = repository.deleteById.mock.calls.length;
    expect(failureController.confirm('after-dispose', 'title')).toBe(false);
    await failureController.delete();
    expect(repository.deleteById).toHaveBeenCalledTimes(callsBefore);
  });

  it('never saves or clears history and never deletes another record', async () => {
    const repository = repositoryStub();
    repository.deleteById.mockResolvedValue(true);
    const controller = new MeetingHistoryDeleteController(repository);
    controller.confirm('target', 'title');
    await controller.delete();

    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.getById).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.clear).not.toHaveBeenCalled();
    expect(repository.deleteById).toHaveBeenCalledWith('target');
    expect(repository.deleteById).not.toHaveBeenCalledWith('other');
  });
});

function repositoryStub(): MeetingHistoryRepository & {
  save: ReturnType<typeof vi.fn>;
  deleteById: ReturnType<typeof vi.fn<(meetingId: string) => Promise<boolean>>>;
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn(async () => undefined),
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
    deleteById: vi.fn<(meetingId: string) => Promise<boolean>>(),
    clear: vi.fn(async () => undefined),
  };
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
