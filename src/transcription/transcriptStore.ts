import { SentenceAssembler } from './sentenceAssembler';
import { isSpeakerName } from '../../shared/sonix';
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
  private readonly speakerNames = new Map<string, string>();
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

  restoreSentences(sentences: readonly CompletedSentence[]): void {
    this.clear();
    for (const { speakerLabel, speakerName } of sentences) {
      if (speakerLabel && speakerName) this.speakerNames.set(speakerLabel, speakerName);
    }
    this.completedSentences = structuredClone([...sentences]);
    this.rawSegments = sentences.map((sentence) => ({
      id: sentence.id, sessionId: sentence.sessionId, text: sentence.rawText,
      isFinal: true, startTime: sentence.startTime, endTime: sentence.endTime,
      language: sentence.language, provider: 'recovered', revision: sentence.revision,
      ...(sentence.speakerLabel ? { speakerLabel: sentence.speakerLabel } : {}),
    }));
  }

  clear(): void {
    this.assembler.clear();
    this.finalSegments = [];
    this.rawSegments = [];
    this.completedSentences = [];
    this.speakerNames.clear();
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
      if (raw.speakerLabel) {
        this.assembler.flush('recording_stopped');
        this.completedSentences = [...this.completedSentences, {
          id: raw.id, sessionId: raw.sessionId, rawSegmentIds: [raw.id], rawText: raw.text, displayText: raw.text,
          revision: raw.revision, language: raw.language, startTime: raw.startTime, endTime: raw.endTime ?? raw.startTime,
          completionReason: 'recording_stopped', speakerLabel: raw.speakerLabel,
        }];
      } else this.assembler.add(raw);
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
    if (correction.segmentId !== undefined && correction.segmentId !== sentence.id) return false;
    if (correction.revision !== undefined && correction.revision !== sentence.revision) return false;
    const current = sentence.correction;
    if (current?.status === 'completed' || current?.status === 'succeeded') return false;
    if (current) {
      const currentAttempt = current.attemptCount ?? 0;
      const incomingAttempt = correction.attemptCount ?? currentAttempt;
      if (incomingAttempt < currentAttempt) return false;
      if (incomingAttempt === currentAttempt) {
        if (current.requestId && correction.requestId && current.requestId !== correction.requestId) return false;
        if (statusRank(correction.status) <= statusRank(current.status)) return false;
      }
    }
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
      rawSegments: this.speakerNames.size ? this.rawSegments.map(segment => this.withSpeakerName(segment)) : this.rawSegments,
      completedSentences: this.speakerNames.size ? this.completedSentences.map(sentence => this.withSpeakerName(sentence)) : this.completedSentences,
      interim: this.interim,
      interimDisplayText: `${this.assembler.pendingText}${separator}${interimText}`,
    };
  }

  confirmSpeakerName(speakerLabel: string, name: string): boolean {
    if (speakerLabel === '話者不明' || !isSpeakerName(name)
      || !this.completedSentences.some(sentence => sentence.speakerLabel === speakerLabel)) return false;
    this.speakerNames.set(speakerLabel, name);
    this.options.onChange?.();
    return true;
  }

  private withSpeakerName<T extends { speakerLabel?: string }>(segment: T): T {
    const speakerName = segment.speakerLabel && this.speakerNames.get(segment.speakerLabel);
    return speakerName ? { ...segment, speakerName } : segment;
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

function statusRank(status: TranscriptCorrection['status']): number {
  const ranks: Record<TranscriptCorrection['status'], number> = {
    disabled: 4,
    queued: 1,
    pending: 2,
    processing: 2,
    succeeded: 4,
    completed: 4,
    failed: 4,
    cancelled: 4,
    skipped: 4,
    fallback: 4,
  };
  return ranks[status];
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
    ...(update.speakerLabel ? { speakerLabel: update.speakerLabel } : {}),
    revision: update.revision,
  };
}

function envNumber(name: keyof ImportMetaEnv, fallback: number): number {
  const value = Number(import.meta.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
