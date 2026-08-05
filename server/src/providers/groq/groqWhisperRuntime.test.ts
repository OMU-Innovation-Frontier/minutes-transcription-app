// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { PcmUtterance } from '../local/pcmUtteranceSegmenter.js';
import { GroqWhisperClient } from './groqWhisperClient.js';
import { GroqWhisperRuntime, type GroqWhisperJob } from './groqWhisperRuntime.js';
import { GroqWhisperUsageGuard } from './groqWhisperUsageGuard.js';

describe('GroqWhisperRuntime', () => {
  it('bounds concurrency, rejects queue overflow, and lets later jobs continue after failure', async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (calls <= 2) await new Promise<void>((resolve) => { releases.push(resolve); });
      active -= 1;
      return calls === 3
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify({ text: `result-${calls}` }), { headers: { 'content-type': 'application/json' } });
    });
    const runtime = createRuntime(fetchMock, 2, 2);
    runtime.registerSession('session');
    const completed: string[] = [];
    const errors: string[] = [];
    runtime.enqueueMany([1, 2].map((id) => job(id, completed, errors)));
    await waitFor(() => calls === 2);
    expect(peak).toBe(2);
    runtime.enqueueMany([job(3, completed, errors), job(4, completed, errors)]);
    expect(() => runtime.enqueueMany([job(5, completed, errors)])).toThrowError(expect.objectContaining({ code: 'groq_queue_limit' }));
    for (const release of releases) release();
    await runtime.waitForSession('session');
    expect(errors).toContain('groq_request_failed');
    expect(completed.length).toBe(3);
    runtime.unregisterSession('session');
    await runtime.close();
  });

  it('deduplicates utterance IDs and aborts a cancelled session', async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const runtime = createRuntime(fetchMock, 1, 8);
    runtime.registerSession('session');
    const duplicate = job(1, [], []);
    runtime.enqueueMany([duplicate, duplicate]);
    await waitFor(() => fetchMock.mock.calls.length === 1);
    runtime.cancelSession('session');
    await runtime.waitForSession('session');
    expect(fetchMock).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('checks usage before fetch and conservatively counts a failed request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }));
    const runtime = new GroqWhisperRuntime(
      new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000, fetch: fetchMock }),
      new GroqWhisperUsageGuard({ maxSessionSeconds: 0.1, maxHourSeconds: 0.1, maxDaySeconds: 0.1 }),
      { maxConcurrency: 1, maxQueueSize: 8 },
    );
    runtime.registerSession('session');
    const errors: string[] = [];
    runtime.enqueueMany([job(1, [], errors), job(2, [], errors)]);
    await runtime.waitForSession('session');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errors).toEqual(['groq_request_failed', 'groq_usage_limit']);
    runtime.unregisterSession('session');
    await runtime.close();
  });

  it('bounds active sessions', async () => {
    const runtime = new GroqWhisperRuntime(
      new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000, fetch: vi.fn() }),
      new GroqWhisperUsageGuard({ maxSessionSeconds: 1, maxHourSeconds: 1, maxDaySeconds: 1 }),
      { maxConcurrency: 1, maxQueueSize: 1, maxSessions: 1 },
    );
    runtime.registerSession('one');
    expect(() => runtime.registerSession('two')).toThrowError(expect.objectContaining({ code: 'groq_session_limit' }));
    runtime.unregisterSession('one');
    await runtime.close();
  });

  it('stops new external requests after an authentication failure', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }));
    const runtime = createRuntime(fetchMock, 1, 8);
    runtime.registerSession('session');
    const errors: string[] = [];
    runtime.enqueueMany([job(1, [], errors), job(2, [], errors)]);
    await runtime.waitForSession('session');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errors).toEqual(['groq_auth_failed', 'groq_auth_failed']);
    runtime.unregisterSession('session');
    expect(() => runtime.registerSession('next-session'))
      .toThrowError(expect.objectContaining({ code: 'groq_auth_failed' }));
    await runtime.close();
  });
});

function createRuntime(fetchMock: typeof fetch, maxConcurrency: number, maxQueueSize: number): GroqWhisperRuntime {
  return new GroqWhisperRuntime(
    new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 10_000, fetch: fetchMock }),
    new GroqWhisperUsageGuard({ maxSessionSeconds: 100, maxHourSeconds: 100, maxDaySeconds: 100 }),
    { maxConcurrency, maxQueueSize },
  );
}

function job(id: number, completed: string[], errors: string[]): GroqWhisperJob {
  return { sessionId: 'session', utteranceId: `session:${id}`, language: 'ja', utterance: utterance(), createdAt: Date.now(), generation: 1,
    onStarted: () => undefined, onCompleted: (result) => completed.push(result.text), onError: (error) => errors.push(error.code) };
}

function utterance(): PcmUtterance {
  return { pcm: Buffer.alloc(3_200), startFrame: 0, endFrame: 1_600, audioDurationMs: 100,
    sequenceStart: 0, sequenceEnd: 0, reason: 'silence', adaptiveNoiseFloor: 0 };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition not reached');
}
