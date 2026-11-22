import type { MeetingHistoryListState } from './meetingHistoryListController';
import type { MeetingRecord } from './meetingRecord';

export interface CurrentPageMeetingHistoryItem {
  meetingId: string;
  title: string;
  occurredAt: string;
  utteranceCount: number;
  hasFinalSummary: boolean;
  openDetail: () => void;
  searchableText?: readonly string[];
}

export interface MeetingHistoryListElements {
  list: HTMLOListElement;
  empty: HTMLElement;
  status: HTMLElement;
  statusMessage: HTMLElement;
  retryButton: HTMLButtonElement;
  searchEmpty?: HTMLElement;
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

export interface MeetingHistoryActions {
  onDelete: (meetingId: string, title: string, button: HTMLButtonElement) => void;
  onRename?: (meetingId: string, title: string) => void;
  onPdf?: (meetingId: string) => void;
  onShare?: (meetingId: string) => void;
  disabled: (meetingId: string) => boolean;
}

export function renderMeetingHistoryList(
  elements: MeetingHistoryListElements,
  state: MeetingHistoryListState,
  currentMeeting: CurrentPageMeetingHistoryItem | null,
  formatDate: (isoDate: string) => string = formatHistoryDate,
  onOpenPersisted?: (meetingId: string) => void,
  deletion?: MeetingHistoryActions,
  searchQuery = '',
): void {
  if (state.status === 'disposed') return;
  const allItems = mergeMeetingHistory(state.records, currentMeeting, onOpenPersisted);
  const query = normalizeSearch(searchQuery.trim());
  const matchedRecords = query ? new Set(state.records
    .filter((record) => record.transcript.utterances.some(
      ({ rawText, correctedText }) => normalizeSearch(rawText).includes(query)
        || (correctedText !== null && normalizeSearch(correctedText).includes(query)),
    )).map(({ meetingId }) => meetingId)) : null;
  const currentTextMatch = query && currentMeeting?.searchableText?.some(
    (text) => normalizeSearch(text).includes(query),
  );
  const items = !query ? allItems : allItems.filter((item) => normalizeSearch(item.title).includes(query)
    || matchedRecords?.has(item.meetingId)
    || (currentTextMatch && currentMeeting?.meetingId === item.meetingId));
  elements.list.replaceChildren(...items.map((item) => renderHistoryItem(item, formatDate, deletion)));
  elements.list.hidden = items.length === 0;
  elements.empty.hidden = true;
  if (elements.searchEmpty) elements.searchEmpty.hidden = true;
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
      if (items.length === 0) {
        if (query && allItems.length > 0 && elements.searchEmpty) elements.searchEmpty.hidden = false;
        else elements.empty.hidden = false;
      }
      return;
  }
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja');
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
  deletion?: MeetingHistoryActions,
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
  if (item.persisted && deletion) {
    const actions = document.createElement('details');
    actions.className = 'history-entry__actions';
    const trigger = document.createElement('summary');
    trigger.textContent = '…';
    trigger.setAttribute('aria-label', `「${item.title}」のその他の操作`);
    const panel = document.createElement('div');
    panel.className = 'history-entry__menu';
    actions.append(trigger, panel);
    actions.addEventListener('toggle', () => {
      if (!actions.open) return;
      for (const other of listItem.parentElement?.querySelectorAll<HTMLDetailsElement>('.history-entry__actions') ?? []) {
        if (other !== actions) other.open = false;
      }
    });
    actions.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      actions.open = false;
      trigger.focus();
    });
    const rename = deletion.onRename;
    if (rename) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = '名前を変更';
      option.disabled = deletion.disabled(item.meetingId);
      option.addEventListener('click', () => {
        actions.open = false;
        rename(item.meetingId, item.title);
      });
      panel.append(option);
    }
    for (const [label, callback] of [['PDFとしてダウンロード', deletion.onPdf], ['共有', deletion.onShare]] as const) {
      if (!callback) continue;
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = label;
      option.disabled = deletion.disabled(item.meetingId);
      option.addEventListener('click', () => { actions.open = false; callback(item.meetingId); });
      panel.append(option);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-entry__delete';
    button.textContent = '削除';
    button.setAttribute('aria-label', `「${item.title}」を削除`);
    button.disabled = deletion.disabled(item.meetingId);
    button.addEventListener('click', () => { actions.open = false; deletion.onDelete(item.meetingId, item.title, button); });
    panel.append(button);
    listItem.append(actions);
  }
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
