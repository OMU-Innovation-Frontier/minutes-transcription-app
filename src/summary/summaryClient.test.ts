import { describe, expect, it, vi } from 'vitest';
import type { FinalMeetingSummary, LiveMeetingSummary, MeetingUsageSummary, SummarySentence } from '../../shared/summary';
import type { CompletedSentence } from '../transcription/types';
import { IncrementalSummaryCoordinator, SummaryHttpClient, toSummarySentence, type SummaryStatus } from './summaryClient';

function sentence(id: string): CompletedSentence {
  return {
    id, sessionId: 'meeting-1', rawSegmentIds: [`raw-${id}`], rawText: id, displayText: `${id}。`,
    language: 'ja', revision: 0, startTime: 0, endTime: 1, completionReason: 'punctuation',
  };
}

function live(version: number): LiveMeetingSummary {
  return { version, topic: null, keyPoints: [], decisions: [], actionItems: [], openQuestions: [] };
}

function finalSummary(): FinalMeetingSummary {
  return {
    version: 1, overview: 'overview', agenda: [], keyPoints: [], decisions: [], unresolvedItems: [], actionItems: [], nextChecks: [],
  };
}

describe('SummaryHttpClient', () => {
  it('keeps the Window receiver for default and explicitly injected window.fetch calls', async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(window, 'fetch');
    const request = vi.fn(function (this: Window, _input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== window) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      const value = init?.method === 'POST'
        ? live(1)
        : { enabled: true, provider: 'mock', apiUsed: false, intervalSeconds: 10 };
      return Promise.resolve(new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: request });

    try {
      const defaultClient = new SummaryHttpClient('http://127.0.0.1:8787');
      await expect(defaultClient.status()).resolves.toMatchObject({ enabled: true, provider: 'mock' });

      const injectedClient = new SummaryHttpClient('http://127.0.0.1:8787', window.fetch);
      await expect(injectedClient.update('meeting-1', null, [])).resolves.toEqual(live(1));
      expect(request).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8787/api/summary/status');
      expect(request).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8787/api/summary/live', expect.objectContaining({ method: 'POST' }));
    } finally {
      if (originalFetch) Object.defineProperty(window, 'fetch', originalFetch);
      else Reflect.deleteProperty(window, 'fetch');
    }
  });

  it('sends the final-summary payload expected by the server and validates the response', async () => {
    const request = vi.fn(async () => new Response(
      JSON.stringify(finalSummary()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new SummaryHttpClient('http://127.0.0.1:8787', request as typeof fetch);
    const sentences = [{ id: 'one', text: 'test sentence', startTime: 0, endTime: 1 }];

    await expect(client.finalize('meeting-1', null, sentences)).resolves.toEqual(finalSummary());
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:8787/api/summary/final', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingId: 'meeting-1', liveSummary: null, sentences }),
    }));
  });

  it('does not expose a server error message to the caller', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      code: 'internal_error',
      message: 'technical details must not be exposed',
    }), { status: 500, headers: { 'content-type': 'application/json' } }));
    const client = new SummaryHttpClient('http://127.0.0.1:8787', request as typeof fetch);

    await expect(client.status()).rejects.toThrow('要約サービスとの通信に失敗しました。');
    await expect(client.status()).rejects.not.toThrow('technical details');
  });

  it('recovers through the HTTP client when status fails once and the next retry succeeds', async () => {
    let statusCalls = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/summary/status')) {
        statusCalls += 1;
        if (statusCalls === 1) throw new TypeError('temporary connection failure');
        return new Response(JSON.stringify({
          enabled: true, provider: 'mock', apiUsed: false, intervalSeconds: 10,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/api/summary/final')) {
        return new Response(JSON.stringify(finalSummary()), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, pricingConfigured: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const coordinator = new IncrementalSummaryCoordinator(
      new SummaryHttpClient('http://127.0.0.1:8787', request as typeof fetch),
      'meeting-1',
      2,
    );

    await expect(coordinator.finalize([sentence('one')])).resolves.toEqual({
      status: 'failed', reason: 'status_unavailable',
    });
    await expect(coordinator.finalize([sentence('one')])).resolves.toEqual({
      status: 'succeeded', summary: finalSummary(),
    });

    expect(statusCalls).toBe(2);
    expect(request.mock.calls.map(([input]) => String(input))).toEqual([
      'http://127.0.0.1:8787/api/summary/status',
      'http://127.0.0.1:8787/api/summary/status',
      'http://127.0.0.1:8787/api/summary/final',
    ]);
  });

  it('retries the final endpoint through the HTTP client after one safe failure', async () => {
    let finalCalls = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/summary/status')) {
        return new Response(JSON.stringify({
          enabled: true, provider: 'mock', apiUsed: false, intervalSeconds: 10,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      finalCalls += 1;
      return finalCalls === 1
        ? new Response(JSON.stringify({ code: 'internal_error', message: 'private detail' }), {
          status: 500, headers: { 'content-type': 'application/json' },
        })
        : new Response(JSON.stringify(finalSummary()), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
    });
    const coordinator = new IncrementalSummaryCoordinator(
      new SummaryHttpClient('http://127.0.0.1:8787', request as typeof fetch),
      'meeting-1',
      2,
    );

    await expect(coordinator.finalize([sentence('one')])).resolves.toEqual({
      status: 'failed', reason: 'final_api_failed',
    });
    await expect(coordinator.finalize([sentence('one')])).resolves.toEqual({
      status: 'succeeded', summary: finalSummary(),
    });

    expect(request.mock.calls.filter(([input]) => String(input).endsWith('/api/summary/status'))).toHaveLength(1);
    expect(finalCalls).toBe(2);
  });
});

describe('IncrementalSummaryCoordinator', () => {
  it('prefers validated correctedText and otherwise uses immutable rawText', () => {
    const completed = sentence('one');
    completed.correction = {
      rawText: completed.rawText,
      correctedText: 'corrected text',
      status: 'completed',
      sourceSegmentIds: [...completed.rawSegmentIds],
      changes: [],
      uncertainParts: [],
    };
    expect(toSummarySentence(completed).text).toBe('corrected text');
    completed.correction = { ...completed.correction, status: 'pending', correctedText: 'must not be used' };
    expect(toSummarySentence(completed).text).toBe(completed.rawText);
  });

  it('finalizes unique sentences once without creating an incremental summary request', async () => {
    const finalize = vi.fn(async (...args: [string, LiveMeetingSummary | null, SummarySentence[]]) => {
      void args;
      return finalSummary();
    });
    const update = vi.fn();
    const client = {
      status: async () => ({ enabled: true, provider: 'mock' as const, apiUsed: false, intervalSeconds: 10 }),
      update,
      usage: async (): Promise<MeetingUsageSummary> => ({
        inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, pricingConfigured: true,
      }),
      finalize,
    } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 2);
    const first = sentence('one');
    await expect(coordinator.finalize([first, first])).resolves.toEqual({ status: 'succeeded', summary: finalSummary() });
    await expect(coordinator.finalize([first])).resolves.toEqual({ status: 'succeeded', summary: finalSummary() });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize.mock.calls[0]?.[2].map((item) => item.id)).toEqual(['one']);
    expect(update).not.toHaveBeenCalled();
  });

  it('retries a failed finalization with unique sentences and safe correction selection', async () => {
    const corrected = sentence('one');
    corrected.correction = {
      rawText: corrected.rawText,
      correctedText: 'corrected one',
      status: 'completed',
      sourceSegmentIds: [...corrected.rawSegmentIds],
      changes: [],
      uncertainParts: [],
    };
    const pending = sentence('two');
    pending.correction = {
      rawText: pending.rawText,
      correctedText: 'must not be used',
      status: 'pending',
      sourceSegmentIds: [...pending.rawSegmentIds],
      changes: [],
      uncertainParts: [],
    };
    const finalize = vi.fn()
      .mockRejectedValueOnce(new Error('safe test failure'))
      .mockResolvedValueOnce(finalSummary());
    const client = {
      status: async () => ({ enabled: true, provider: 'mock' as const, apiUsed: false, intervalSeconds: 10 }),
      update: vi.fn(),
      usage: async (): Promise<MeetingUsageSummary> => ({
        inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, pricingConfigured: true,
      }),
      finalize,
    } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 2);

    await expect(coordinator.finalize([corrected, corrected, pending])).resolves.toEqual({
      status: 'failed', reason: 'final_api_failed',
    });
    await expect(coordinator.finalize([corrected, corrected, pending])).resolves.toEqual({
      status: 'succeeded', summary: finalSummary(),
    });

    expect(finalize).toHaveBeenCalledTimes(2);
    expect(finalize.mock.calls[1]?.[2]).toEqual([
      expect.objectContaining({ id: 'one', text: 'corrected one' }),
      expect.objectContaining({ id: 'two', text: pending.rawText }),
    ]);
  });

  it('re-fetches status after a transient initialization failure and then finalizes', async () => {
    const status = vi.fn()
      .mockRejectedValueOnce(new Error('temporary status failure'))
      .mockResolvedValueOnce({ enabled: true, provider: 'mock' as const, apiUsed: false, intervalSeconds: 10 });
    const finalize = vi.fn(async () => finalSummary());
    const onError = vi.fn();
    const client = {
      status,
      update: vi.fn(),
      usage: async (): Promise<MeetingUsageSummary> => ({
        inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, pricingConfigured: true,
      }),
      finalize,
    } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 2, { onError });

    await expect(coordinator.finalize([sentence('one')])).resolves.toEqual({
      status: 'failed', reason: 'status_unavailable',
    });
    await expect(coordinator.finalize([sentence('one')])).resolves.toEqual({
      status: 'succeeded', summary: finalSummary(),
    });

    expect(status).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: '要約機能の状態を確認できませんでした。',
    }));
  });

  it('shares a status request while initialization is in progress', async () => {
    let resolveStatus!: (status: SummaryStatus) => void;
    const status = vi.fn(() => new Promise<SummaryStatus>((resolve) => { resolveStatus = resolve; }));
    const client = {
      status,
      update: vi.fn(),
      usage: vi.fn(),
      finalize: vi.fn(async () => finalSummary()),
    } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 2);

    const first = coordinator.finalize([sentence('one')]);
    const second = coordinator.finalize([sentence('one')]);
    expect(status).toHaveBeenCalledOnce();
    resolveStatus({ enabled: true, provider: 'mock', apiUsed: false, intervalSeconds: 10 });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'succeeded', summary: finalSummary() },
      { status: 'succeeded', summary: finalSummary() },
    ]);
    expect(client.finalize).toHaveBeenCalledOnce();
  });

  it('distinguishes a disabled provider and never calls the final endpoint', async () => {
    const finalize = vi.fn();
    const client = {
      status: vi.fn(async () => ({ enabled: false, provider: 'mock' as const, apiUsed: false, intervalSeconds: 10 })),
      update: vi.fn(),
      usage: vi.fn(),
      finalize,
    } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 2);

    await expect(coordinator.finalize([sentence('one')])).resolves.toEqual({ status: 'disabled' });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('ignores a delayed status result after disposal', async () => {
    let resolveStatus!: (status: SummaryStatus) => void;
    const onStatus = vi.fn();
    const onFinalSummary = vi.fn();
    const status = vi.fn(() => new Promise<SummaryStatus>((resolve) => { resolveStatus = resolve; }));
    const finalize = vi.fn(async () => finalSummary());
    const client = { status, update: vi.fn(), usage: vi.fn(), finalize } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 2, { onStatus, onFinalSummary });

    const pending = coordinator.finalize([sentence('one')]);
    coordinator.dispose();
    resolveStatus({ enabled: true, provider: 'mock', apiUsed: false, intervalSeconds: 10 });

    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(finalize).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onFinalSummary).not.toHaveBeenCalled();
  });

  it('ignores a delayed final result after disposal', async () => {
    let resolveFinal!: (summary: FinalMeetingSummary) => void;
    const onFinalSummary = vi.fn();
    const finalize = vi.fn(() => new Promise<FinalMeetingSummary>((resolve) => { resolveFinal = resolve; }));
    const client = {
      status: vi.fn(async () => ({ enabled: true, provider: 'mock' as const, apiUsed: false, intervalSeconds: 10 })),
      update: vi.fn(),
      usage: vi.fn(),
      finalize,
    } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 2, { onFinalSummary });

    const pending = coordinator.finalize([sentence('one')]);
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce());
    coordinator.dispose();
    resolveFinal(finalSummary());

    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(onFinalSummary).not.toHaveBeenCalled();
  });

  it('sends only newly completed sentences instead of the full meeting each time', async () => {
    let version = 0;
    const update = vi.fn(async (...args: [string, LiveMeetingSummary | null, SummarySentence[]]) => {
      void args;
      return live(++version);
    });
    const client = {
      status: async () => ({ enabled: true, provider: 'mock' as const, apiUsed: false, intervalSeconds: 10 }),
      update,
      usage: async (): Promise<MeetingUsageSummary> => ({
        inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, pricingConfigured: true,
      }),
      finalize: vi.fn(),
    } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 2);
    await coordinator.initialize();
    coordinator.add([sentence('one'), sentence('two')]);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    coordinator.add([sentence('one'), sentence('two'), sentence('three'), sentence('four')]);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[0]?.[2].map((item) => item.id)).toEqual(['one', 'two']);
    expect(update.mock.calls[1]?.[2].map((item) => item.id)).toEqual(['three', 'four']);
    coordinator.dispose();
  });

  it('reports a budget error without throwing into the recording path', async () => {
    const onError = vi.fn();
    const client = {
      status: async () => ({ enabled: true, provider: 'openai' as const, apiUsed: true, intervalSeconds: 10 }),
      update: async () => { throw new Error('会議単位の要約予算上限に達しました。'); },
      usage: vi.fn(),
      finalize: vi.fn(),
    } as unknown as SummaryHttpClient;
    const coordinator = new IncrementalSummaryCoordinator(client, 'meeting-1', 1, { onError });
    await coordinator.initialize();
    expect(() => coordinator.add([sentence('one')])).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'ライブ要約を更新できませんでした。',
    })));
    coordinator.dispose();
  });
});
