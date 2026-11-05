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

export interface MeetingExternalProcessingRequirements {
  correctionStatusKnown: boolean;
  correctionExternalTransmission: boolean;
  summaryStatusKnown?: boolean;
  summaryEnabled?: boolean;
  summaryExternalTransmission?: boolean;
}

const LOCAL_CORRECTION_REQUIREMENTS: MeetingExternalProcessingRequirements = {
  correctionStatusKnown: true,
  correctionExternalTransmission: false,
};

export const meetingTranscriptionCatalog: readonly MeetingTranscriptionOption[] = [
  { id: 'groq-whisper', label: 'Groq Whisper（無料枠）', description: '音声を文字起こしするためGroqへ送信します。無料枠には利用上限があり、提供条件は変更される場合があります。', audience: 'standard', externalAcknowledgementRequired: true },
  { id: 'local-whisper', label: 'Local Whisper', description: 'このPCのローカルサーバーで音声を処理します。外部STT APIへ音声を送信しません。', audience: 'standard', externalAcknowledgementRequired: false },
  { id: 'browser', label: 'ブラウザー音声認識', description: 'ブラウザーが提供する音声認識機能を使用します。処理方法とデータの扱いはブラウザーのポリシーに従います。', audience: 'standard', externalAcknowledgementRequired: true },
  { id: 'mock', label: 'Mock（開発者向け）', description: '外部送信を行わないテスト用Providerです。', audience: 'developer', externalAcknowledgementRequired: false },
  { id: 'websocket', label: 'WebSocket（開発者向け）', description: '設定済みバックエンドへ音声を送信します。', audience: 'developer', externalAcknowledgementRequired: true },
];

export function createInitialMeetingSetupDraft(provider: SpeechToTextProviderKind = 'local-whisper'): MeetingSetupDraft {
  return { title: '新しい会議', language: 'ja-JP', transcriptionProvider: provider, correctionEnabled: false, liveSummaryEnabled: false, finalSummaryEnabled: false, historyRetention: 'page-session', externalProcessingAcknowledged: false };
}

export function validateMeetingSetupDraft(
  draft: MeetingSetupDraft,
  requirements: MeetingExternalProcessingRequirements = LOCAL_CORRECTION_REQUIREMENTS,
): string | null {
  const title = draft.title.trim();
  if (!title) return '会議タイトルを入力してください。';
  if (title.length > 80) return '会議タイトルは80文字以内で入力してください。';
  if (draft.language !== 'ja-JP' && draft.language !== 'en-US') return '言語を選択してください。';
  const option = meetingTranscriptionCatalog.find((item) => item.id === draft.transcriptionProvider);
  if (!option) return '文字起こし方法を選択してください。';
  if (draft.correctionEnabled && !requirements.correctionStatusKnown) return '整文のデータ処理方法を確認できません。';
  if (draft.liveSummaryEnabled || draft.finalSummaryEnabled) {
    if (requirements.summaryStatusKnown === false) return '要約のデータ処理方法を確認できません。';
    if (requirements.summaryEnabled === false) return '要約はサーバー設定で無効です。';
  }
  if (requiresExternalProcessingAcknowledgement(draft, requirements) && !draft.externalProcessingAcknowledged) return 'データ処理方法を確認してください。';
  return null;
}

export function createMeetingSettingsSnapshot(
  draft: MeetingSetupDraft,
  createdAt: string,
  requirements: MeetingExternalProcessingRequirements = LOCAL_CORRECTION_REQUIREMENTS,
): MeetingSettingsSnapshot {
  const error = validateMeetingSetupDraft(draft, requirements);
  if (error) throw new Error(error);
  return Object.freeze({ settingsVersion: 1 as const, title: draft.title.trim(), language: draft.language, transcriptionProvider: draft.transcriptionProvider, correctionEnabled: draft.correctionEnabled, liveSummaryEnabled: draft.liveSummaryEnabled, finalSummaryEnabled: draft.finalSummaryEnabled, historyRetention: 'page-session' as const, createdAt });
}

export function buildMeetingSetupSummary(
  draft: MeetingSetupDraft,
  requirements: MeetingExternalProcessingRequirements = LOCAL_CORRECTION_REQUIREMENTS,
): string[] {
  const option = meetingTranscriptionCatalog.find((item) => item.id === draft.transcriptionProvider);
  const correctionSummary = draft.correctionEnabled && requirements.correctionExternalTransmission
    ? '確定した発言を読みやすく整えます。確定した文字起こし、直前の発話、設定した用語集を整文のためGroqへ送信します。'
    : draft.correctionEnabled ? '確定した発言を読みやすく整えます。' : '整文は使用しません。';
  const summaryNotes: string[] = [];
  if (draft.liveSummaryEnabled || draft.finalSummaryEnabled) {
    if (requirements.summaryStatusKnown === false) summaryNotes.push('要約のデータ処理方法を確認できません。サーバーとの接続を確認して会議準備を開き直してください。');
    else if (requirements.summaryEnabled === false) summaryNotes.push('要約はサーバー設定で無効です。要約をOFFにするか、サーバーの設定を確認してください。');
    else if (requirements.summaryExternalTransmission) summaryNotes.push('要約・決定事項・TODOの生成に、この会議の確定した文字起こしと生成済みの要約をOpenAIへ送信します。');
  }
  return [`${draft.language === 'ja-JP' ? '日本語' : 'English'}で文字起こしします。`, `${option?.label ?? '選択した方法'}を使用します。`, option?.description ?? '処理方法は確認できません。', correctionSummary, draft.liveSummaryEnabled ? '会議中に簡易要約を表示します。' : '会議中の簡易要約は使用しません。', draft.finalSummaryEnabled ? '会議終了後に最終要約とTODOを作成します。' : '最終要約とTODOは作成しません。', ...summaryNotes, '会議終了後、履歴はこの端末のブラウザー内へ保存され、ページを閉じて開き直しても確認できます。', 'サイトデータを削除すると失われ、別の端末やブラウザープロフィールには同期されません。クラウド保存・チーム共有・アカウント保護には対応していません。'];
}

export function requiresExternalProcessingAcknowledgement(
  draft: MeetingSetupDraft,
  requirements: MeetingExternalProcessingRequirements = LOCAL_CORRECTION_REQUIREMENTS,
): boolean {
  const option = meetingTranscriptionCatalog.find((item) => item.id === draft.transcriptionProvider);
  return Boolean(option?.externalAcknowledgementRequired)
    || (draft.correctionEnabled && requirements.correctionExternalTransmission)
    || ((draft.liveSummaryEnabled || draft.finalSummaryEnabled) && Boolean(requirements.summaryExternalTransmission));
}

export function buildExternalProcessingDisclosure(
  draft: MeetingSetupDraft,
  requirements: MeetingExternalProcessingRequirements = LOCAL_CORRECTION_REQUIREMENTS,
): string {
  const messages: string[] = [];
  const option = meetingTranscriptionCatalog.find((item) => item.id === draft.transcriptionProvider);
  if (option?.externalAcknowledgementRequired) messages.push(option.description);
  if (draft.correctionEnabled && requirements.correctionExternalTransmission) {
    messages.push('確定した文字起こし、直前の発話、設定した用語集を整文のためGroqへ送信します。');
  }
  if ((draft.liveSummaryEnabled || draft.finalSummaryEnabled) && requirements.summaryExternalTransmission) {
    messages.push('要約・決定事項・TODOを作成するため、この会議の確定した文字起こし（整文済みの発言を含む）と生成済みの要約をOpenAIへ送信します。音声は要約処理へ送信しません。');
  }
  return messages.join(' ');
}
