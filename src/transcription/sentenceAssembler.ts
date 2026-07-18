import type {
  CompletedSentence,
  RawTranscriptSegment,
  SentenceCompletionReason,
  TranscriptLanguage,
} from './types';

export interface SentenceAssemblerOptions {
  silenceMs: number;
  maxDurationMs: number;
  maxCharsJa: number;
  maxCharsEn: number;
  now?: () => number;
  setTimeout?: typeof window.setTimeout;
  clearTimeout?: typeof window.clearTimeout;
  createId?: () => string;
  onSentence: (sentence: CompletedSentence) => void;
}

const ENGLISH_ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'vs.', 'etc.', 'e.g.', 'i.e.', 'a.m.', 'p.m.',
]);

const JAPANESE_SHORT_CONTINUATION = /^(?:しています|しました|します|でした|です|ません|と思います|ということです|になります|なります|ください)/u;
const JAPANESE_SHORT_CONTINUATION_MAX_CHARS = 20;

export class SentenceAssembler {
  private readonly segments: RawTranscriptSegment[] = [];
  private readonly now: () => number;
  private readonly scheduleTimeout: typeof window.setTimeout;
  private readonly cancelTimeout: typeof window.clearTimeout;
  private readonly createId: () => string;
  private readonly mergeBoundaries = new Set<number>();
  private timer: number | undefined;
  private lastSegmentAt = 0;
  private punctuationPending = false;

  constructor(private readonly options: SentenceAssemblerOptions) {
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.setTimeout ?? window.setTimeout.bind(window);
    this.cancelTimeout = options.clearTimeout ?? window.clearTimeout.bind(window);
    this.createId = options.createId ?? (() => globalThis.crypto?.randomUUID?.() ?? `sentence-${this.now()}`);
  }

  get pendingText(): string {
    return joinDisplayText(this.segments.map((segment) => segment.text), this.segments[0]?.language ?? 'ja', this.mergeBoundaries);
  }

  add(segment: RawTranscriptSegment): CompletedSentence | null {
    if (!segment.isFinal || !segment.text.trim()) return null;
    if (this.punctuationPending) {
      const previous = this.segments.at(-1);
      if (previous && this.shouldMergeShortContinuation(previous, segment)) {
        this.cancelTimeout(this.timer);
        this.timer = undefined;
        this.punctuationPending = false;
        this.mergeBoundaries.add(this.segments.length);
      } else {
        const completed = this.complete('punctuation');
        return this.add(segment) ?? completed;
      }
    }
    this.segments.push(segment);
    this.lastSegmentAt = this.now();
    const text = this.pendingText;
    const duration = (segment.endTime ?? this.now()) - (this.segments[0]?.startTime ?? this.now());
    if (hasSentenceEnding(text, segment.language)) {
      if (segment.language !== 'ja') return this.complete('punctuation');
      this.punctuationPending = true;
      this.schedulePunctuationCompletion();
      return null;
    }
    if (text.length >= this.maxChars(segment.language)) return this.complete('max_length');
    if (duration >= this.options.maxDurationMs) return this.complete('max_duration');
    this.scheduleCompletion();
    return null;
  }

  flush(reason: Extract<SentenceCompletionReason, 'manual' | 'recording_stopped' | 'silence' | 'max_duration'>): CompletedSentence | null {
    return this.complete(this.punctuationPending ? 'punctuation' : reason);
  }

  clear(): void {
    this.cancelTimeout(this.timer);
    this.timer = undefined;
    this.punctuationPending = false;
    this.mergeBoundaries.clear();
    this.segments.length = 0;
  }

  private schedulePunctuationCompletion(): void {
    this.cancelTimeout(this.timer);
    this.timer = this.scheduleTimeout(() => {
      this.timer = undefined;
      if (this.punctuationPending) this.complete('punctuation');
    }, this.options.silenceMs);
  }

  private scheduleCompletion(): void {
    this.cancelTimeout(this.timer);
    const first = this.segments[0];
    if (!first) return;
    const untilSilence = Math.max(0, this.options.silenceMs - (this.now() - this.lastSegmentAt));
    const untilMaxDuration = Math.max(0, first.startTime + this.options.maxDurationMs - this.now());
    this.timer = this.scheduleTimeout(() => {
      const elapsed = this.now() - first.startTime;
      const silence = this.now() - this.lastSegmentAt;
      if (elapsed >= this.options.maxDurationMs) this.complete('max_duration');
      else if (silence >= this.options.silenceMs) this.complete('silence');
      else this.scheduleCompletion();
    }, Math.min(untilSilence, untilMaxDuration));
  }

