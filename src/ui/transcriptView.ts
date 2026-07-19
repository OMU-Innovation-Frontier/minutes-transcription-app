import type { CorrectionStatus, CorrectionUncertainReason } from '../../shared/correction';
import { CORRECTION_MAX_ATTEMPTS } from '../../shared/correction';
import { correctionStatusLabel, sentencePresentation } from '../correction/transcriptPresentation';
import type { CompletedSentence, RawTranscriptSegment } from '../transcription/types';

export type TranscriptPosition = 'latest' | 'previous' | 'past';

export interface TranscriptElementOptions {
  enteringSentenceId?: string;
  timeFormatter?: (timestamp: number) => string;
  onRetryCorrection?: (sentenceId: string) => void;
}

export function transcriptPosition(index: number, total: number): TranscriptPosition {
  if (index === total - 1) return 'latest';
  if (index === total - 2) return 'previous';
  return 'past';
}

export function createSentenceElement(
  sentence: CompletedSentence,
  index: number,
  total: number,
  options: TranscriptElementOptions = {},
): HTMLLIElement {
  const presentation = sentencePresentation(sentence);
  const position = transcriptPosition(index, total);
  const item = document.createElement('li');
  item.className = `transcript-item transcript-item--${position}`;
  item.dataset.sentenceId = sentence.id;
  if (options.enteringSentenceId === sentence.id) item.classList.add('transcript-item--entering');

  const details = document.createElement('details');
  details.className = 'utterance';
  const summary = document.createElement('summary');
  summary.className = 'utterance__summary';
  const panelId = `utterance-details-${safeDomId(sentence.id)}`;
  summary.setAttribute('aria-label', `${formatLanguage(sentence.language)}の発話詳細を表示`);
  summary.setAttribute('aria-controls', panelId);
  summary.setAttribute('aria-expanded', 'false');
  details.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(details.open)));

  const meta = document.createElement('span');
  meta.className = 'utterance__meta';
  const time = document.createElement('time');
  time.textContent = (options.timeFormatter ?? formatTime)(sentence.startTime);
  meta.append(time, createStateNote(presentation.status, presentation.uncertainParts.length));

  const text = document.createElement('span');
  text.className = 'utterance__text';
  text.textContent = presentation.visibleText;
  summary.append(meta, text);

  const panel = document.createElement('div');
  panel.id = panelId;
  panel.className = 'utterance__details';
  panel.append(
    detailRow('整文状態', presentation.statusLabel),
    detailRow('表示中の文章', presentation.visibleText),
    detailRow('発話時刻', (options.timeFormatter ?? formatTime)(sentence.startTime)),
    detailRow('言語', formatLanguage(sentence.language)),
  );
  if (presentation.status === 'processing' || presentation.status === 'pending' || presentation.status === 'queued') {
    panel.append(detailRow('進行状況', '文章を整えています'));
  } else if (presentation.status === 'failed' || presentation.status === 'fallback' || presentation.status === 'cancelled') {
    panel.append(detailRow('表示', presentation.status === 'cancelled' ? '整文を中断しました' : '原文を表示しています'));
  }

  const rawId = `${panelId}-raw`;
  const rawRow = detailRow('STT原文', presentation.rawText);
  rawRow.id = rawId;
  rawRow.hidden = true;
  const rawToggle = document.createElement('button');
  rawToggle.type = 'button';
  rawToggle.className = 'secondary-button utterance__action';
  rawToggle.textContent = '原文を見る';
  rawToggle.setAttribute('aria-controls', rawId);
  rawToggle.setAttribute('aria-expanded', 'false');
  rawToggle.addEventListener('click', () => {
    rawRow.hidden = !rawRow.hidden;
    rawToggle.textContent = rawRow.hidden ? '原文を見る' : '原文を閉じる';
    rawToggle.setAttribute('aria-expanded', String(!rawRow.hidden));
  });
  panel.append(rawToggle, rawRow);

  const correction = sentence.correction;
  if (correction?.errorCode) panel.append(detailRow('失敗理由', failureReasonLabel(correction.errorCode)));
  if (correction?.provider) panel.append(detailRow('Provider', safeProviderLabel(correction.provider, correction.model)));
  if (correction?.policyVersion) panel.append(detailRow('整文ポリシー', correction.policyVersion));
  if (correction?.attemptCount) panel.append(detailRow('試行回数', String(correction.attemptCount)));

  if (presentation.uncertainParts.length > 0) {
    const uncertain = document.createElement('div');
    uncertain.className = 'utterance__uncertain';
    const heading = document.createElement('strong');
    heading.textContent = '確認が必要な箇所';
    const list = document.createElement('ul');
    for (const part of deduplicateUncertainParts(presentation.uncertainParts)) {
      const row = document.createElement('li');
      row.textContent = `${part.text}（${uncertainReasonLabel(part.reason)}）`;
      list.append(row);
    }
    uncertain.append(heading, list);
    panel.append(uncertain);
  }

  if (isRetryable(presentation.status)) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'primary-button utterance__action';
    retry.textContent = '整文を再試行';
    retry.disabled = (correction?.attemptCount ?? 0) >= CORRECTION_MAX_ATTEMPTS || !options.onRetryCorrection;
    retry.addEventListener('click', () => options.onRetryCorrection?.(sentence.id));
    panel.append(retry);
  }

  details.append(summary, panel);
  item.append(details);
  return item;
}

