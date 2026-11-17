import { parseMeetingRecord, type MeetingRecord } from './meetingRecord';

export function meetingExportTitle(record: MeetingRecord): string {
  return record.title?.trim() || record.settingsSnapshot.title.trim() || '無題の会議';
}

export function meetingExportFilename(record: MeetingRecord, extension: 'pdf' | 'txt'): string {
  const safeTitle = Array.from(meetingExportTitle(record).replace(/[<>:"/\\|?*]/g, '_'))
    .map((char) => char.codePointAt(0)! < 32 ? '_' : char).join('').slice(0, 80);
  return `Minutes-${safeTitle}.${extension}`;
}

export function meetingExportText(value: MeetingRecord): string {
  const record = parseMeetingRecord(value);
  const parts = [meetingExportTitle(record), `日時: ${new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'long', timeStyle: 'short',
  }).format(new Date(record.endedAt ?? record.startedAt ?? record.createdAt))}`];
  const summary = record.finalSummary?.summary;
  if (summary) {
    parts.push('概要', summary.overview);
    for (const [title, items] of [
      ['議題', summary.agenda], ['要点', summary.keyPoints], ['決定事項', summary.decisions],
      ['未解決事項', summary.unresolvedItems], ['次回確認事項', summary.nextChecks],
    ] as const) {
      parts.push(title, items.length ? items.map((item) => `・${item.text}`).join('\n') : '記載なし');
    }
    const todos = record.finalSummary?.todos ?? [];
    parts.push('TODO', todos.length ? todos.map((todo) =>
      `${todo.completed ? '完了' : '未完了'}: ${todo.content}\n担当: ${todo.assignee ?? '未設定'} / 期限: ${todo.dueDate ?? '未設定'}`,
    ).join('\n\n') : '記載なし');
  } else parts.push('最終要約', '最終要約はありません。');
  parts.push('文字起こし', '整文済みの発話は整文を表示しています。');
  parts.push(record.transcript.utterances.length
    ? record.transcript.utterances.map((item) => item.correctedText ?? item.rawText).join('\n\n')
    : '文字起こしはありません。');
  return parts.join('\n\n');
}

export function downloadMeetingFile(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Allow the browser to consume the download before releasing its URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Must be called directly from the user's click to preserve share-sheet activation. */
export async function shareMeeting(record: MeetingRecord): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const text = meetingExportText(record);
  const file = new File(['\ufeff', text], meetingExportFilename(record, 'txt'), { type: 'text/plain;charset=utf-8' });
  if (typeof navigator.share !== 'function' || !navigator.canShare?.({ files: [file] })) {
    downloadMeetingFile(file, file.name);
    return 'downloaded';
  }
  try {
    await navigator.share({ title: meetingExportTitle(record), files: [file] });
    return 'shared';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') return 'cancelled';
    throw new Error('共有できませんでした。');
  }
}
