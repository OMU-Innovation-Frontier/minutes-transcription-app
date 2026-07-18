import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerSpeechToTextProvider, SttEvaluationRecord } from './types.js';

export interface SttEvaluationInput {
  provider: ServerSpeechToTextProvider;
  model: string;
  sessionId: string;
  language: 'ja' | 'en';
  mimeType?: string;
  /** @deprecated Use mimeType. Retained for existing benchmark fixtures. */
  audioFormat?: string;
  sampleRate?: number;
  audioDurationSeconds: number;
  chunks: Uint8Array[];
  groundTruthTranscript?: string;
  hotwords?: string[];
  estimatedCostUsd?: number;
}

export async function evaluateSttProvider(input: SttEvaluationInput, now: () => number = Date.now): Promise<SttEvaluationRecord> {
  const startedAt = now();
  let firstPartialLatencyMs: number | undefined;
  let finalLatencyMs: number | undefined;
  let errorCode: string | undefined;
  const segments = new Map<string, { text: string; isFinal: boolean; startTime: number }>();
  input.provider.onTranscript((result) => {
    segments.set(result.segmentId, {
      text: result.text,
      isFinal: result.isFinal,
      startTime: result.startTime,
    });
    if (result.isFinal) finalLatencyMs ??= now() - startedAt;
    else firstPartialLatencyMs ??= now() - startedAt;
  });
  input.provider.onError((error) => { errorCode ??= error.code; });
  try {
    await input.provider.startSession({
      sessionId: input.sessionId,
      language: input.language,
      mimeType: input.mimeType ?? input.audioFormat ?? 'application/octet-stream',
      sampleRate: input.sampleRate,
      hotwords: input.hotwords,
    });
    for (let sequence = 0; sequence < input.chunks.length; sequence += 1) {
      await input.provider.sendAudio({
        sessionId: input.sessionId,
        sequence,
        audio: input.chunks[sequence] ?? new Uint8Array(),
      });
    }
    await input.provider.stopSession(input.sessionId);
  } catch (error) {
    errorCode = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
  } finally {
    await input.provider.closeSession(input.sessionId);
  }
  const transcript = [...segments.values()]
    .filter((segment) => segment.isFinal)
    .sort((left, right) => left.startTime - right.startTime)
    .map((segment) => segment.text)
    .join(' ')
    .trim();
  const totalProcessingMs = now() - startedAt;
  const characterErrorRate = input.groundTruthTranscript === undefined
    ? undefined
    : calculateCharacterErrorRate(input.groundTruthTranscript, transcript);
  const wordErrorRate = input.groundTruthTranscript === undefined || input.language !== 'en'
    ? undefined
    : calculateWordErrorRate(input.groundTruthTranscript, transcript);
  const hotwordAccuracy = input.hotwords?.length
    ? calculateHotwordAccuracy(input.hotwords, transcript)
    : undefined;
  return {
    provider: input.provider.id,
    model: input.model,
    language: input.language,
    audioDurationSeconds: input.audioDurationSeconds,
    transcript,
    characterErrorRate,
    wordErrorRate,
    hotwordAccuracy,
    firstPartialLatencyMs,
    finalLatencyMs,
    totalProcessingMs,
    errorCode,
    estimatedCostUsd: input.estimatedCostUsd,
    testedAt: new Date().toISOString(),
  };
}

export async function appendSttEvaluationRecord(filePath: string, record: SttEvaluationRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function calculateCharacterErrorRate(reference: string, hypothesis: string): number {
  const expected = [...normalizeForCharacters(reference)];
  const actual = [...normalizeForCharacters(hypothesis)];
  if (expected.length === 0) return actual.length === 0 ? 0 : 1;
  return levenshteinDistance(expected, actual) / expected.length;
}

export function calculateRawCharacterErrorRate(reference: string, hypothesis: string): number {
  return calculateSequenceErrorRate([...reference], [...hypothesis]);
}

export function calculateNormalizedJapaneseCharacterErrorRate(reference: string, hypothesis: string): number {
  return calculateSequenceErrorRate(
    [...normalizeEvaluationText(reference).replace(/\s+/gu, '')],
    [...normalizeEvaluationText(hypothesis).replace(/\s+/gu, '')],
  );
}

export function calculateNormalizedEnglishWordErrorRate(reference: string, hypothesis: string): number {
  const expected = splitNormalizedWords(reference);
  const actual = splitNormalizedWords(hypothesis);
  return calculateSequenceErrorRate(expected, actual);
}

export function calculateWordErrorRate(reference: string, hypothesis: string): number {
  const expected = normalizeForWords(reference);
  const actual = normalizeForWords(hypothesis);
  if (expected.length === 0) return actual.length === 0 ? 0 : 1;
  return levenshteinDistance(expected, actual) / expected.length;
}

export function calculateHotwordAccuracy(hotwords: readonly string[], transcript: string): number {
  if (hotwords.length === 0) return 1;
  const normalizedTranscript = transcript.normalize('NFKC').toLocaleLowerCase();
  const matched = hotwords.filter((hotword) =>
    normalizedTranscript.includes(hotword.normalize('NFKC').toLocaleLowerCase()),
  ).length;
  return matched / hotwords.length;
}

export function calculateRealTimeFactor(totalProcessingMs: number, audioDurationSeconds: number): number {
  if (!Number.isFinite(totalProcessingMs) || totalProcessingMs < 0) {
    throw new RangeError('totalProcessingMs must be a non-negative finite number');
  }
  if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) {
    throw new RangeError('audioDurationSeconds must be a positive finite number');
  }
  return totalProcessingMs / 1_000 / audioDurationSeconds;
}

export type RealTimeFactorRating = 'fast' | 'realtime-candidate' | 'slower-than-realtime';

export function rateRealTimeFactor(realTimeFactor: number): RealTimeFactorRating {
  if (!Number.isFinite(realTimeFactor) || realTimeFactor < 0) {
    throw new RangeError('realTimeFactor must be a non-negative finite number');
  }
  if (realTimeFactor <= 0.5) return 'fast';
  if (realTimeFactor <= 1) return 'realtime-candidate';
  return 'slower-than-realtime';
}

function normalizeForCharacters(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '');
}

function normalizeForWords(value: string): string[] {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase();
  return normalized ? normalized.split(/\s+/u) : [];
}

function normalizeEvaluationText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\p{P}+/gu, '');
}

function splitNormalizedWords(value: string): string[] {
  const normalized = normalizeEvaluationText(value).trim();
  return normalized ? normalized.split(/\s+/u) : [];
}

function calculateSequenceErrorRate<T>(expected: readonly T[], actual: readonly T[]): number {
  if (expected.length === 0) return actual.length === 0 ? 0 : 1;
  return levenshteinDistance(expected, actual) / expected.length;
}

function levenshteinDistance<T>(left: readonly T[], right: readonly T[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = (previous[rightIndex - 1] ?? 0)
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}
