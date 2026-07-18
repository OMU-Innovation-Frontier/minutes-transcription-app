import { SentenceAssembler } from './sentenceAssembler';
import type { TranscriptCorrection } from '../../shared/correction';
import type {
  CompletedSentence,
  RawTranscriptSegment,
  TranscriptUpdate,
  TranscriptionLanguage,
} from './types';

export interface TranscriptSegment {
  id: string;
  startTime: number;
  endTime?: number;
  language: TranscriptionLanguage;
  rawText: string;
  isFinal: boolean;
  provider: string;
  createdAt: string;
  confidence?: number;
}

export interface TranscriptSnapshot {
  sessionId: string | null;
  finalSegments: readonly TranscriptSegment[];
  rawSegments: readonly RawTranscriptSegment[];
  completedSentences: readonly CompletedSentence[];
  interim: TranscriptSegment | null;
  interimDisplayText: string;
}

export interface TranscriptStoreOptions {
  silenceMs?: number;
  maxDurationMs?: number;
  maxCharsJa?: number;
  maxCharsEn?: number;
  now?: () => number;
  setTimeout?: typeof window.setTimeout;
  clearTimeout?: typeof window.clearTimeout;
  createId?: () => string;
  onChange?: () => void;
}

export class TranscriptStore {
  private sessionId: string | null = null;
  private finalSegments: TranscriptSegment[] = [];
  private rawSegments: RawTranscriptSegment[] = [];
  private completedSentences: CompletedSentence[] = [];
  private interim: TranscriptSegment | null = null;
  private lastSequence = -1;
  private readonly finalIds = new Set<string>();
  private readonly revisions = new Map<string, number>();
  private readonly assembler: SentenceAssembler;
  private readonly now: () => number;

  constructor(private readonly options: TranscriptStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.assembler = new SentenceAssembler({
      silenceMs: options.silenceMs ?? envNumber('VITE_SENTENCE_SILENCE_MS', 1_200),
      maxDurationMs: options.maxDurationMs ?? envNumber('VITE_SENTENCE_MAX_DURATION_MS', 20_000),
      maxCharsJa: options.maxCharsJa ?? envNumber('VITE_SENTENCE_MAX_CHARS_JA', 120),
      maxCharsEn: options.maxCharsEn ?? envNumber('VITE_SENTENCE_MAX_CHARS_EN', 300),
      now: options.now,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
      createId: options.createId,
      onSentence: (sentence) => {
        this.completedSentences = [...this.completedSentences, sentence];
        this.options.onChange?.();
      },
    });
  }

  startSession(sessionId: string): void {
    this.assembler.clear();
    this.sessionId = sessionId;
    this.interim = null;
    this.lastSequence = -1;
    this.finalIds.clear();
    this.revisions.clear();
  }

  clear(): void {
    this.assembler.clear();
    this.finalSegments = [];
    this.rawSegments = [];
    this.completedSentences = [];
    this.interim = null;
  }

  apply(update: TranscriptUpdate): boolean {
    if (update.sessionId !== this.sessionId || !update.text.trim()) return false;
    const segmentKey = `${update.sessionId}:${update.segmentId}`;
    if (update.sequence <= this.lastSequence || this.finalIds.has(segmentKey)) return false;
    const previousRevision = this.revisions.get(update.segmentId) ?? -1;
    if (update.revision <= previousRevision) return false;

    this.lastSequence = update.sequence;
    this.revisions.set(update.segmentId, update.revision);
    const segment = toSegment(update);
    const raw = toRawSegment(update);
    this.upsertRaw(raw);

    if (update.isFinal) {
      this.finalIds.add(segmentKey);
      this.finalSegments = [...this.finalSegments, segment];
      if (this.interim?.id === segmentKey) this.interim = null;
      this.assembler.add(raw);
      return true;
    }
    this.interim = segment;
    return true;
  }

  finalizeInterim(): boolean {
    if (!this.promoteInterim()) return false;
    this.assembler.flush('recording_stopped');
    return true;
  }

