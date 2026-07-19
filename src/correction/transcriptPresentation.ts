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
  const succeeded = (status === 'succeeded' || status === 'completed') && correction !== undefined;
  return {
    visibleText: succeeded ? correction.correctedText : sentence.rawText,
    rawText: sentence.rawText,
    status,
    statusLabel: correctionStatusLabel(status),
    uncertainParts: correction?.uncertainParts ?? [],
    showingCorrection: succeeded && correction.correctedText !== sentence.rawText,
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
      privacyText: 'Local Whisperの音声認識はローカルです。クラウドLLM整文を有効にすると、確定した文字起こし文章が外部送信されます。',
    };
  }
  return {
    statusText: `LLM整文：有効（${status.provider}・外部送信なし）`,
    privacyText: 'Mock整文は外部通信を行いません。確定発話だけを独立キューで処理します。',
  };
}

export function correctionStatusLabel(status: CorrectionStatus): string {
  const labels: Record<CorrectionStatus, string> = {
    disabled: '整文対象外',
    queued: '整文待ち',
    pending: '整文中（原文表示）',
    processing: '文章を整えています',
    succeeded: '整文済み',
    completed: '整文済み',
    failed: '整文失敗（原文表示）',
    cancelled: '整文を中断しました',
    skipped: '整文対象外',
    fallback: '原文を表示しています',
  };
  return labels[status];
}