  private complete(reason: SentenceCompletionReason): CompletedSentence | null {
    if (this.segments.length === 0) return null;
    this.cancelTimeout(this.timer);
    this.timer = undefined;
    this.punctuationPending = false;
    const segments = this.segments.splice(0);
    const mergeBoundaries = new Set(this.mergeBoundaries);
    this.mergeBoundaries.clear();
    const language = segments[0]?.language ?? 'ja';
    const rawText = joinText(segments.map((segment) => segment.text), language);
    const displayText = joinDisplayText(segments.map((segment) => segment.text), language, mergeBoundaries);
    const last = segments.at(-1);
    const sentence: CompletedSentence = {
      id: this.createId(),
      sessionId: segments[0]?.sessionId ?? '',
      rawSegmentIds: segments.map((segment) => segment.id),
      rawText,
      displayText: toDisplayText(displayText, language),
      language,
      startTime: segments[0]?.startTime ?? this.now(),
      endTime: last?.endTime ?? this.now(),
      completionReason: mergeBoundaries.size > 0 ? 'merged_short_continuation' : reason,
    };
    this.options.onSentence(sentence);
    return sentence;
  }

  private maxChars(language: TranscriptLanguage): number {
    return language === 'ja' ? this.options.maxCharsJa : this.options.maxCharsEn;
  }

  private shouldMergeShortContinuation(previous: RawTranscriptSegment, next: RawTranscriptSegment): boolean {
    if (previous.language !== 'ja' || next.language !== 'ja' || previous.sessionId !== next.sessionId) return false;
    if (!isShortJapaneseContinuation(next.text)) return false;
    const timestampGap = previous.endTime === undefined ? undefined : next.startTime - previous.endTime;
    const processingGap = this.now() - this.lastSegmentAt;
    const gap = timestampGap !== undefined && timestampGap >= 0 ? timestampGap : processingGap;
    return gap >= 0 && gap <= this.options.silenceMs;
  }
}

export function hasSentenceEnding(text: string, language: TranscriptLanguage): boolean {
  const trimmed = text.trim().replace(/[\]）)」』”’]+$/u, '').trim();
  if (language === 'ja') return /[。！？]$/u.test(trimmed);
  if (!/[.!?]$/u.test(trimmed)) return false;
  if (/[!?]$/u.test(trimmed)) return true;
  const lastToken = trimmed.toLowerCase().split(/\s+/u).at(-1) ?? '';
  if (ENGLISH_ABBREVIATIONS.has(lastToken)) return false;
  if (/\b\d+\.\d+$/u.test(trimmed)) return false;
  if (/\b[A-Z]\.$/u.test(trimmed)) return false;
  return true;
}

function joinText(parts: string[], language: TranscriptLanguage): string {
  const trimmed = parts.map((part) => part.trim()).filter(Boolean);
  return language === 'ja' ? trimmed.join('') : trimmed.join(' ');
}

function joinDisplayText(parts: string[], language: TranscriptLanguage, mergeBoundaries: ReadonlySet<number>): string {
  if (language !== 'ja' || mergeBoundaries.size === 0) return joinText(parts, language);
  return parts.reduce((text, part, index) => {
    const trimmed = part.trim();
    if (!trimmed) return text;
    const prefix = mergeBoundaries.has(index) ? removeTrailingJapanesePunctuation(text) : text;
    return `${prefix}${trimmed}`;
  }, '');
}

function removeTrailingJapanesePunctuation(text: string): string {
  return text.replace(/[。！？](?=[\]）)」』”’]*$)/u, '');
}

function isShortJapaneseContinuation(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^[「『（(【[“‘]+/u, '')
    .replace(/[。！？\s\]）)」』”’]+$/u, '');
  return [...normalized].length <= JAPANESE_SHORT_CONTINUATION_MAX_CHARS
    && JAPANESE_SHORT_CONTINUATION.test(normalized);
}

function toDisplayText(rawText: string, language: TranscriptLanguage): string {
  if (hasSentenceEnding(rawText, language)) return rawText;
  return `${rawText}${language === 'ja' ? '。' : '.'}`;
}
