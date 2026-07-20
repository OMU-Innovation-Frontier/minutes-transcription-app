// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { FinalMeetingSummaryRecord } from '../summary/finalMeetingSummary';
import type { CompletedSentence } from '../transcription/types';
import type { MeetingHistoryDetailState } from './meetingHistoryDetailController';
import { renderPersistedMeetingHistoryDetail, type MeetingHistoryDetailElements } from './meetingHistoryDetailView';
import { createMeetingRecord, type MeetingRecord } from './meetingRecord';

describe('persisted meeting history detail view', () => {
  let elements: MeetingHistoryDetailElements;

  beforeEach(() => {
    document.body.replaceChildren();
    elements = createElements();
  });

  it('renders title, date, duration, transcript, summary, and TODO from the record', () => {
    const record = recordFixture({ withSummary: true });
    renderPersistedMeetingHistoryDetail(elements, ready(record), () => '2026年7月20日 10:30', () => '12分34秒');

    expect(elements.title.textContent).toBe('終了時タイトル');
    expect(elements.date.textContent).toBe('2026年7月20日 10:30 ・ 12分34秒');
    expect(elements.transcript.textContent).toContain('整文後の発話');
    expect(elements.summaryContent.textContent).toContain('保存済み概要');
    expect(elements.summaryContent.textContent).toContain('議題');
    expect(elements.summaryContent.textContent).toContain('確認事項を共有する');
    expect(elements.summaryContent.textContent).toContain('要点');
    expect(elements.summaryContent.textContent).toContain('重要な点');
    expect(elements.summaryContent.textContent).toContain('決定事項');
    expect(elements.summaryContent.textContent).toContain('決定した内容');
    expect(elements.summaryContent.textContent).toContain('未解決事項');
    expect(elements.summaryContent.textContent).toContain('継続確認する内容');
    expect(elements.summaryContent.textContent).toContain('次回確認事項');
    expect(elements.summaryContent.textContent).toContain('次回に確認する');
    expect(elements.summaryContent.textContent).toContain('確認する');
    expect(elements.summaryContent.textContent).toContain('担当者未指定');
    expect(elements.summaryContent.textContent).toContain('2026-07-21');
    expect(elements.summaryContent.textContent).toContain('完了');
    expect(elements.summaryContent.textContent).toContain('未指定');
    expect(elements.summaryContent.textContent).toContain('未完了');
    expect(elements.persistenceNote.textContent).toContain('端末のブラウザー内に保存');
  });

  it('falls back to the snapshot title and does not invent a recording start time', () => {
    const record = recordFixture({ title: null, startedAt: null });
    renderPersistedMeetingHistoryDetail(elements, ready(record), (value) => value, () => '不正なduration');
    expect(elements.title.textContent).toBe('作成時タイトル');
    expect(elements.date.textContent).toBe(record.endedAt);
    expect(elements.date.textContent).not.toContain('不正なduration');
  });

  it('does not show a negative duration', () => {
    const record = recordFixture({
      startedAt: '2026-07-20T01:40:00.000Z',
      endedAt: '2026-07-20T01:30:00.000Z',
    });
    renderPersistedMeetingHistoryDetail(elements, ready(record), (value) => value, () => '負の時間');
    expect(elements.date.textContent).toBe(record.endedAt);
    expect(elements.date.textContent).not.toContain('負の時間');
  });

  it('sorts a copy by sequence and prefers correctedText without mutating the record', () => {
    const record = recordFixture();
    record.transcript.utterances.reverse();
    const originalOrder = record.transcript.utterances.map(({ sequence }) => sequence);
    renderPersistedMeetingHistoryDetail(elements, ready(record));

    expect([...elements.transcript.querySelectorAll('.utterance__text')].map(({ textContent }) => textContent))
      .toEqual(['原文のみの発話', '整文後の発話']);
    expect(record.transcript.utterances.map(({ sequence }) => sequence)).toEqual(originalOrder);
    expect(elements.transcript.textContent).not.toContain('sentence-');
    expect(elements.transcript.textContent).not.toContain('segment-');
    expect(elements.transcript.textContent).not.toContain('revision');
    expect(elements.transcript.querySelector('input, textarea, [contenteditable]')).toBeNull();
    const toggle = elements.transcript.querySelector<HTMLButtonElement>('.persisted-utterance__original-toggle');
    const original = elements.transcript.querySelector<HTMLElement>('.persisted-utterance__original');
    expect(toggle?.type).toBe('button');
    expect(toggle?.textContent).toBe('原文を見る');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-controls')).toBe(original?.id);
    expect(original?.hidden).toBe(true);
    toggle?.click();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(original?.hidden).toBe(false);
  });

  it('uses unique generated IDs for multiple original-text controls', () => {
    const record = recordFixture({ twoCorrections: true });
    renderPersistedMeetingHistoryDetail(elements, ready(record));
    const controls = [...elements.transcript.querySelectorAll<HTMLButtonElement>('[aria-controls]')];
    const ids = controls.map((control) => control.getAttribute('aria-controls'));
    expect(controls).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id?.startsWith('persisted-utterance-original-'))).toBe(true);
  });

  it('shows saved empty states without starting runtime actions', () => {
    const record = recordFixture({ utterances: false, withSummary: false });
    renderPersistedMeetingHistoryDetail(elements, ready(record));
    expect(elements.transcriptEmpty.textContent).toBe('保存された文字起こしはありません。');
    expect(elements.transcriptEmpty.hidden).toBe(false);
    expect(elements.summaryStatus.textContent).toBe('この会議には保存済みの最終要約がありません。');
    expect(elements.summarySection.querySelector('button, input, select, textarea')).toBeNull();
  });

  it('shows a TODO empty state and does not expose provider or apiUsed metadata', () => {
    const record = recordFixture({ withSummary: true, emptyTodos: true });
    renderPersistedMeetingHistoryDetail(elements, ready(record));
    expect(elements.summaryContent.textContent).toContain('TODOは保存されていません。');
    expect(elements.summaryContent.textContent).not.toContain('mock');
    expect(elements.summaryContent.textContent).not.toContain('apiUsed');
  });

  it('renders HTML-like stored fields strictly as text', () => {
    const record = recordFixture({
      title: '<img src=x onerror=alert(1)>',
      unsafeText: `<script data-value="'&">発話</script>`,
      withSummary: true,
      unsafeTodo: true,
    });
    renderPersistedMeetingHistoryDetail(elements, ready(record));

    expect(document.querySelector('img, script')).toBeNull();
    expect(elements.title.textContent).toContain('<img');
    expect(elements.transcript.textContent).toContain(`<script data-value="'&">発話</script>`);
    expect(elements.summaryContent.textContent).toContain('<b>TODO</b>');
    expect(elements.summaryContent.textContent).toContain('<i>担当者</i>');
    expect(elements.summaryContent.textContent).toContain('<time>期限</time>');
  });

  it('clears previous content for loading, failure, unavailable, and not-found states', () => {
    renderPersistedMeetingHistoryDetail(elements, ready(recordFixture({ withSummary: true })));
    renderPersistedMeetingHistoryDetail(elements, { status: 'loading', meetingId: 'meeting-1' });
    expect(elements.title.textContent).toBe('会議履歴');
    expect(elements.transcript.childElementCount).toBe(0);
    expect(elements.summaryContent.childElementCount).toBe(0);
    expect(elements.summarySection.getAttribute('aria-hidden')).toBe('true');
    expect(elements.transcriptSection.getAttribute('aria-hidden')).toBe('true');
    expect(elements.historyStatus.getAttribute('aria-hidden')).toBe('false');
    expect(elements.historyStatusMessage.textContent).toContain('読み込んでいます');
    expect(elements.historyRetryButton.hidden).toBe(true);

    renderPersistedMeetingHistoryDetail(elements, { status: 'failed', meetingId: 'meeting-1' });
    expect(elements.historyStatusMessage.textContent).toBe('保存された会議の詳細を読み込めませんでした。');
    expect(elements.historyRetryButton.hidden).toBe(false);
    expect(elements.historyRetryButton.getAttribute('aria-hidden')).toBe('false');
    expect(elements.historyStatus.textContent).not.toContain('IndexedDB');

    renderPersistedMeetingHistoryDetail(elements, { status: 'not_found', meetingId: 'missing' });
    expect(elements.historyStatusMessage.textContent).toBe('保存済みの会議が見つかりませんでした。');
    expect(elements.historyRetryButton.hidden).toBe(true);

    renderPersistedMeetingHistoryDetail(elements, { status: 'unavailable' });
    expect(elements.historyStatusMessage.textContent).toContain('利用できません');
    expect(elements.historyRetryButton.hidden).toBe(true);
  });
});

