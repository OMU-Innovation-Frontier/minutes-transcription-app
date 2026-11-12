import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { StartTranscriptionOptions } from './transcription/types';
import type { AudioCaptureCallbacks } from './audio/types';

const { startProvider } = vi.hoisted(() => ({ startProvider: vi.fn<(options: StartTranscriptionOptions) => Promise<void>>(async () => undefined) }));

vi.mock('./audio/audioCapture', () => ({
  AudioCapture: class {
    currentMimeType = 'audio/webm';
    constructor(_sink: unknown, private callbacks: AudioCaptureCallbacks) {}
    async start() { this.callbacks.onStateChange?.('recording'); }
    async stop() { this.callbacks.onStateChange?.('idle'); }
  },
}));
vi.mock('./transcription/providerFactory', () => ({
  getDefaultProviderKind: () => 'mock',
  createSpeechToTextProvider: () => ({
    id: 'mock', label: 'Mock', isMock: true, isSupported: () => true,
    start: startProvider, stop: async () => undefined, abort: async () => undefined,
    acceptChunk: () => undefined,
  }),
}));
vi.mock('./localRecording/localEvaluationRecorder', () => ({
  initializeLocalEvaluationRecorder: () => ({ dispose: () => undefined }),
}));
vi.mock('./history/indexedDbMeetingHistoryRepository', async () => {
  const { InMemoryMeetingHistoryRepository } = await import('./history/inMemoryMeetingHistoryRepository');
  return { IndexedDbMeetingHistoryRepository: class extends InMemoryMeetingHistoryRepository {
    async close() {}
  } };
});

const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('recovers an unfinished meeting after reloading without starting recording', async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    enabled: false, provider: 'mock', apiUsed: false, intervalSeconds: 10,
  }), { status: 200 })));
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  await import('./main');
  button('new-meeting-button').click();
  input('setup-title').value = 'Recovery synthetic meeting';
  input('setup-title').dispatchEvent(new Event('input'));
  document.getElementById('meeting-setup-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
  startProvider.mockClear();
  startProvider.mockRejectedValueOnce({ code: 'network', message: 'Synthetic connection failure' });
  button('start-button').click();
  await vi.waitFor(() => expect(startProvider).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(button('start-button').disabled).toBe(false));
  expect(button('stop-button').disabled).toBe(true);
  startProvider.mockClear();
  startProvider.mockImplementationOnce(async (options) => {
    options.callbacks?.onTranscript?.({
      sessionId: options.sessionId, segmentId: 'synthetic-segment', sequence: 1,
      revision: 1, text: '保存する合成発言です。', isFinal: true, language: 'ja-JP',
      provider: 'mock', startTime: 0, endTime: 1000, createdAt: new Date().toISOString(),
    });
  });
  button('start-button').click();
  await vi.waitFor(() => expect(button('start-button').disabled).toBe(true));
  await vi.waitFor(() => expect(startProvider).toHaveBeenCalled());
  window.dispatchEvent(new Event('pagehide'));
  vi.resetModules();
  startProvider.mockClear();
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  await import('./main');
  expect(document.documentElement.dataset.appView).toBe('meeting');
  expect(document.getElementById('meeting-title')?.textContent).toBe('Recovery synthetic meeting');
  expect(button('start-button').disabled).toBe(false);
  expect(startProvider).not.toHaveBeenCalled();
  expect(document.getElementById('final-transcript')?.textContent).toContain('保存する合成発言です。');
});
