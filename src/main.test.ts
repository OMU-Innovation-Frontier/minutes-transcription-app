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

it('starts consecutive meetings in one click and saves the edited title', async () => {
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    enabled: false, provider: 'mock', apiUsed: false, intervalSeconds: 10,
  }), { status: 200 })));
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  await import('./main');

  for (const title of ['First synthetic meeting', 'Second synthetic meeting']) {
    startProvider.mockClear();
    startProvider.mockImplementationOnce(async (options) => {
      options.callbacks?.onTranscript?.({
        sessionId: options.sessionId, segmentId: 'title-suggestion', sequence: 1,
        revision: 1, text: '合成の会議内容です。', isFinal: true, language: 'ja-JP',
        provider: 'mock', startTime: 0, endTime: 1000, createdAt: new Date().toISOString(),
      });
    });
    button('new-meeting-button').click();
    expect(document.documentElement.dataset.appView).toBe('meeting');
    expect(document.getElementById('meeting-title')?.textContent).toBe('新規会議');
    await vi.waitFor(() => expect(button('end-meeting-button').disabled).toBe(false));
    expect(startProvider).toHaveBeenCalledTimes(1);
    button('end-meeting-button').click();
    expect(input('end-meeting-title-input').value).toBe('合成の会議内容です。');
    input('end-meeting-title-input').value = title;
    button('confirm-end-meeting-button').click();
    await vi.waitFor(() => expect(document.documentElement.dataset.appView).toBe('meeting-detail'));
    expect(document.getElementById('detail-title')?.textContent).toBe(title);
    await vi.waitFor(() => expect(button('new-meeting-button').disabled).toBe(false));
    button('detail-home-button').click();
  }

  const firstMeeting = () => document.querySelector<HTMLButtonElement>('[aria-label^="「First synthetic meeting」の詳細"]');
  firstMeeting()?.click();
  const rename = [...document.querySelectorAll<HTMLButtonElement>('.history-entry__menu button')]
    .find((action) => action.textContent === '名前を変更' && action.closest('li')?.contains(firstMeeting()));
  expect(rename).toBeDefined();
  rename?.click();
  expect(input('rename-meeting-history-input').value).toBe('First synthetic meeting');
  input('rename-meeting-history-input').value = '  Renamed synthetic meeting  ';
  document.getElementById('rename-meeting-history-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(document.getElementById('detail-title')?.textContent).toBe('Renamed synthetic meeting'));
  expect(document.getElementById('detail-transcript')?.textContent).toContain('合成の会議内容です。');
  await vi.waitFor(() => expect(document.getElementById('rename-meeting-history-dialog')?.hidden).toBe(true));
  button('detail-home-button').click();

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
  expect(document.querySelector('[aria-label="「Renamed synthetic meeting」を削除"]')).not.toBeNull();
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
  startProvider.mockClear();
  startProvider.mockImplementationOnce(async (options) => {
    options.callbacks?.onTranscript?.({
      sessionId: options.sessionId, segmentId: 'synthetic-segment', sequence: 1,
      revision: 1, text: '保存する合成発言です。', isFinal: true, language: 'ja-JP',
      provider: 'mock', startTime: 0, endTime: 1000, createdAt: new Date().toISOString(),
    });
  });
  button('new-meeting-button').click();
  await vi.waitFor(() => expect(button('start-button').disabled).toBe(true));
  await vi.waitFor(() => expect(startProvider).toHaveBeenCalled());
  window.dispatchEvent(new Event('pagehide'));
  vi.resetModules();
  startProvider.mockClear();
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  await import('./main');
  expect(document.documentElement.dataset.appView).toBe('meeting');
  expect(document.getElementById('meeting-title')?.textContent).toBe('新規会議');
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
  button('home-settings-button').click();
  input('setup-live-summary').click();
  await vi.waitFor(() => expect(document.getElementById('setup-error')?.hidden).toBe(true));
  button('settings-close-button').click();
  let options!: StartTranscriptionOptions;
  startProvider.mockImplementationOnce(async (value) => { options = value; });
  button('new-meeting-button').click();
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
