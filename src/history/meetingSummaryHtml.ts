import { parseMeetingRecord, type MeetingRecord } from './meetingRecord';

export function createMeetingSummaryHtml(value: MeetingRecord): HTMLElement {
  const record = parseMeetingRecord(value);
  const finalSummary = record.finalSummary;
  if (!finalSummary) throw new Error('最終要約を作成してからPDFを保存してください。');
  const root = document.createElement('article');
  root.lang = 'ja';
  root.className = 'meeting-summary-document';
  const style = document.createElement('style');
  style.textContent = `
    .meeting-summary-document { box-sizing: border-box; width: 190mm; padding: 12mm 12mm 0;
      color: #192330; background: white; font: 11pt/1.8 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif;
      overflow-wrap: anywhere; }
    .meeting-summary-document * { box-sizing: border-box; }
    .meeting-summary-document header { border-top: 5px solid #245ad4; padding-top: 20px; margin-bottom: 28px; }
    .meeting-summary-document h1 { font-size: 24pt; line-height: 1.45; margin: 0 0 12px; white-space: pre-wrap; }
    .meeting-summary-document .date { color: #526173; margin: 0; }
    .meeting-summary-document h2 { font-size: 14pt; margin: 24px 0 8px; border-bottom: 1px solid #d8e0ea; padding-bottom: 6px; break-after: avoid; }
    .meeting-summary-document p { margin: 8px 0; white-space: pre-wrap; }
    .meeting-summary-document ul { margin: 8px 0; padding-left: 22px; }
    .meeting-summary-document li { margin: 6px 0; white-space: pre-wrap; }
    .meeting-summary-document .todo { border-left: 3px solid #245ad4; padding-left: 14px; margin: 14px 0; break-inside: avoid; }
    .meeting-summary-document .todo-meta { color: #526173; font-size: 10pt; }
    @page { size: A4; margin: 10mm; }
    @media print { .meeting-summary-document { width: auto; padding: 0; } }
  `;
  root.append(style);
  function append(parent: HTMLElement, tag: string, text: string): HTMLElement {
    const element = document.createElement(tag);
    element.textContent = text;
    parent.append(element);
    return element;
  }
  const header = document.createElement('header');
  root.append(header);
  append(header, 'h1', record.title ?? record.settingsSnapshot.title);
  append(header, 'p', new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long', timeStyle: 'short' })
    .format(new Date(record.startedAt ?? record.createdAt))).className = 'date';
  append(root, 'h2', '最終要約');
  append(root, 'p', finalSummary.summary.overview);
  for (const [heading, items] of [
    ['議題', finalSummary.summary.agenda], ['要点', finalSummary.summary.keyPoints],
    ['決定事項', finalSummary.summary.decisions], ['未解決事項', finalSummary.summary.unresolvedItems],
    ['次回確認事項', finalSummary.summary.nextChecks],
  ] as const) {
    append(root, 'h2', heading);
    if (items.length === 0) append(root, 'p', '記載なし');
    else {
      const list = document.createElement('ul');
      root.append(list);
      for (const item of items) append(list, 'li', item.text);
    }
  }
  append(root, 'h2', 'TODO');
  if (finalSummary.todos.length === 0) append(root, 'p', '記載なし');
  for (const todo of finalSummary.todos) {
    const item = document.createElement('div');
    item.className = 'todo';
    root.append(item);
    append(item, 'p', `${todo.completed ? '完了' : '未完了'} / ${todo.content}`);
    append(item, 'p', `担当 ${todo.assignee ?? '未設定'} / 期限 ${todo.dueDate ?? '未設定'}`).className = 'todo-meta';
  }
  return root;
}
