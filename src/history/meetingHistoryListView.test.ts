// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { FinalMeetingSummaryRecord } from '../summary/finalMeetingSummary';
import type { CompletedSentence } from '../transcription/types';
import type { MeetingHistoryListState } from './meetingHistoryListController';
import {
  mergeMeetingHistory,
  renderMeetingHistoryList,
  type CurrentPageMeetingHistoryItem,
  type MeetingHistoryListElements,
} from './meetingHistoryListView';
import { createMeetingRecord, type MeetingRecord } from './meetingRecord';

describe('meeting history list view', () => {
  let elements: MeetingHistoryListElements;

  beforeEach(() => {
    document.body.replaceChildren();
    const list = document.createElement('ol');
    const empty = document.createElement('div');
    const status = document.createElement('div');
    const statusMessage = document.createElement('p');
    const retryButton = document.createElement('button');
    status.append(statusMessage, retryButton);
    document.body.append(list, empty, status);
    elements = { list, empty, status, statusMessage, retryButton };
  });

  it('renders persisted metadata in repository order without exposing transcript, TODO, IDs, or schema', () => {
    const records = [
      recordFixture('meeting-2', { title: '新しい会議', utteranceCount: 2, withSummary: true }),
      recordFixture('meeting-1', { title: '古い会議' }),
    ];

    renderMeetingHistoryList(elements, ready(records), null, (value) => `日時:${value}`);

    const entries = [...elements.list.children];
    expect(entries[0]?.textContent).toContain('新しい会議');
    expect(entries[0]?.textContent).toContain('発話 2件');
    expect(entries[0]?.textContent).toContain('最終要約あり');
    expect(entries[0]?.textContent).toContain('この端末に保存済み');
    expect(entries[1]?.textContent).toContain('古い会議');
    expect(entries[1]?.textContent).toContain('文字起こしのみ');
    expect(elements.list.textContent).not.toContain('保存対象の本文');
    expect(elements.list.textContent).not.toContain('非公開TODO');
    expect(elements.list.textContent).not.toContain('meeting-2');
    expect(elements.list.textContent).not.toContain('schemaVersion');
  });

  it('uses the snapshot title when the record display title is null', () => {
    renderMeetingHistoryList(elements, ready([recordFixture('meeting-1', { title: null })]), null);
    expect(elements.list.textContent).toContain('作成時のタイトル');
  });

  it('uses endedAt, then startedAt, then createdAt for the displayed meeting date', () => {
    const records = [
      recordFixture('ended'),
      recordFixture('started', { endedAt: null }),
      recordFixture('created', { endedAt: null, startedAt: null }),
    ];
    renderMeetingHistoryList(elements, ready(records), null, (value) => value);

    expect([...elements.list.querySelectorAll('time')].map(({ dateTime }) => dateTime)).toEqual([
      '2026-07-20T01:30:00.000Z',
      '2026-07-20T01:05:00.000Z',
      '2026-07-20T01:00:00.000Z',
    ]);
  });

  it('renders HTML-like titles as text instead of markup', () => {
    renderMeetingHistoryList(elements, ready([recordFixture('meeting-1', { title: '<img src=x onerror=alert(1)>' })]), null);
    expect(elements.list.querySelector('img')).toBeNull();
    expect(elements.list.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('opens persisted records by ID while keeping the current page meeting on its current-detail callback', () => {
    const openDetail = vi.fn();
    const openPersisted = vi.fn();
    const records = [recordFixture('meeting-current'), recordFixture('meeting-past')];
    renderMeetingHistoryList(elements, ready(records), currentFixture('meeting-current', openDetail), undefined, openPersisted);

    expect(elements.list.children).toHaveLength(2);
    const buttons = [...elements.list.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain('会議 meeting-current');
    expect(buttons[1]?.getAttribute('aria-label')).toContain('「会議 meeting-past」の詳細を開く（');
    expect(buttons[1]?.getAttribute('aria-label')).toContain('2026');
    buttons[0]?.click();
    buttons[1]?.click();
    expect(openDetail).toHaveBeenCalledTimes(1);
    expect(openPersisted).toHaveBeenCalledTimes(1);
    expect(openPersisted).toHaveBeenCalledWith('meeting-past');
  });

  it('does not retain a whole persisted record in the click callback contract', () => {
    const openPersisted = vi.fn();
    renderMeetingHistoryList(
      elements,
      ready([recordFixture('meeting-past')]),
      null,
      () => '表示日時',
      openPersisted,
    );
    elements.list.querySelector<HTMLButtonElement>('button')?.click();
    expect(openPersisted).toHaveBeenCalledWith('meeting-past');
    expect(openPersisted.mock.calls[0]).toHaveLength(1);
  });

  it('keeps persisted records static when no detail callback is supplied', () => {
    renderMeetingHistoryList(elements, ready([recordFixture('meeting-past')]), null);
    expect(elements.list.querySelector('button')).toBeNull();
    expect(elements.list.querySelector('article')).not.toBeNull();
  });

  it('prepends an unsaved current page meeting and removes it when the same persisted ID appears', () => {
    const current = currentFixture('meeting-current');
    expect(mergeMeetingHistory([recordFixture('meeting-past')], current).map(({ meetingId }) => meetingId))
      .toEqual(['meeting-current', 'meeting-past']);
    expect(mergeMeetingHistory([recordFixture('meeting-current'), recordFixture('meeting-past')], current).map(({ meetingId }) => meetingId))
      .toEqual(['meeting-current', 'meeting-past']);

    renderMeetingHistoryList(elements, ready([]), current);
    expect(elements.list.textContent).toContain('このページ内で保持中');
    expect(elements.empty.hidden).toBe(true);
  });

  it('shows loading without flashing the empty state', () => {
    renderMeetingHistoryList(elements, { status: 'loading', phase: 'initial', records: [] }, null);
    expect(elements.statusMessage.textContent).toContain('読み込んでいます');
    expect(elements.empty.hidden).toBe(true);
  });

  it('shows empty only after a successful empty load with no current meeting', () => {
    renderMeetingHistoryList(elements, { status: 'empty', records: [] }, null);
    expect(elements.empty.hidden).toBe(false);

    renderMeetingHistoryList(elements, { status: 'empty', records: [] }, currentFixture());
    expect(elements.empty.hidden).toBe(true);
  });

  it('shows safe unavailable and failed states, retaining prior records during refresh failure', () => {
    renderMeetingHistoryList(elements, { status: 'unavailable', records: [] }, currentFixture());
    expect(elements.statusMessage.textContent).toContain('利用できません');
    expect(elements.list.hidden).toBe(false);
    expect(elements.retryButton.hidden).toBe(true);

    renderMeetingHistoryList(elements, {
      status: 'failed',
      phase: 'refresh',
      records: [recordFixture()],
    }, null);
    expect(elements.statusMessage.textContent).toContain('前回読み込んだ内容');
    expect(elements.list.children).toHaveLength(1);
    expect(elements.retryButton.hidden).toBe(false);
  });

  it('shows a safe initial failure and an enabled retry action', () => {
    renderMeetingHistoryList(elements, { status: 'failed', phase: 'initial', records: [] }, null);
    expect(elements.statusMessage.textContent).toBe('保存された会議履歴を読み込めませんでした。');
    expect(elements.retryButton.hidden).toBe(false);
    expect(elements.retryButton.disabled).toBe(false);
    expect(elements.status.textContent).not.toContain('IndexedDB');
  });
});

function ready(records: MeetingRecord[]): MeetingHistoryListState {
  return { status: 'ready', records };
}

function currentFixture(meetingId = 'meeting-current', openDetail = vi.fn()): CurrentPageMeetingHistoryItem {
  return {
    meetingId,
    title: `会議 ${meetingId}`,
    occurredAt: '2026-07-20T02:00:00.000Z',
    utteranceCount: 1,
    hasFinalSummary: false,
    openDetail,
  };
}

function recordFixture(
  meetingId = 'meeting-1',
  options: {
    title?: string | null;
    utteranceCount?: number;
    withSummary?: boolean;
    startedAt?: string | null;
    endedAt?: string | null;
  } = {},
): MeetingRecord {
  const settings = createMeetingSettingsSnapshot({
    title: '作成時のタイトル',
    language: 'ja-JP',
    transcriptionProvider: 'mock',
    correctionEnabled: false,
    liveSummaryEnabled: false,
    finalSummaryEnabled: options.withSummary ?? false,
    historyRetention: 'page-session',
    externalProcessingAcknowledged: false,
  }, '2026-07-20T01:00:00.000Z');
  const sentences = Array.from({ length: options.utteranceCount ?? 0 }, (_, index) => sentenceFixture(index));
  return createMeetingRecord({
    meetingId,
    createdAt: settings.createdAt,
    startedAt: options.startedAt === undefined ? '2026-07-20T01:05:00.000Z' : options.startedAt,
    endedAt: options.endedAt === undefined ? '2026-07-20T01:30:00.000Z' : options.endedAt,
    updatedAt: '2026-07-20T01:30:00.000Z',
    title: options.title === undefined ? `会議 ${meetingId}` : options.title,
    settingsSnapshot: settings,
    sentences,
    finalSummary: options.withSummary ? summaryFixture(meetingId) : null,
    summaryApiUsed: false,
  });
}

function sentenceFixture(index: number): CompletedSentence {
  return {
    id: `sentence-${index}`,
    sessionId: 'session-1',
    rawSegmentIds: [`segment-${index}`],
    rawText: '保存対象の本文',
    revision: 1,
    displayText: '保存対象の本文',
    language: 'ja',
    startTime: index * 100,
    endTime: index * 100 + 50,
    completionReason: 'recording_stopped',
  };
}

function summaryFixture(meetingId: string): FinalMeetingSummaryRecord {
  return {
    meetingId,
    summary: {
      version: 1,
      overview: '要約本文',
      agenda: [],
      keyPoints: [],
      decisions: [],
      unresolvedItems: [],
      actionItems: [],
      nextChecks: [],
    },
    todos: [{ content: '非公開TODO', assignee: null, dueDate: null, completed: false }],
    createdAt: '2026-07-20T01:31:00.000Z',
    provider: 'mock',
  };
}
