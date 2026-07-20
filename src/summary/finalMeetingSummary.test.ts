import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalMeetingSummary } from '../../shared/summary';
import { createMeetingSettingsSnapshot, createInitialMeetingSetupDraft } from '../meetingSetup/meetingSetup';
import type { CompletedSentence } from '../transcription/types';
import {
  createFinalMeetingSummaryRecord,
  FinalMeetingSummaryController,
  renderFinalMeetingSummary,
  type FinalMeetingSummaryState,
} from './finalMeetingSummary';

const createdAt = '2026-07-19T10:00:00.000Z';

function settings(finalSummaryEnabled = true) {
  return createMeetingSettingsSnapshot({
    ...createInitialMeetingSetupDraft('mock'),
    title: 'Test meeting',
    finalSummaryEnabled,
  }, '2026-07-19T09:00:00.000Z');
}

function sentence(id = 'sentence-1'): CompletedSentence {
  return {
    id,
    sessionId: 'session-1',
    rawSegmentIds: [`raw-${id}`],
    rawText: '確定済み発話',
    displayText: '確定済み発話。',
    revision: 1,
    language: 'ja',
    startTime: 0,
    endTime: 1,
    completionReason: 'punctuation',
  };
}

function summary(overrides: Partial<FinalMeetingSummary> = {}): FinalMeetingSummary {
  return {
    version: 1,
    overview: '会議の概要',
    agenda: [],
    keyPoints: [],
    decisions: [],
    unresolvedItems: [],
    actionItems: [{
      task: '確認事項を整理する',
      assignee: null,
      dueDate: null,
      evidenceSentenceIds: ['sentence-1'],
    }],
    nextChecks: [],
    ...overrides,
  };
}

