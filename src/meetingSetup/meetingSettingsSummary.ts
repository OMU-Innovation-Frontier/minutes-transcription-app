import {
  meetingTranscriptionCatalog,
  type MeetingSettingsSnapshot,
} from './meetingSetup';

export interface MeetingSettingsSummary {
  title: string;
  language: string;
  provider: string;
  providerDescription: string;
  correction: string;
  summary: string;
  historyRetention: string;
  createdAt: string;
  externalProcessing: string;
  externalProcessingRequired: boolean;
}

type DateFormatter = (date: Date) => string;

const defaultDateFormatter: DateFormatter = (date) => new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(date);

export function buildMeetingSettingsSummary(
  snapshot: MeetingSettingsSnapshot,
  formatDate: DateFormatter = defaultDateFormatter,
): MeetingSettingsSummary {
  const provider = meetingTranscriptionCatalog.find((option) => option.id === snapshot.transcriptionProvider);
  const createdAt = new Date(snapshot.createdAt);

  return {
    title: snapshot.title,
    language: snapshot.language === 'ja-JP' ? '日本語' : 'English',
    provider: provider?.label ?? '文字起こし方法を確認できません',
    providerDescription: provider?.description ?? 'データ処理方法を確認できません。',
    correction: snapshot.correctionEnabled ? '確定した発言を整文します' : '整文は使用しません',
    summary: buildSummaryLabel(snapshot),
    historyRetention: '現在のページを開いている間だけ保持（再読み込み後は復元されません）',
    createdAt: Number.isNaN(createdAt.getTime()) ? '作成日時を確認できません' : formatDate(createdAt),
    externalProcessing: provider?.externalAcknowledgementRequired
      ? '外部またはブラウザー管理の処理があります'
      : '外部処理はありません',
    externalProcessingRequired: provider?.externalAcknowledgementRequired ?? false,
  };
}

export function renderMeetingSettingsSummary(
  root: HTMLElement,
  snapshot: MeetingSettingsSnapshot | null,
  formatDate?: DateFormatter,
): void {
  root.replaceChildren();
  root.hidden = snapshot === null;
  if (!snapshot) return;

  const summary = buildMeetingSettingsSummary(snapshot, formatDate);
  const heading = document.createElement('h3');
  const headingId = `${root.id || 'meeting-settings-summary'}-title`;
  heading.id = headingId;
  heading.textContent = 'この会議の設定';
  root.setAttribute('aria-labelledby', headingId);

  const description = document.createElement('p');
  description.className = 'meeting-settings-summary__description';
  description.textContent = '会議作成時に確定した内容です。録音中は変更されません。';

  const list = document.createElement('dl');
  list.className = 'meeting-settings-summary__list';
  appendRow(list, '会議タイトル', summary.title, 'title');
  appendRow(list, '言語', summary.language, 'language');
  appendRow(list, '文字起こし方法', summary.provider, 'provider');
  appendRow(list, 'データ処理', summary.providerDescription, 'provider-description');
  appendRow(list, '整文', summary.correction, 'correction');
  appendRow(list, '要約', summary.summary, 'summary');
  appendRow(list, '会議履歴', summary.historyRetention, 'history-retention');
  appendRow(list, '作成日時', summary.createdAt, 'created-at');
  const externalRow = appendRow(list, '外部処理', summary.externalProcessing, 'external-processing');
  if (summary.externalProcessingRequired) externalRow.classList.add('meeting-settings-summary__row--external');

  root.append(heading, description, list);
}

function buildSummaryLabel(snapshot: MeetingSettingsSnapshot): string {
  if (snapshot.liveSummaryEnabled && snapshot.finalSummaryEnabled) {
    return '会議中の簡易要約と、会議終了後の最終要約・TODOを使用します';
  }
  if (snapshot.liveSummaryEnabled) return '会議中の簡易要約を使用します';
  if (snapshot.finalSummaryEnabled) return '会議終了後の最終要約・TODOを使用します';
  return '要約は使用しません';
}

function appendRow(list: HTMLDListElement, label: string, value: string, setting: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'meeting-settings-summary__row';
  row.dataset.setting = setting;
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value;
  row.append(term, detail);
  list.append(row);
  return row;
}
