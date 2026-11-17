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

it('records consecutive meetings with fresh setup fields and enabled recording controls', async () => {
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    enabled: false, provider: 'mock', apiUsed: false, intervalSeconds: 10,
  }), { status: 200 })));
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  await import('./main');

  for (const title of ['First synthetic meeting', 'Second synthetic meeting']) {
    button('new-meeting-button').click();
    expect(input('setup-title').value).toBe('新しい会議');
    expect(input('setup-external-ack').checked).toBe(false);
    expect(input('setup-final-summary').checked).toBe(false);
    input('setup-title').value = title;
    input('setup-title').dispatchEvent(new Event('input'));
    document.getElementById('meeting-setup-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(document.documentElement.dataset.appView).toBe('meeting');
    expect(button('start-button').disabled).toBe(false);
    expect(button('start-button').textContent).toBe('録音を開始');
    if (title.startsWith('First')) {
      startProvider.mockRejectedValueOnce({ code: 'network', message: '接続失敗の合成テスト' });
      button('start-button').click();
      await vi.waitFor(() => expect(button('start-button').disabled).toBe(false));
      expect(button('stop-button').disabled).toBe(true);
      expect(document.getElementById('error')?.textContent ?? document.body.textContent).toContain('接続失敗の合成テスト');
      startProvider.mockClear();
    }
    button('start-button').click();
    await vi.waitFor(() => expect(startProvider).toHaveBeenCalledTimes(title.startsWith('First') ? 1 : 2));
    button('end-meeting-button').click();
    button('confirm-end-meeting-button').click();
    await vi.waitFor(() => expect(document.documentElement.dataset.appView).toBe('meeting-detail'));
    await vi.waitFor(() => expect(button('confirm-end-meeting-button').disabled).toBe(false));
    button('detail-home-button').click();
    input('setup-external-ack').checked = true;
    input('setup-final-summary').checked = true;
  }

  const deleteLatest = () => document.querySelector<HTMLButtonElement>('[aria-label="「Second synthetic meeting」を削除"]');
  await vi.waitFor(() => expect(deleteLatest()?.disabled).toBe(false));
  deleteLatest()?.click();
  expect(document.documentElement.dataset.appView).toBe('home');
  expect(document.getElementById('delete-meeting-history-dialog')?.hidden).toBe(false);
  expect(document.getElementById('delete-meeting-history-title')?.textContent).toBe('Second synthetic meeting');
  button('cancel-delete-meeting-history-button').click();
  expect(deleteLatest()).not.toBeNull();
  deleteLatest()?.click();
  button('confirm-delete-meeting-history-button').click();
  await vi.waitFor(() => expect(deleteLatest()).toBeNull());
  await vi.waitFor(() => expect(document.getElementById('delete-meeting-history-dialog')?.hidden).toBe(true));
  expect(document.querySelector('[aria-label="「First synthetic meeting」を削除"]')).not.toBeNull();
  expect(document.getElementById('meeting-history-list')?.textContent).not.toContain('Second synthetic meeting');
  expect(document.documentElement.dataset.appView).toBe('home');
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
  button('new-meeting-button').click();
  input('setup-live-summary').checked = true;
  input('setup-live-summary').dispatchEvent(new Event('input'));
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#meeting-setup-form button[type=submit]')!.disabled).toBe(false));
  document.getElementById('meeting-setup-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
  let options!: StartTranscriptionOptions;
  startProvider.mockImplementationOnce(async (value) => { options = value; });
  button('start-button').click();
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
  button('summarize-now-button').click();
  button('summarize-now-button').click();
  await vi.waitFor(() => expect(document.getElementById('interim-summary-history')?.childElementCount).toBe(1));
  expect(version).toBe(1);
  expect(button('stop-button').disabled).toBe(false);
  expect(button('summarize-now-button').disabled).toBe(true);
  emit(2);
  button('finalize-sentence-button').click();
  await vi.waitFor(() => expect(button('summarize-now-button').disabled).toBe(false));
  button('summarize-now-button').click();
  await vi.waitFor(() => expect(document.getElementById('interim-summary-history')?.childElementCount).toBe(2));
});