export function createRawSegmentElement(
  segment: RawTranscriptSegment,
  index: number,
  total: number,
  timeFormatter: (timestamp: number) => string = formatTime,
): HTMLLIElement {
  const item = document.createElement('li');
  item.className = `transcript-item transcript-item--${transcriptPosition(index, total)}`;
  const text = document.createElement('p');
  text.className = 'utterance__text';
  text.textContent = segment.text;
  const meta = document.createElement('small');
  meta.className = 'utterance__meta';
  meta.textContent = `${timeFormatter(segment.startTime)}・${formatLanguage(segment.language)}`;
  item.append(meta, text);
  return item;
}

function createStateNote(status: CorrectionStatus, uncertainCount: number): HTMLSpanElement {
  const note = document.createElement('span');
  note.className = `utterance__state utterance__state--${status}`;
  note.textContent = uncertainCount > 0 ? `${correctionStatusLabel(status)}・要確認 ${uncertainCount}件` : correctionStatusLabel(status);
  return note;
}

function detailRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'utterance__detail-row';
  const term = document.createElement('strong');
  term.textContent = label;
  const content = document.createElement('p');
  content.textContent = value;
  row.append(term, content);
  return row;
}

function uncertainReasonLabel(reason: CorrectionUncertainReason): string {
  const labels: Record<CorrectionUncertainReason, string> = {
    number: '数字', proper_noun: '固有名詞', technical_term: '技術用語', low_context: '文脈不足', ambiguous: '曖昧な表現',
  };
  return labels[reason];
}

function failureReasonLabel(code: string): string {
  const labels: Record<string, string> = {
    timeout: '整文処理がタイムアウトしました', provider_unavailable: '整文Providerを利用できません',
    invalid_response: '整文結果を安全に確認できませんでした', input_too_long: '発話が整文上限を超えました',
    output_validation_failed: '整文結果の検証に失敗しました', protected_token_mismatch: '保護対象の表記が変化しました',
    queue_full: '整文キューが上限に達しました', cancelled: '整文処理を中断しました',
    stale_result: '古い整文結果を破棄しました', interrupted: '前回の整文処理が中断されました',
    storage_failed: '整文状態を保存できませんでした', max_attempts_reached: '再試行上限に達しました',
  };
  return labels[code] ?? '整文処理を安全に完了できませんでした';
}

function safeProviderLabel(provider: string, model?: string): string {
  if (provider === 'mock') return model ? `Mock（${model}・外部送信なし）` : 'Mock（外部送信なし）';
  return model ? `${provider}（${model}）` : provider;
}

function deduplicateUncertainParts(parts: readonly { text: string; reason: CorrectionUncertainReason }[]) {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = `${part.text}\u0000${part.reason}`;
    if (!part.text.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function isRetryable(status: CorrectionStatus): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'fallback';
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 120);
}

function formatLanguage(language: CompletedSentence['language'] | RawTranscriptSegment['language']): string {
  return language === 'ja' ? '日本語' : 'English';
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}