function createElements(): MeetingHistoryDetailElements {
  const title = document.createElement('h1');
  const date = document.createElement('p');
  const historyStatus = document.createElement('div');
  const historyStatusMessage = document.createElement('p');
  const historyRetryButton = document.createElement('button');
  historyStatus.append(historyStatusMessage, historyRetryButton);
  const summarySection = document.createElement('section');
  const summaryTitle = document.createElement('h2');
  const summaryStatus = document.createElement('p');
  const summaryContent = document.createElement('div');
  summarySection.append(summaryTitle, summaryStatus, summaryContent);
  const transcriptSection = document.createElement('section');
  const transcript = document.createElement('ol');
  const transcriptEmpty = document.createElement('p');
  transcriptSection.append(transcriptEmpty, transcript);
  const persistenceNote = document.createElement('p');
  document.body.append(title, date, historyStatus, summarySection, transcriptSection, persistenceNote);
  return {
    title, date, historyStatus, historyStatusMessage, historyRetryButton, summarySection, summaryTitle,
    summaryStatus, summaryContent, transcriptSection, transcript, transcriptEmpty, persistenceNote,
  };
}

function ready(record: MeetingRecord): MeetingHistoryDetailState {
  return { status: 'ready', record };
}

function recordFixture(options: {
  title?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  utterances?: boolean;
  withSummary?: boolean;
  emptyTodos?: boolean;
  unsafeText?: string;
  unsafeTodo?: boolean;
  twoCorrections?: boolean;
} = {}): MeetingRecord {
  const settings = createMeetingSettingsSnapshot({
    title: '作成時タイトル', language: 'ja-JP', transcriptionProvider: 'mock', correctionEnabled: true,
    liveSummaryEnabled: false, finalSummaryEnabled: options.withSummary ?? false, historyRetention: 'page-session',
    externalProcessingAcknowledged: false,
  }, '2026-07-20T01:00:00.000Z');
  const sentences = options.utterances === false ? [] : [
    sentence('sentence-0', options.unsafeText ?? '原文のみの発話', options.twoCorrections ? '追加の整文後発話' : null),
    sentence('sentence-1', '整文前の発話', '整文後の発話'),
  ];
  return createMeetingRecord({
    meetingId: 'meeting-1', createdAt: settings.createdAt,
    startedAt: options.startedAt === undefined ? '2026-07-20T01:05:00.000Z' : options.startedAt,
    endedAt: options.endedAt === undefined ? '2026-07-20T01:30:00.000Z' : options.endedAt,
    updatedAt: '2026-07-20T01:31:00.000Z',
    title: options.title === undefined ? '終了時タイトル' : options.title, settingsSnapshot: settings, sentences,
    finalSummary: options.withSummary ? summaryFixture(options.emptyTodos ?? false, options.unsafeTodo ?? false) : null,
    summaryApiUsed: true,
  });
}