  finalizeRecording(): boolean {
    const hadInterim = this.finalizeInterim();
    const sentence = this.assembler.flush('recording_stopped');
    return hadInterim || Boolean(sentence);
  }

  finalizeSentenceManually(): boolean {
    const promoted = this.promoteInterim();
    return Boolean(this.assembler.flush('manual')) || promoted;
  }

  applyCorrection(sessionId: string, sentenceId: string, correction: TranscriptCorrection): boolean {
    const index = this.completedSentences.findIndex((sentence) => sentence.sessionId === sessionId && sentence.id === sentenceId);
    const sentence = this.completedSentences[index];
    if (!sentence || correction.rawText !== sentence.rawText) return false;
    if (!sameIds(correction.sourceSegmentIds, sentence.rawSegmentIds)) return false;
    if (sentence.correction?.status === 'completed') return false;
    if (sentence.correction && JSON.stringify(sentence.correction) === JSON.stringify(correction)) return false;
    this.completedSentences = this.completedSentences.map((item, itemIndex) => itemIndex === index
      ? { ...item, correction: cloneCorrection(correction) }
      : item);
    this.options.onChange?.();
    return true;
  }

  snapshot(): TranscriptSnapshot {
    const interimText = this.interim?.rawText.trim() ?? '';
    const separator = this.interim?.language === 'en-US' && this.assembler.pendingText ? ' ' : '';
    return {
      sessionId: this.sessionId,
      finalSegments: this.finalSegments,
      rawSegments: this.rawSegments,
      completedSentences: this.completedSentences,
      interim: this.interim,
      interimDisplayText: `${this.assembler.pendingText}${separator}${interimText}`,
    };
  }

  private upsertRaw(segment: RawTranscriptSegment): void {
    const index = this.rawSegments.findIndex((item) => item.id === segment.id);
    if (index < 0) this.rawSegments = [...this.rawSegments, segment];
    else this.rawSegments = this.rawSegments.map((item, itemIndex) => itemIndex === index ? segment : item);
  }

  private promoteInterim(): boolean {
    if (!this.interim || this.finalIds.has(this.interim.id)) return false;
    const endTime = this.interim.endTime ?? this.now();
    const finalized = { ...this.interim, isFinal: true, endTime };
    this.finalIds.add(finalized.id);
    this.finalSegments = [...this.finalSegments, finalized];
    const raw = this.rawSegments.find((segment) => segment.id === finalized.id);
    if (raw) {
      const finalRaw = { ...raw, isFinal: true, endTime };
      this.upsertRaw(finalRaw);
      this.assembler.add(finalRaw);
    }
    this.interim = null;
    return true;
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneCorrection(correction: TranscriptCorrection): TranscriptCorrection {
  return {
    ...correction,
    changes: correction.changes.map((change) => ({ ...change })),
    uncertainParts: correction.uncertainParts.map((part) => ({ ...part })),
    sourceSegmentIds: [...correction.sourceSegmentIds],
  };
}

function toSegment(update: TranscriptUpdate): TranscriptSegment {
  return {
    id: `${update.sessionId}:${update.segmentId}`,
    startTime: update.startTime,
    endTime: update.endTime,
    language: update.language,
    rawText: update.text.trim(),
    isFinal: update.isFinal,
    provider: update.provider,
    createdAt: update.createdAt,
    confidence: update.confidence,
  };
}

function toRawSegment(update: TranscriptUpdate): RawTranscriptSegment {
  return {
    id: `${update.sessionId}:${update.segmentId}`,
    sessionId: update.sessionId,
    text: update.text.trim(),
    isFinal: update.isFinal,
    startTime: update.startTime,
    endTime: update.endTime,
    language: update.language === 'ja-JP' ? 'ja' : 'en',
    provider: update.provider,
    revision: update.revision,
  };
}

function envNumber(name: keyof ImportMetaEnv, fallback: number): number {
  const value = Number(import.meta.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
