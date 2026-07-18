import { describe, expect, it } from 'vitest';
import { AudioBufferLimitError, MemoryPendingAudioStorage, PendingAudioQueue } from './pendingAudioQueue';

function item(sequence: number, size = 2) {
  return {
    sessionId: 'session-1', sequence, capturedAt: sequence * 1_000,
    mimeType: 'audio/webm', data: new Blob([new Uint8Array(size)]),
  };
}

describe('PendingAudioQueue', () => {
  it('keeps chunks until the matching acknowledgement arrives', async () => {
    const queue = createQueue();
    await queue.enqueue(item(0));
    expect(await queue.snapshot('session-1')).toMatchObject({ pendingCount: 1, sentUnacknowledgedCount: 0 });
    await queue.markSent('session-1', 0);
    expect(await queue.snapshot('session-1')).toMatchObject({
      chunkCount: 1, pendingCount: 0, sentUnacknowledgedCount: 1,
    });
    expect(await queue.acknowledge('session-1', 1)).toBe(false);
    expect((await queue.snapshot('session-1')).chunkCount).toBe(1);
    expect(await queue.acknowledge('session-1', 0)).toBe(true);
    expect((await queue.snapshot('session-1')).chunkCount).toBe(0);
  });

  it('returns pending chunks in sequence order', async () => {
    const queue = createQueue();
    await queue.enqueue(item(2));
    await queue.enqueue(item(0));
    await queue.enqueue(item(1));
    expect((await queue.listForResend('session-1')).map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
  });

  it('prepares only server-missing chunks for resume', async () => {
    const queue = createQueue();
    await queue.enqueue(item(0));
    await queue.enqueue(item(1));
    await queue.markSent('session-1', 0);
    await queue.markSent('session-1', 1);
    await queue.prepareForResume('session-1', 0);
    expect((await queue.listForResend('session-1')).map((chunk) => chunk.sequence)).toEqual([1]);
  });

  it('rejects new data safely when the byte limit is reached', async () => {
    const queue = new PendingAudioQueue({ maxSeconds: 60, maxBytes: 3, storage: new MemoryPendingAudioStorage() });
    await queue.enqueue(item(0, 2));
    await expect(queue.enqueue(item(1, 2))).rejects.toBeInstanceOf(AudioBufferLimitError);
    expect((await queue.snapshot('session-1')).chunkCount).toBe(1);
  });

  it('reports bounded buffered duration instead of growing without a limit', async () => {
    const queue = new PendingAudioQueue({ maxSeconds: 2, maxBytes: 100, storage: new MemoryPendingAudioStorage() });
    await queue.enqueue(item(0));
    await queue.enqueue(item(1));
    await expect(queue.enqueue(item(2))).rejects.toBeInstanceOf(AudioBufferLimitError);
    expect((await queue.snapshot('session-1')).durationSeconds).toBe(2);
  });
});

function createQueue(): PendingAudioQueue {
  return new PendingAudioQueue({ maxSeconds: 60, maxBytes: 1_000, storage: new MemoryPendingAudioStorage() });
}