function sentence(id: string, rawText: string, correctedText: string | null): CompletedSentence {
  return {
    id, sessionId: 'session', rawSegmentIds: [`segment-${id}`], rawText, revision: 1,
    displayText: correctedText ?? rawText, language: 'ja', startTime: 0, endTime: 100,
    completionReason: 'recording_stopped',
    correction: correctedText ? {
      status: 'completed', rawText, correctedText, changes: [], uncertainParts: [],
      sourceSegmentIds: [`segment-${id}`], attemptCount: 1,
    } : undefined,
  };
}

function summaryFixture(emptyTodos: boolean, unsafeTodo: boolean): FinalMeetingSummaryRecord {
  return {
    meetingId: 'meeting-1', createdAt: '2026-07-20T01:31:00.000Z', provider: 'mock',
    summary: {
      version: 1, overview: '保存済み概要',
      agenda: [{ text: '確認事項を共有する', evidenceSentenceIds: ['sentence-0'] }],
      keyPoints: [{ text: '重要な点', evidenceSentenceIds: ['sentence-0'] }],
      decisions: [{ text: '決定した内容', evidenceSentenceIds: ['sentence-1'] }],
      unresolvedItems: [{ text: '継続確認する内容', evidenceSentenceIds: ['sentence-1'] }],
      actionItems: [],
      nextChecks: [{ text: '次回に確認する', evidenceSentenceIds: ['sentence-1'] }],
    },
    todos: emptyTodos ? [] : [{
      content: unsafeTodo ? '<b>TODO</b>' : '確認する',
      assignee: unsafeTodo ? '<i>担当者</i>' : '担当者未指定',
      dueDate: unsafeTodo ? '<time>期限</time>' : '2026-07-21',
      completed: true,
    }, {
      content: '担当未定の項目', assignee: null, dueDate: null, completed: false,
    }],
  };
}
