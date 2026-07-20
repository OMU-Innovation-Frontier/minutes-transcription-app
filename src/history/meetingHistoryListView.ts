import type { MeetingHistoryListState } from './meetingHistoryListController';
import type { MeetingRecord } from './meetingRecord';

export interface CurrentPageMeetingHistoryItem {
  meetingId: string;
  title: string;
  occurredAt: string;
  utteranceCount: number;
  hasFinalSummary: boolean;
  openDetail: () => void;
}

export interface MeetingHistoryListElements {
  list: HTMLOListElement;
  empty: HTMLElement;
  status: HTMLElement;
  statusMessage: HTMLElement;
  retryButton: HTMLButtonElement;
}

interface MeetingHistoryDisplayItem {
  meetingId: string;
  title: string;
  occurredAt: string;
  utteranceCount: number;
  hasFinalSummary: boolean;
  persisted: boolean;
  openDetail?: () => void;
}

export function renderMeetingHistoryList(
  elements: MeetingHistoryListElements,
  state: MeetingHistoryListState,
  currentMeeting: CurrentPageMeetingHistoryItem | null,
  formatDate: (isoDate: string) => string = formatHistoryDate,
  onOpenPersisted?: (meetingId: string) => void,
): void {
  if (state.status === 'disposed') return;
  const items = mergeMeetingHistory(state.records, currentMeeting, onOpenPersisted);
  elements.list.replaceChildren(...items.map((item) => renderHistoryItem(item, formatDate)));
  elements.list.hidden = items.length === 0;
  elements.empty.hidden = true;
  elements.status.hidden = true;
  elements.retryButton.hidden = true;
  elements.retryButton.disabled = state.status === 'loading';

  switch (state.status) {
    case 'idle':
      showStatus(elements, '会議履歴を読み込んでいます。');
      return;
    case 'loading':
      showStatus(elements, state.phase === 'initial'
        ? '会議履歴を読み込んでいます。'
        : '会議履歴を更新しています。');
      return;
    case 'unavailable':
      showStatus(elements, 'このブラウザーでは端末内の会議履歴を利用できません。');
      return;
    case 'failed':
      showStatus(elements, state.phase === 'initial'
        ? '保存された会議履歴を読み込めませんでした。'
        : '会議履歴を更新できませんでした。前回読み込んだ内容を表示しています。');
      elements.retryButton.hidden = false;
      return;
    case 'empty':
    case 'ready':
      if (items.length === 0) elements.empty.hidden = false;
      return;
  }
}

export function mergeMeetingHistory(
  records: readonly MeetingRecord[],
  currentMeeting: CurrentPageMeetingHistoryItem | null,
  onOpenPersisted?: (meetingId: string) => void,
): readonly MeetingHistoryDisplayItem[] {
  const persisted = records.map((record) => {
    const item = toDisplayItem(record);
    const meetingId = item.meetingId;
    return {
      ...item,
      openDetail: onOpenPersisted ? () => onOpenPersisted(meetingId) : undefined,
    };
  });
  if (!currentMeeting) return persisted;
  const currentIndex = persisted.findIndex(({ meetingId }) => meetingId === currentMeeting.meetingId);
  if (currentIndex >= 0) {
    return persisted.map((item, index) => index === currentIndex
      ? { ...item, openDetail: currentMeeting.openDetail }
      : item);
  }
  return [{ ...currentMeeting, persisted: false, openDetail: currentMeeting.openDetail }, ...persisted];
}

function toDisplayItem(record: MeetingRecord): MeetingHistoryDisplayItem {
  const title = record.title?.trim() || record.settingsSnapshot.title.trim() || '無題の会議';
  return {
    meetingId: record.meetingId,
    title,
    occurredAt: record.endedAt ?? record.startedAt ?? record.createdAt,
    utteranceCount: record.transcript.utterances.length,
    hasFinalSummary: record.finalSummary !== null,
    persisted: true,
  };
}

function renderHistoryItem(
  item: MeetingHistoryDisplayItem,
  formatDate: (isoDate: string) => string,
): HTMLLIElement {
  const listItem = document.createElement('li');
  listItem.className = 'history-entry';
  const surface = item.openDetail ? document.createElement('button') : document.createElement('article');
  surface.className = 'history-entry__surface';
  const openDetail = item.openDetail;
  if (surface instanceof HTMLButtonElement && openDetail) {
    surface.type = 'button';
    surface.setAttribute('aria-label', `「${item.title}」の詳細を開く（${formatDate(item.occurredAt)}）`);
    surface.addEventListener('click', openDetail);
  }

  const title = document.createElement('strong');
  title.textContent = item.title;
  const date = document.createElement('time');
  date.dateTime = item.occurredAt;
  date.textContent = formatDate(item.occurredAt);
  const utterances = document.createElement('span');
  utterances.textContent = `発話 ${item.utteranceCount}件`;
  const summary = document.createElement('span');
  summary.textContent = item.hasFinalSummary ? '最終要約あり' : '文字起こしのみ';
  const storage = document.createElement('span');
  storage.textContent = item.persisted ? 'この端末に保存済み' : 'このページ内で保持中';
  surface.append(title, date, utterances, summary, storage);
  listItem.append(surface);
  return listItem;
}

function showStatus(elements: MeetingHistoryListElements, message: string): void {
  elements.statusMessage.textContent = message;
  elements.status.hidden = false;
}

function formatHistoryDate(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
