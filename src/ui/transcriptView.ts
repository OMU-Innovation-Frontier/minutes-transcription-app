import type { CorrectionStatus, CorrectionUncertainReason } from '../../shared/correction';
import { sentencePresentation } from '../correction/transcriptPresentation';
import type { CompletedSentence, RawTranscriptSegment } from '../transcription/types';

export type TranscriptPosition = 'latest' | 'previous' | 'past';

export interface TranscriptElementOptions {
  enteringSentenceId?: string;
  timeFormatter?: (timestamp: number) => string;
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
  summary.setAttribute('aria-label', `${formatLanguage(sentence.language)}の発言詳細を表示`);

  const meta = document.createElement('span');
  meta.className = 'utterance__meta';
  const time = document.createElement('time');
  time.textContent = (options.timeFormatter ?? formatTime)(sentence.startTime);
  meta.append(time);
  const stateNote = createStateNote(presentation.status, presentation.uncertainParts.length);
  if (stateNote) meta.append(stateNote);

  const text = document.createElement('span');
  text.className = 'utterance__text';
  text.textContent = presentation.visibleText;
  summary.append(meta, text);

  const panel = document.createElement('div');
  panel.className = 'utterance__details';
  panel.append(
    detailRow('Whisper原文', presentation.rawText),
    detailRow('表示中の文章', presentation.visibleText),
    detailRow('整文状態', correctionStatusLabel(presentation.status)),
    detailRow('発話時刻', (options.timeFormatter ?? formatTime)(sentence.startTime)),
    detailRow('言語', formatLanguage(sentence.language)),
  );
  if (presentation.uncertainParts.length > 0) {
    const uncertain = document.createElement('div');
    uncertain.className = 'utterance__uncertain';
    const heading = document.createElement('strong');
    heading.textContent = '確認が必要な箇所';
    const list = document.createElement('ul');
    for (const part of presentation.uncertainParts) {
      const row = document.createElement('li');
      row.textContent = `${part.text}（${uncertainReasonLabel(part.reason)}）`;
      list.append(row);
    }
    uncertain.append(heading, list);
    panel.append(uncertain);
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

function createStateNote(status: CorrectionStatus, uncertainCount: number): HTMLSpanElement | null {
  let label = '';
  if (status === 'pending') label = '文章を整えています';
  if (status === 'failed') label = '原文を表示しています';
  if (uncertainCount > 0) label = `要確認 ${uncertainCount}件`;
  if (!label) return null;
  const note = document.createElement('span');
  note.className = `utterance__state utterance__state--${status}`;
  note.textContent = label;
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

function correctionStatusLabel(status: CorrectionStatus): string {
  const labels: Record<CorrectionStatus, string> = {
    disabled: '整文なし',
    pending: '整文中（原文を表示）',
    completed: '整文済み',
    failed: '整文できなかったため原文を表示',
    skipped: '整文対象外',
  };
  return labels[status];
}

function uncertainReasonLabel(reason: CorrectionUncertainReason): string {
  const labels: Record<CorrectionUncertainReason, string> = {
    number: '数字',
    proper_noun: '固有名詞',
    technical_term: '技術用語',
    low_context: '文脈不足',
    ambiguous: '曖昧な表現',
  };
  return labels[reason];
}

function formatLanguage(language: CompletedSentence['language'] | RawTranscriptSegment['language']): string {
  return language === 'ja' ? '日本語' : 'English';
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}
