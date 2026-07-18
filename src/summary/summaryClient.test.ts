import { describe, expect, it, vi } from 'vitest';
import type { LiveMeetingSummary, MeetingUsageSummary, SummarySentence } from '../../shared/summary';
import type { CompletedSentence } from '../transcription/types';
import { IncrementalSummaryCoordinator, SummaryHttpClient } from './summaryClient';

function sentence(id: string): CompletedSentence {
  return {
    id, sessionId: 'meeting-1', rawSegmentIds: [`raw-${id}`], rawText: id, displayText: `${id}。`,
    language: 'ja', startTime: 0, endTime: 1, completionReason: 'punctuation',
  };
}

function live(version: number): LiveMeetingSummary {
  return { version, topic: null, keyPoints: [], decisions: [], actionItems: [], openQuestions: [] };
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
});

describe('IncrementalSummaryCoordinator', () => {
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
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('予算上限') })));
    coordinator.dispose();
  });
});
