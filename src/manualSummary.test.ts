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

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('summarizes on button press while recording and keeps previous interim summaries', async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', {});
  let version = 0;
  const request = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/live')
      ? { version: ++version, topic: `Topic ${version}`, keyPoints: [], decisions: [], actionItems: [], openQuestions: [] }
      : { enabled: true, provider: 'mock', apiUsed: false, intervalSeconds: 10 }
  ), { status: 200 }));
  vi.stubGlobal('fetch', request);
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  await import('./main');
  let options!: StartTranscriptionOptions;
  startProvider.mockImplementationOnce(async (value) => { options = value; });
  button('workspace-start-button').click();
  await vi.waitFor(() => expect(options).toBeDefined());
  const emit = (sequence: number) => options.callbacks?.onTranscript?.({
    sessionId: options.sessionId, segmentId: `manual-${sequence}`, sequence,
    revision: 1, text: `合成の発言${sequence}です。`, isFinal: true, language: 'ja-JP',
    provider: 'mock', startTime: sequence * 1000, endTime: sequence * 1000 + 500, createdAt: new Date().toISOString(),
  });
  emit(1);
  button('finalize-sentence-button').click();
  await vi.waitFor(() => expect(button('summarize-now-button').disabled).toBe(false));
  expect(version).toBe(0);
  expect(document.getElementById('summary-sheet-content')?.hidden).toBe(true);
  button('summary-toggle-button').click();
  expect(document.getElementById('summary-sheet-content')?.hidden).toBe(false);
  button('summarize-now-button').click();
  button('summarize-now-button').click();
  await vi.waitFor(() => expect(document.getElementById('interim-summary-history')?.childElementCount).toBe(1));
  expect(version).toBe(1);
  expect(button('start-button').dataset.mode).toBe('stop');
  expect(button('summarize-now-button').disabled).toBe(true);
  emit(2);
  button('finalize-sentence-button').click();
  await vi.waitFor(() => expect(button('summarize-now-button').disabled).toBe(false));
  button('summarize-now-button').click();
  await vi.waitFor(() => expect(document.getElementById('interim-summary-history')?.childElementCount).toBe(2));
});
