import type { SpeechToTextProviderKind, TranscriptionLanguage } from '../transcription/types';

export interface MeetingSetupDraft {
  title: string;
  language: TranscriptionLanguage;
  transcriptionProvider: SpeechToTextProviderKind;
  correctionEnabled: boolean;
  liveSummaryEnabled: boolean;
  finalSummaryEnabled: boolean;
  historyRetention: 'page-session';
  externalProcessingAcknowledged: boolean;
}

export interface MeetingSettingsSnapshot extends Readonly<Omit<MeetingSetupDraft, 'externalProcessingAcknowledged'>> {
  settingsVersion: 1;
  createdAt: string;
}

export interface MeetingTranscriptionOption {
  id: SpeechToTextProviderKind;
  label: string;
  description: string;
  audience: 'standard' | 'developer';
  externalAcknowledgementRequired: boolean;
}

export const meetingTranscriptionCatalog: readonly MeetingTranscriptionOption[] = [
  { id: 'local-whisper', label: 'Local Whisper', description: 'このPCのローカルサーバーで音声を処理します。外部STT APIへ音声を送信しません。', audience: 'standard', externalAcknowledgementRequired: false },
  { id: 'browser', label: 'ブラウザー音声認識', description: 'ブラウザーが提供する音声認識機能を使用します。処理方法とデータの扱いはブラウザーのポリシーに従います。', audience: 'standard', externalAcknowledgementRequired: true },
  { id: 'mock', label: 'Mock（開発者向け）', description: '外部送信を行わないテスト用Providerです。', audience: 'developer', externalAcknowledgementRequired: false },
  { id: 'websocket', label: 'WebSocket（開発者向け）', description: '設定済みバックエンドへ音声を送信します。', audience: 'developer', externalAcknowledgementRequired: true },
];

export function createInitialMeetingSetupDraft(provider: SpeechToTextProviderKind = 'local-whisper'): MeetingSetupDraft {
  return { title: '新しい会議', language: 'ja-JP', transcriptionProvider: provider, correctionEnabled: false, liveSummaryEnabled: false, finalSummaryEnabled: false, historyRetention: 'page-session', externalProcessingAcknowledged: false };
}

export function validateMeetingSetupDraft(draft: MeetingSetupDraft): string | null {
  const title = draft.title.trim();
  if (!title) return '会議タイトルを入力してください。';
  if (title.length > 80) return '会議タイトルは80文字以内で入力してください。';
  if (draft.language !== 'ja-JP' && draft.language !== 'en-US') return '言語を選択してください。';
  const option = meetingTranscriptionCatalog.find((item) => item.id === draft.transcriptionProvider);
  if (!option) return '文字起こし方法を選択してください。';
  if (option.externalAcknowledgementRequired && !draft.externalProcessingAcknowledged) return 'データ処理方法を確認してください。';
  return null;
}

export function createMeetingSettingsSnapshot(draft: MeetingSetupDraft, createdAt: string): MeetingSettingsSnapshot {
  const error = validateMeetingSetupDraft(draft);
  if (error) throw new Error(error);
  return Object.freeze({ settingsVersion: 1 as const, title: draft.title.trim(), language: draft.language, transcriptionProvider: draft.transcriptionProvider, correctionEnabled: draft.correctionEnabled, liveSummaryEnabled: draft.liveSummaryEnabled, finalSummaryEnabled: draft.finalSummaryEnabled, historyRetention: 'page-session' as const, createdAt });
}

export function buildMeetingSetupSummary(draft: MeetingSetupDraft): string[] {
  const option = meetingTranscriptionCatalog.find((item) => item.id === draft.transcriptionProvider);
  return [`${draft.language === 'ja-JP' ? '日本語' : 'English'}で文字起こしします。`, `${option?.label ?? '選択した方法'}を使用します。`, option?.description ?? '処理方法は確認できません。', draft.correctionEnabled ? '確定した発言を読みやすく整えます。' : '整文は使用しません。', draft.liveSummaryEnabled ? '会議中に簡易要約を表示します。' : '会議中の簡易要約は使用しません。', draft.finalSummaryEnabled ? '会議終了後に最終要約とTODOを作成します。' : '最終要約とTODOは作成しません。', '会議履歴は現在のページを開いている間だけ保持されます。', 'ページ再読み込み後は復元されません。'];
}
