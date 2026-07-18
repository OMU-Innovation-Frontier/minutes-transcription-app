import type { CorrectionServiceStatus, CorrectionStatus, CorrectionUncertainPart } from '../../shared/correction';
import type { CompletedSentence } from '../transcription/types';

export interface SentencePresentation {
  visibleText: string;
  rawText: string;
  status: CorrectionStatus;
  statusLabel: string;
  uncertainParts: readonly CorrectionUncertainPart[];
  showingCorrection: boolean;
}

export function sentencePresentation(sentence: CompletedSentence): SentencePresentation {
  const correction = sentence.correction;
  const status = correction?.status ?? 'disabled';
  const completed = status === 'completed' && correction !== undefined;
  return {
    visibleText: completed ? correction.correctedText : sentence.rawText,
    rawText: sentence.rawText,
    status,
    statusLabel: statusLabels[status],
    uncertainParts: correction?.uncertainParts ?? [],
    showingCorrection: completed && correction.correctedText !== sentence.rawText,
  };
}

export interface CorrectionStatusPresentation {
  statusText: string;
  privacyText: string;
}

export function correctionStatusPresentation(status: CorrectionServiceStatus): CorrectionStatusPresentation {
  if (!status.enabled) {
    return {
      statusText: 'LLM整文：無効（完全ローカル）',
      privacyText: 'Local Whisperの音声認識はローカルです。LLM整文は既定で無効です。現在、整文による文字起こし文章の外部送信はありません。',
    };
  }
  if (status.externalTransmission) {
    return {
      statusText: `LLM整文：有効（${status.provider}・文字起こし外部送信あり）`,
      privacyText: 'Local Whisperの音声認識はローカルです。クラウドLLM整文を有効にすると、確定した文字起こし文章が外部送信されます。整文はサーバー設定で無効化でき、既定では無効です。',
    };
  }
  return {
    statusText: `LLM整文：有効（${status.provider}・外部送信なし）`,
    privacyText: 'Local Whisperの音声認識はローカルです。現在、整文による文字起こし文章の外部送信はありません。整文はサーバー設定で無効化でき、既定では無効です。',
  };
}

const statusLabels: Record<CorrectionStatus, string> = {
  disabled: '整文なし',
  pending: '整文中（原文表示）',
  completed: '整文完了',
  failed: '整文失敗（原文表示）',
  skipped: '整文対象外',
};
