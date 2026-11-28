import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { StartTranscriptionOptions } from './transcription/types';
import type { AudioCaptureCallbacks } from './audio/types';

const { startProvider, stopProvider, createProvider } = vi.hoisted(() => ({
  startProvider: vi.fn<(options: StartTranscriptionOptions) => Promise<void>>(async () => undefined),
  stopProvider: vi.fn<() => Promise<void>>(async () => undefined),
  createProvider: vi.fn(),
}));

vi.mock('./audio/audioCapture', () => ({
  AudioCapture: class {
    currentMimeType = 'audio/webm';
    constructor(_sink: unknown, private callbacks: AudioCaptureCallbacks) {}
    async start() { this.callbacks.onStateChange?.('recording'); }
    async stop() { this.callbacks.onStateChange?.('idle'); }
  },
}));
vi.mock('./transcription/providerFactory', () => ({
  createSpeechToTextProvider: (kind: string) => {
    createProvider(kind);
    return {
      id: kind === 'soniox' ? 'soniox' : 'mock', label: 'Mock', isMock: true, isSupported: () => true,
      start: startProvider, stop: stopProvider, abort: async () => undefined,
      acceptChunk: () => undefined,
    };
  },
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

it('starts either way in one click and saves the title with or without a final summary', async () => {
  vi.stubGlobal('indexedDB', {});
  const request = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(
    url.endsWith('/final') && init?.method === 'POST'
      ? { version: 1, overview: '合成の最終要約', agenda: [], keyPoints: [], decisions: [], unresolvedItems: [], actionItems: [], nextChecks: [] }
      : { enabled: true, provider: 'groq', apiUsed: true, intervalSeconds: 10 },
  ), { status: 200 }));
  vi.stubGlobal('fetch', request);
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  await import('./main');
  startProvider.mockClear();
  button('sidebar-collapse-button').click();
  expect(document.getElementById('workspace-sidebar')?.hidden).toBe(true);
  expect(document.activeElement).toBe(button('sidebar-open-button'));
  button('sidebar-open-button').click();
  expect(document.getElementById('workspace-sidebar')?.hidden).toBe(false);
  button('home-settings-button').click();
  const model = document.querySelector<HTMLSelectElement>('#setup-groq-model')!;
  expect(document.querySelector('#setup-provider')).toBeNull();
  model.value = 'whisper-large-v3';
  model.dispatchEvent(new Event('change'));
  button('settings-close-button').click();

  for (const withSummary of [false, true]) {
    const title = withSummary ? 'Second synthetic meeting' : 'First synthetic meeting';
    startProvider.mockClear();
    startProvider.mockImplementationOnce(async (options) => {
      options.callbacks?.onTranscript?.({
        sessionId: options.sessionId, segmentId: 'title-suggestion', sequence: 1,
        revision: 1, text: '合成の会議内容です。', isFinal: true, language: 'ja-JP',
        provider: 'mock', startTime: 0, endTime: 1000, createdAt: new Date().toISOString(),
      });
    });
    button(withSummary ? 'workspace-start-button' : 'new-meeting-button').click();
    expect(document.documentElement.dataset.appView).toBe('meeting');
    expect(document.getElementById('settings-panel')?.hidden).toBe(true);
    expect(button('home-settings-button').hidden).toBe(true);
    expect(document.getElementById('meeting-title')?.textContent).toBe('新規会議');
    await vi.waitFor(() => expect(button('end-meeting-button').disabled).toBe(false));
    expect(startProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenLastCalledWith('groq-whisper');
    expect(startProvider).toHaveBeenCalledWith(expect.objectContaining({ groqModel: 'whisper-large-v3' }));
    expect(button('start-button').dataset.mode).toBe('stop');
    button('start-button').click();
    await vi.waitFor(() => {
      expect(button('start-button').dataset.mode).toBe('start');
      expect(button('start-button').disabled).toBe(false);
    });
    expect(document.documentElement.dataset.appView).toBe('meeting');
    expect(button('start-button').getAttribute('aria-label')).toBe('録音を再開');
    button('end-meeting-button').click();
    expect(input('end-meeting-title-input').value).toBe('合成の会議内容です。');
    input('end-meeting-title-input').value = title;
    const finalRequests = () => request.mock.calls.filter(([url]) => url.endsWith('/final'));
    const summaryButton = button('confirm-end-meeting-with-summary-button');
    await vi.waitFor(() => expect(summaryButton.disabled).toBe(false));
    expect(document.getElementById('end-meeting-summary-status')?.textContent).toContain('Groqに送信');
    expect(finalRequests()).toHaveLength(0);
    (withSummary ? summaryButton : button('confirm-end-meeting-button')).click();
    await vi.waitFor(() => expect(document.documentElement.dataset.appView).toBe('meeting-detail'));
    expect(document.getElementById('detail-title')?.textContent).toBe(title);
    await vi.waitFor(() => expect(button('new-meeting-button').disabled).toBe(false));
    expect(finalRequests()).toHaveLength(withSummary ? 1 : 0);
    if (withSummary) {
      expect(finalRequests()[0]?.[1]?.headers).toMatchObject({ 'x-summary-provider': 'groq' });
      expect(document.body.textContent).toContain('合成の最終要約');
      expect(button('home-settings-button').hidden).toBe(false);
      button('home-settings-button').focus();
      button('home-settings-button').click();
      expect(document.getElementById('settings-panel')?.hidden).toBe(false);
      expect(document.getElementById('meeting-setup-settings')?.hidden).toBe(false);
      button('settings-close-button').click();
      expect(document.activeElement).toBe(button('home-settings-button'));
      expect(document.documentElement.dataset.appView).toBe('meeting-detail');
    }
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
  button('workspace-start-button').click();
  await vi.waitFor(() => expect(button('start-button').dataset.mode).toBe('stop'));
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


it('displays Soniox speaker text while recording and saves only confirmed turns', async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/live')) {
      const { newSentences } = JSON.parse(String(init?.body));
      expect(newSentences).toMatchObject([{ speakerLabel: '話者A', text: '合成の確定結果です。山田です。' }]);
      return new Response(JSON.stringify({ version: 1, topic: null, keyPoints: [], decisions: [], actionItems: [], openQuestions: [],
        speakerNameSuggestions: [{ speakerLabel: '話者A', name: '山田', evidenceSentenceIds: [newSentences[0].id] }],
      }));
    }
    return new Response(JSON.stringify(url.endsWith('/api/transcription/status') ? { sonioxRecordingLimitMs: 600_000 }
      : { enabled: true, provider: 'mock', apiUsed: false, intervalSeconds: 10 }));
  }));
  document.body.innerHTML = readFileSync('index.html', 'utf8');
  await import('./main');
  const sonioxChoice = document.querySelector<HTMLButtonElement>('[role="radio"][data-value="soniox"]')!;
  const sonixChoice = document.querySelector<HTMLButtonElement>('[role="radio"][data-value="sonix"]')!;
  await vi.waitFor(() => expect(sonioxChoice.hidden).toBe(false));
  button('home-settings-button').click();
  expect(sonioxChoice.disabled).toBe(false);
  expect(sonixChoice.hidden).toBe(true);
  expect(sonixChoice.disabled).toBe(true);
  sonioxChoice.click();
  expect(sonioxChoice.getAttribute('aria-checked')).toBe('true');
  button('settings-close-button').click();
  expect(document.querySelector('.home-hero > p')).toBeNull();
  expect(button('workspace-start-button').hasAttribute('aria-description')).toBe(false);

  startProvider.mockClear();
  button('new-meeting-button').click();
  await vi.waitFor(() => expect(startProvider).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(button('start-button').disabled).toBe(false));
  expect(createProvider).toHaveBeenLastCalledWith('soniox');
  const options = startProvider.mock.calls[0]![0];
  const update = {
    sessionId: options.sessionId, revision: 0, language: 'ja-JP' as const,
    startTime: 0, endTime: 1_000, createdAt: new Date().toISOString(),
  };
  options.callbacks?.onTranscript?.({
    ...update, segmentId: 'preview', sequence: 0, provider: 'soniox', text: '話者A　合成の速報', isFinal: false,
  });
  expect(document.getElementById('interim-text')?.textContent).toBe('話者A　合成の速報');
  expect(document.getElementById('final-transcript')?.textContent).not.toContain('合成の速報');

  options.callbacks?.onTranscript?.({
    ...update, segmentId: 'final', sequence: 1, provider: 'soniox', text: '合成の確定結果です。山田です。', isFinal: true, speakerLabel: '話者A',
  });
  options.callbacks?.onTranscript?.({ ...update, segmentId: 'preview', sequence: 2, provider: 'soniox', text: '', isFinal: false });
  expect(document.getElementById('final-transcript')?.textContent).toContain('話者A');
  await vi.waitFor(() => expect(button('summarize-now-button').disabled).toBe(false));
  button('summarize-now-button').click();
  const confirmation = () => document.querySelector<HTMLButtonElement>('#speaker-suggestions button');
  await vi.waitFor(() => expect(confirmation()).not.toBeNull());
  const displayedSpeaker = () => document.querySelector('#final-transcript .utterance__meta > span')?.textContent;
  expect(displayedSpeaker()).toBe('話者A');
  confirmation()?.click();
  expect(displayedSpeaker()).toBe('山田');
  expect(document.getElementById('final-transcript')?.textContent).not.toContain('話者A');
  button('end-meeting-button').click();
  button('confirm-end-meeting-button').click();
  await vi.waitFor(() => expect(document.documentElement.dataset.appView).toBe('meeting-detail'));
  const detail = document.getElementById('detail-transcript')?.textContent;
  expect(detail).toContain('山田');
  expect(detail).not.toContain('話者A');
  expect(detail).toContain('合成の確定結果');
  expect(detail).not.toContain('合成の速報');
  expect(document.getElementById('interim-text')?.textContent).toBe('');
});
