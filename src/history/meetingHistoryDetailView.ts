import type { MeetingHistoryDetailState } from './meetingHistoryDetailController';
import type { MeetingRecord, PersistedFinalSummaryTodo, PersistedUtterance } from './meetingRecord';

export interface MeetingHistoryDetailElements {
  title: HTMLElement;
  date: HTMLElement;
  historyStatus: HTMLElement;
  historyStatusMessage: HTMLElement;
  historyRetryButton: HTMLButtonElement;
  summarySection: HTMLElement;
  summaryTitle: HTMLElement;
  summaryStatus: HTMLElement;
  summaryContent: HTMLElement;
  transcriptSection: HTMLElement;
  transcript: HTMLOListElement;
  transcriptEmpty: HTMLElement;
  persistenceNote: HTMLElement;
}

type DateFormatter = (isoDate: string) => string;
type DurationFormatter = (milliseconds: number) => string;

export function renderPersistedMeetingHistoryDetail(
  elements: MeetingHistoryDetailElements,
  state: MeetingHistoryDetailState,
  formatDate: DateFormatter = defaultDateFormatter,
  formatDuration: DurationFormatter = defaultDurationFormatter,
): void {
  if (state.status === 'disposed') return;
  resetState(elements);

  if (state.status === 'ready') {
    renderRecord(elements, state.record, formatDate, formatDuration);
    return;
  }

  elements.title.textContent = '会議履歴';
  setHidden(elements.historyStatus, false);
  switch (state.status) {
    case 'idle':
    case 'loading':
      elements.historyStatusMessage.textContent = '会議履歴を読み込んでいます。';
      elements.historyRetryButton.disabled = true;
      return;
    case 'not_found':
      elements.historyStatusMessage.textContent = '保存済みの会議が見つかりませんでした。';
      return;
    case 'failed':
      elements.historyStatusMessage.textContent = '保存された会議の詳細を読み込めませんでした。';
      setHidden(elements.historyRetryButton, false);
      return;
    case 'unavailable':
      elements.historyStatusMessage.textContent = 'このブラウザーでは保存された会議の詳細を利用できません。';
      return;
  }
}

function resetState(elements: MeetingHistoryDetailElements): void {
  elements.title.textContent = '';
  elements.date.textContent = '';
  setHidden(elements.historyStatus, true);
  elements.historyStatusMessage.textContent = '';
  setHidden(elements.historyRetryButton, true);
  elements.historyRetryButton.disabled = false;
  setHidden(elements.summarySection, true);
  elements.summaryTitle.textContent = '最終要約';
  elements.summaryStatus.textContent = '';
  elements.summaryContent.replaceChildren();
  setHidden(elements.summaryContent, true);
  setHidden(elements.transcriptSection, true);
  elements.transcript.replaceChildren();
  setHidden(elements.transcriptEmpty, true);
  setHidden(elements.persistenceNote, true);
  elements.persistenceNote.textContent = '';
}

function renderRecord(
  elements: MeetingHistoryDetailElements,
  record: MeetingRecord,
  formatDate: DateFormatter,
  formatDuration: DurationFormatter,
): void {
  elements.title.textContent = displayTitle(record);
  const primaryDate = record.endedAt ?? record.startedAt ?? record.createdAt;
  const durationMilliseconds = record.startedAt && record.endedAt
    ? Date.parse(record.endedAt) - Date.parse(record.startedAt)
    : null;
  const duration = durationMilliseconds !== null && durationMilliseconds >= 0
    ? ` ・ ${formatDuration(durationMilliseconds)}`
    : '';
  elements.date.textContent = `${formatDate(primaryDate)}${duration}`;

  setHidden(elements.summarySection, false);
  renderSummary(elements, record);
  setHidden(elements.transcriptSection, false);
  renderTranscript(elements, record.transcript.utterances);
  setHidden(elements.persistenceNote, false);
  elements.persistenceNote.textContent = 'この会議はこの端末のブラウザー内に保存されています。サイトデータを削除すると失われ、別の端末やブラウザープロフィールには同期されません。';
}