describe('FinalMeetingSummaryController', () => {
  it('creates one final summary for an enabled snapshot and records TODO metadata', async () => {
    const states: FinalMeetingSummaryState[] = [];
    const finalize = vi.fn(async () => summary());
    const controller = new FinalMeetingSummaryController((state) => states.push(state), () => new Date(createdAt));

    const result = await controller.complete({
      meetingId: 'meeting-1', settings: settings(), sentences: [sentence()], provider: 'mock', finalize,
    });

    expect(finalize).toHaveBeenCalledOnce();
    expect(states.map((state) => state.status)).toEqual(['processing', 'succeeded']);
    expect(result).toMatchObject({
      status: 'succeeded',
      record: {
        meetingId: 'meeting-1',
        createdAt,
        provider: 'mock',
        todos: [{ content: '確認事項を整理する', assignee: null, dueDate: null, completed: false }],
      },
    });
  });

  it('does not call the provider or create an empty record when the snapshot disables final summary', async () => {
    const finalize = vi.fn(async () => summary());
    const controller = new FinalMeetingSummaryController();
    await controller.complete({
      meetingId: 'meeting-1', settings: settings(false), sentences: [sentence()], provider: 'mock', finalize,
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(controller.state).toEqual({ status: 'disabled' });
  });

  it('uses the fixed snapshot even if a later setup draft enables final summary', async () => {
    const snapshot = settings(false);
    const laterDraft = { ...createInitialMeetingSetupDraft('mock'), finalSummaryEnabled: true };
    const finalize = vi.fn(async () => summary());
    const controller = new FinalMeetingSummaryController();
    await controller.complete({
      meetingId: 'meeting-1', settings: snapshot, sentences: [sentence()], provider: 'mock', finalize,
    });
    expect(laterDraft.finalSummaryEnabled).toBe(true);
    expect(snapshot.finalSummaryEnabled).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('shares one in-flight result when the end action is invoked repeatedly', async () => {
    let resolve!: (value: FinalMeetingSummary) => void;
    const finalize = vi.fn(() => new Promise<FinalMeetingSummary>((done) => { resolve = done; }));
    const controller = new FinalMeetingSummaryController();
    const options = { meetingId: 'meeting-1', settings: settings(), sentences: [sentence()], provider: 'mock' as const, finalize };
    const first = controller.complete(options);
    const second = controller.complete(options);
    expect(finalize).toHaveBeenCalledOnce();
    resolve(summary());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await controller.complete(options);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('keeps a page-session result only in the current controller instance', async () => {
    const currentPage = new FinalMeetingSummaryController(undefined, () => new Date(createdAt));
    await currentPage.complete({
      meetingId: 'meeting-1', settings: settings(), sentences: [sentence()], provider: 'mock',
      finalize: async () => summary(),
    });
    expect(currentPage.state.status).toBe('succeeded');

    // A new application instance represents a reload. page-session does not
    // hydrate meeting history or write the final summary to a persistent store.
    const reloadedPage = new FinalMeetingSummaryController();
    expect(reloadedPage.state).toEqual({ status: 'idle' });
  });

  it('keeps transcript input intact and exposes a safe failed state after provider failure', async () => {
    const sentences = [sentence()];
    const before = structuredClone(sentences);
    const controller = new FinalMeetingSummaryController();
    await controller.complete({
      meetingId: 'meeting-1', settings: settings(), sentences, provider: 'mock',
      finalize: async () => { throw new Error('provider detail'); },
    });
    expect(sentences).toEqual(before);
    expect(controller.state).toEqual({ status: 'failed' });
  });

  it('retries a failed summary explicitly with the fixed snapshot and retained transcript', async () => {
    const snapshot = settings();
    const sentences = [sentence()];
    const controller = new FinalMeetingSummaryController(undefined, () => new Date(createdAt));
    await controller.complete({
      meetingId: 'meeting-1', settings: snapshot, sentences, provider: 'mock', finalize: async () => null,
    });
    const laterDraft = { ...createInitialMeetingSetupDraft('mock'), finalSummaryEnabled: false };
    const retryFinalize = vi.fn(async (received: readonly CompletedSentence[]) => {
      expect(received).toEqual(sentences);
      return summary();
    });

    expect(laterDraft.finalSummaryEnabled).toBe(false);
    expect(controller.retryAvailability({ meetingId: 'meeting-1', settings: snapshot, sentences }).available).toBe(true);
    await controller.retry({ meetingId: 'meeting-1', settings: snapshot, sentences, provider: 'mock', finalize: retryFinalize });

    expect(retryFinalize).toHaveBeenCalledOnce();
    expect(controller.state).toMatchObject({ status: 'succeeded', record: { meetingId: 'meeting-1' } });
  });

  it('does not retry without the original snapshot, an enabled setting, or a completed transcript', async () => {
    const controller = new FinalMeetingSummaryController();
    const initial = { meetingId: 'meeting-1', settings: settings(), sentences: [sentence()], provider: 'mock' as const };
    await controller.complete({ ...initial, finalize: async () => null });
    const finalize = vi.fn(async () => summary());

    await controller.retry({ ...initial, settings: null, finalize });
    await controller.retry({ ...initial, settings: settings(false), finalize });
    await controller.retry({ ...initial, sentences: [], finalize });

    expect(finalize).not.toHaveBeenCalled();
    expect(controller.state).toEqual({ status: 'failed' });
    expect(controller.retryAvailability({ ...initial, sentences: [] })).toMatchObject({
      available: false,
      message: expect.stringContaining('文字起こし'),
    });
  });

  it('does not treat a repeated completion call as an automatic retry', async () => {
    const controller = new FinalMeetingSummaryController();
    const initial = { meetingId: 'meeting-1', settings: settings(), sentences: [sentence()], provider: 'mock' as const };
    await controller.complete({ ...initial, finalize: async () => null });
    const finalize = vi.fn(async () => summary());

    await controller.complete({ ...initial, finalize });

    expect(finalize).not.toHaveBeenCalled();
    expect(controller.state).toEqual({ status: 'failed' });
  });

  it('shares one in-flight retry and exposes processing until it completes', async () => {
    const controller = new FinalMeetingSummaryController();
    const initial = { meetingId: 'meeting-1', settings: settings(), sentences: [sentence()], provider: 'mock' as const };
    await controller.complete({ ...initial, finalize: async () => null });
    let resolve!: (value: FinalMeetingSummary | null) => void;
    const finalize = vi.fn(() => new Promise<FinalMeetingSummary | null>((done) => { resolve = done; }));

    const first = controller.retry({ ...initial, finalize });
    const second = controller.retry({ ...initial, finalize });

    expect(controller.state).toEqual({ status: 'processing' });
    expect(finalize).toHaveBeenCalledOnce();
    resolve(summary());
    await Promise.all([first, second]);
    expect(controller.state.status).toBe('succeeded');
  });

  it('keeps the transcript and allows another explicit retry after retry failure', async () => {
    const sentences = [sentence()];
    const before = structuredClone(sentences);
    const controller = new FinalMeetingSummaryController();
    const initial = { meetingId: 'meeting-1', settings: settings(), sentences, provider: 'mock' as const };
    await controller.complete({ ...initial, finalize: async () => null });
    await controller.retry({ ...initial, finalize: async () => { throw new Error('private provider detail'); } });

    expect(sentences).toEqual(before);
    expect(controller.state).toEqual({ status: 'failed' });
    expect(controller.retryAvailability(initial).available).toBe(true);
  });

  it('ignores retry requests and delayed results for a different meeting', async () => {
    const controller = new FinalMeetingSummaryController();
    const meetingOne = { meetingId: 'meeting-1', settings: settings(), sentences: [sentence()], provider: 'mock' as const };
    await controller.complete({ ...meetingOne, finalize: async () => null });
    const wrongMeetingFinalize = vi.fn(async () => summary());
    await controller.retry({ ...meetingOne, meetingId: 'meeting-2', finalize: wrongMeetingFinalize });
    expect(wrongMeetingFinalize).not.toHaveBeenCalled();

    let resolveOld!: (value: FinalMeetingSummary | null) => void;
    const oldRetry = controller.retry({
      ...meetingOne,
      finalize: () => new Promise<FinalMeetingSummary | null>((done) => { resolveOld = done; }),
    });
    controller.reset();
    await controller.complete({
      meetingId: 'meeting-2', settings: settings(), sentences: [sentence('sentence-2')], provider: 'mock',
      finalize: async () => summary({ overview: '新しい会議の概要' }),
    });
    resolveOld(summary({ overview: '古い会議の概要' }));
    await oldRetry;

    expect(controller.state).toMatchObject({
      status: 'succeeded',
      record: { meetingId: 'meeting-2', summary: { overview: '新しい会議の概要' } },
    });
  });

  it('ignores a delayed result after the meeting data is reset', async () => {
    let resolve!: (value: FinalMeetingSummary) => void;
    const controller = new FinalMeetingSummaryController();
    const completion = controller.complete({
      meetingId: 'meeting-1', settings: settings(), sentences: [sentence()], provider: 'mock',
      finalize: () => new Promise<FinalMeetingSummary>((done) => { resolve = done; }),
    });
    controller.reset();
    resolve(summary());
    await completion;
    expect(controller.state).toEqual({ status: 'idle' });
  });

  it('handles an absent legacy snapshot without calling the provider', async () => {
    const finalize = vi.fn(async () => summary());
    const controller = new FinalMeetingSummaryController();
    await expect(controller.complete({
      meetingId: 'legacy-meeting', settings: null, sentences: [], provider: null, finalize,
    })).resolves.toEqual({ status: 'disabled' });
    expect(finalize).not.toHaveBeenCalled();
  });
});

describe('final meeting summary presentation', () => {
  let status: HTMLElement;
  let content: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<p id="status"></p><section id="content"></section>';
    status = document.querySelector('#status') as HTMLElement;
    content = document.querySelector('#content') as HTMLElement;
  });

  it('renders a saved summary and TODO as readonly content with unknown values left unspecified', () => {
    const record = createFinalMeetingSummaryRecord('meeting-1', summary(), createdAt, 'mock');
    renderFinalMeetingSummary(status, content, { status: 'succeeded', record });
    expect(status.textContent).toContain('作成しました');
    expect(content.textContent).toContain('会議の概要');
    expect(content.textContent).toContain('確認事項を整理する');
    expect(content.textContent).toContain('担当者未指定');
    expect(content.textContent).toContain('期限未指定');
    expect(content.textContent).toContain('Mock要約（外部送信なし）');
    expect(content.querySelector('input, select, textarea, button')).toBeNull();
  });

  it('shows an enabled retry button only for an eligible failed meeting', () => {
    const onRetry = vi.fn();
    renderFinalMeetingSummary(status, content, { status: 'failed' }, {
      retryAvailability: { available: true, message: '文字起こしを保持したまま再試行できます。' },
      onRetry,
    });
    const button = content.querySelector<HTMLButtonElement>('button');
    expect(status.textContent).toContain('文字起こしは保持されています');
    expect(content.textContent).toContain('再試行できます');
    expect(button?.disabled).toBe(false);
    button?.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('disables retry when required meeting information is unavailable', () => {
    renderFinalMeetingSummary(status, content, { status: 'failed' }, {
      retryAvailability: { available: false, message: '確定済みの文字起こしがないため再試行できません。' },
      onRetry: vi.fn(),
    });
    expect(content.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    expect(content.textContent).toContain('再試行できません');
  });

  it('shows processing text and a disabled retry control while retry is running', () => {
    renderFinalMeetingSummary(status, content, { status: 'processing' }, { retryInProgress: true });
    const button = content.querySelector<HTMLButtonElement>('button');
    expect(status.textContent).toContain('作成しています');
    expect(button?.textContent).toBe('再試行中');
    expect(button?.disabled).toBe(true);
  });

  it('does not show a retry control during the initial final-summary request', () => {
    renderFinalMeetingSummary(status, content, { status: 'processing' });
    expect(status.textContent).toContain('作成しています');
    expect(content.querySelector('button')).toBeNull();
    expect(content.hidden).toBe(true);
  });

  it('replaces the failed retry UI with readonly summary content after retry succeeds', async () => {
    const snapshot = settings();
    const sentences = [sentence()];
    const controller = new FinalMeetingSummaryController((state) => {
      renderFinalMeetingSummary(status, content, state, {
        retryAvailability: controller.retryAvailability({ meetingId: 'meeting-1', settings: snapshot, sentences }),
        onRetry: vi.fn(),
      });
    }, () => new Date(createdAt));
    await controller.complete({
      meetingId: 'meeting-1', settings: snapshot, sentences, provider: 'mock', finalize: async () => null,
    });
    expect(content.querySelector('button')).not.toBeNull();

    await controller.retry({
      meetingId: 'meeting-1', settings: snapshot, sentences, provider: 'mock', finalize: async () => summary(),
    });

    expect(status.textContent).toContain('作成しました');
    expect(content.textContent).toContain('会議の概要');
    expect(content.querySelector('button')).toBeNull();
  });

  it('re-enables the retry button after an explicit retry fails again', async () => {
    const snapshot = settings();
    const sentences = [sentence()];
    const controller = new FinalMeetingSummaryController((state) => {
      renderFinalMeetingSummary(status, content, state, {
        retryAvailability: controller.retryAvailability({ meetingId: 'meeting-1', settings: snapshot, sentences }),
        retryInProgress: controller.retryInProgress,
        onRetry: vi.fn(),
      });
    });
    const request = { meetingId: 'meeting-1', settings: snapshot, sentences, provider: 'mock' as const };
    await controller.complete({ ...request, finalize: async () => null });
    await controller.retry({ ...request, finalize: async () => { throw new Error('private provider detail'); } });

    expect(controller.state).toEqual({ status: 'failed' });
    expect(content.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    expect(content.textContent).toContain('再試行できます');
  });

  it('shows an explicit empty state when no TODO was detected', () => {
    const record = createFinalMeetingSummaryRecord('meeting-1', summary({ actionItems: [] }), createdAt, 'mock');
    renderFinalMeetingSummary(status, content, { status: 'succeeded', record });
    expect(content.textContent).toContain('TODOは検出されませんでした');
  });

  it('preserves and displays an explicitly supplied assignee and due date', () => {
    const record = createFinalMeetingSummaryRecord('meeting-1', summary({
      actionItems: [{
        task: '資料を確認する', assignee: '担当A', dueDate: '2026-07-31', evidenceSentenceIds: ['sentence-1'],
      }],
    }), createdAt, 'mock');
    renderFinalMeetingSummary(status, content, { status: 'succeeded', record });
    expect(record.todos[0]).toMatchObject({ assignee: '担当A', dueDate: '2026-07-31', completed: false });
    expect(content.textContent).toContain('担当A');
    expect(content.textContent).toContain('2026-07-31');
  });

  it('renders provider and user text with textContent instead of executing HTML', () => {
    const record = createFinalMeetingSummaryRecord('meeting-1', summary({
      overview: '<img src=x onerror=alert(1)>',
      actionItems: [{ task: '<script>alert(1)</script>', assignee: null, dueDate: null, evidenceSentenceIds: ['sentence-1'] }],
    }), createdAt, 'mock');
    renderFinalMeetingSummary(status, content, { status: 'succeeded', record });
    expect(content.querySelector('img, script')).toBeNull();
    expect(content.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(content.textContent).toContain('<script>alert(1)</script>');
  });

  it('can render a retained record again after the detail view is recreated', () => {
    const record = createFinalMeetingSummaryRecord('meeting-1', summary(), createdAt, 'mock');
    renderFinalMeetingSummary(status, content, { status: 'succeeded', record });
    const nextStatus = document.createElement('p');
    const nextContent = document.createElement('section');
    renderFinalMeetingSummary(nextStatus, nextContent, { status: 'succeeded', record });
    expect(nextContent.textContent).toContain('会議の概要');
    expect(nextContent.textContent).toContain('確認事項を整理する');
  });

  it.each([
    [{ status: 'disabled' } as const, '最終要約が無効'],
    [{ status: 'idle' } as const, '会議終了後'],
  ])('renders the %s state without throwing', (state, expected) => {
    expect(() => renderFinalMeetingSummary(status, content, state)).not.toThrow();
    expect(status.textContent).toContain(expected);
    expect(content.hidden).toBe(true);
  });
});