function renderSummary(elements: MeetingHistoryDetailElements, record: MeetingRecord): void {
  const finalSummary = record.finalSummary;
  if (!finalSummary) {
    elements.summaryStatus.textContent = 'この会議には保存済みの最終要約がありません。';
    return;
  }

  elements.summaryStatus.textContent = '保存済みの最終要約です。';
  const overviewHeading = heading('h3', '概要');
  const overview = document.createElement('p');
  overview.textContent = finalSummary.summary.overview;
  const sections = [
    createSummaryListSection('議題', finalSummary.summary.agenda),
    createSummaryListSection('要点', finalSummary.summary.keyPoints),
    createSummaryListSection('決定事項', finalSummary.summary.decisions),
    createSummaryListSection('未解決事項', finalSummary.summary.unresolvedItems),
    createSummaryListSection('次回確認事項', finalSummary.summary.nextChecks),
  ].flat();
  const todoHeading = heading('h3', 'TODO');
  const todos = finalSummary.todos.length === 0
    ? emptyMessage('TODOは保存されていません。')
    : createTodoList(finalSummary.todos);
  const metadata = document.createElement('dl');
  metadata.className = 'final-summary__metadata';
  appendDefinition(metadata, '要約作成日時', defaultDateFormatter(finalSummary.createdAt));
  elements.summaryContent.append(overviewHeading, overview, ...sections, todoHeading, todos, metadata);
  setHidden(elements.summaryContent, false);
}

function renderTranscript(elements: MeetingHistoryDetailElements, utterances: readonly PersistedUtterance[]): void {
  const ordered = [...utterances].sort((left, right) => left.sequence - right.sequence);
  elements.transcript.replaceChildren(...ordered.map(createUtterance));
  elements.transcriptEmpty.textContent = '保存された文字起こしはありません。';
  setHidden(elements.transcriptEmpty, ordered.length > 0);
}

function createUtterance(utterance: PersistedUtterance, index: number): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'transcript-item transcript-item--persisted';
  const text = document.createElement('p');
  text.className = 'utterance__text';
  text.textContent = utterance.correctedText ?? utterance.rawText;
  item.append(text);

  if (utterance.correctedText !== null) {
    const state = document.createElement('small');
    state.className = 'utterance__state utterance__state--completed';
    state.textContent = '整文済み';
    item.prepend(state);
    if (utterance.correctedText !== utterance.rawText) {
      const originalId = `persisted-utterance-original-${index}`;
      const toggle = document.createElement('button');
      toggle.className = 'persisted-utterance__original-toggle';
      toggle.type = 'button';
      toggle.textContent = '原文を見る';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', originalId);
      const raw = document.createElement('p');
      raw.className = 'persisted-utterance__original';
      raw.id = originalId;
      raw.hidden = true;
      raw.textContent = utterance.rawText;
      toggle.addEventListener('click', () => {
        raw.hidden = !raw.hidden;
        toggle.setAttribute('aria-expanded', String(!raw.hidden));
        toggle.textContent = raw.hidden ? '原文を見る' : '原文を閉じる';
      });
      item.append(toggle, raw);
    }
  }
  return item;
}

function createSummaryListSection(
  title: string,
  items: readonly { text: string }[],
): Array<HTMLHeadingElement | HTMLUListElement> {
  if (items.length === 0) return [];
  const list = document.createElement('ul');
  list.className = 'final-summary__section-list';
  list.replaceChildren(...items.map(({ text }) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  return [heading('h3', title), list];
}

function displayTitle(record: MeetingRecord): string {
  const recordTitle = record.title?.trim();
  if (recordTitle) return recordTitle;
  const snapshotTitle = record.settingsSnapshot.title.trim();
  return snapshotTitle || '無題の会議';
}

function createTodoList(todos: readonly PersistedFinalSummaryTodo[]): HTMLOListElement {
  const list = document.createElement('ol');
  list.className = 'final-summary__todos';
  for (const todo of todos) {
    const item = document.createElement('li');
    const content = document.createElement('p');
    content.textContent = todo.content;
    const details = document.createElement('dl');
    appendDefinition(details, '担当者', todo.assignee ?? '未指定');
    appendDefinition(details, '期限', todo.dueDate ?? '未指定');
    appendDefinition(details, '状態', todo.completed ? '完了' : '未完了');
    item.append(content, details);
    list.append(item);
  }
  return list;
}

function heading(tag: 'h3', text: string): HTMLHeadingElement {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function emptyMessage(text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = 'final-summary__empty';
  element.textContent = text;
  return element;
}

function appendDefinition(list: HTMLDListElement, termText: string, valueText: string): void {
  const term = document.createElement('dt');
  term.textContent = termText;
  const value = document.createElement('dd');
  value.textContent = valueText;
  list.append(term, value);
}

function setHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
  element.setAttribute('aria-hidden', String(hidden));
}

function defaultDateFormatter(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function defaultDurationFormatter(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}時間${minutes}分${seconds}秒`
    : `${minutes}分${seconds}秒`;
}
