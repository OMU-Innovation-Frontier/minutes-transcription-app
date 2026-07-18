import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  calculateNormalizedJapaneseCharacterErrorRate,
  calculateRawCharacterErrorRate,
  calculateRealTimeFactor,
  rateRealTimeFactor,
  type RealTimeFactorRating,
} from '../evaluationHarness.js';
import { inspectPcm16Mono16kWavQuality } from './audioConverter.js';
import { LocalProcessManager, validateExistingFile } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';

const SAMPLE_RATE = 16_000;
const BYTES_PER_FRAME = 2;
const MIN_CHUNK_MS = 1_000;
const MAX_CHUNK_MS = 120_000;

export interface ChunkBoundary {
  index: number;
  startFrame: number;
  endFrame: number;
  startMs: number;
  endMs: number;
  frameCount: number;
  filePath: string;
}

export interface TimestampedSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface RemovedDuplicatePart {
  previousChunkIndex: number;
  currentChunkIndex: number;
  removedText: string;
  reason: 'exactSuffixPrefix' | 'highSimilaritySuffixPrefix';
  similarity: number;
}

export interface DeduplicationResult {
  rawMergedTranscript: string;
  deduplicatedTranscript: string;
  removedDuplicateParts: RemovedDuplicatePart[];
}

export type RecoveryStatus = 'exactRecovered' | 'substantiallyRecovered' | 'partiallyRecovered' | 'missing';

export interface TargetRecovery {
  target: string;
  status: RecoveryStatus;
  similarity: number;
  matchedText: string | null;
  missingNormalizedCharacters: string;
}

export type ChunkEvaluationMode =
  | 'whole-no-timestamps'
  | 'whole-with-timestamps'
  | 'chunk-no-overlap'
  | 'chunk-overlap';

export interface ChunkComparisonCondition {
  label: string;
  evaluationMode: ChunkEvaluationMode;
  chunkDurationMs: number | null;
  overlapDurationMs: number;
  timestamps: boolean;
}

export interface ChunkComparisonRunRecord {
  provider: 'local-whisper';
  model: 'whisper-small-q5_1';
  language: 'ja';
  evaluationMode: ChunkEvaluationMode;
  conditionLabel: string;
  chunkDurationMs: number | null;
  overlapDurationMs: number;
  chunkCount: number;
  audioDurationMs: number;
  processingTimeMs: number;
  realTimeFactor: number;
  realTimeFactorRating: RealTimeFactorRating;
  firstResultTimeMs: null;
  finalResultTimeMs: number;
  normalizedCer: number;
  rawCer: number;
  missingTargetPhrase1: boolean;
  missingTargetPhrase2: boolean;
  bothTargetPhrasesRecovered: boolean;
  targetPhrase1Recovery: TargetRecovery;
  targetPhrase2Recovery: TargetRecovery;
  rawMergedTranscript: string;
  deduplicatedTranscript: string;
  removedDuplicateParts: RemovedDuplicatePart[];
  segmentTimestamps: TimestampedSegment[];
  chunkBoundaries: ChunkBoundary[];
  perChunkProcessingTimeMs: number[];
  processCpuAveragePercent: number | null;
  processCpuPeakPercent: number | null;
  peakWorkingSetBytes: number | null;
  logicalProcessorCount: number;
  threadCount: 4;
  modelSha256: string;
  audioSha256: string;
  whisperArguments: string[][];
  runType: 'initial' | 'warm';
  runNumber: number;
  errorCode: null;
  testedAt: string;
}

export interface ChunkComparisonRunInput {
  condition: ChunkComparisonCondition;
  audioPath: string;
  modelPath: string;
  executablePath: string;
  inputRoot: string;
  modelRoot: string;
  binaryRoot: string;
  temporaryRoot: string;
  spokenReference: string;
  targetPhrases: readonly [string, string];
  audioSha256: string;
  modelSha256: string;
  processManager: LocalProcessManager;
  timeoutMs: number;
  runType: 'initial' | 'warm';
  runNumber: number;
}

export async function splitPcm16Mono16kWav(options: {
  sourcePath: string;
  allowedSourceRoots: readonly string[];
  temporaryRoot: string;
  runDirectoryName: string;
  chunkDurationMs: number;
  overlapDurationMs: number;
}): Promise<{ boundaries: ChunkBoundary[]; runDirectory: string }> {
  validateChunkDurations(options.chunkDurationMs, options.overlapDurationMs);
  const source = await validateExistingFile(
    options.sourcePath,
    options.allowedSourceRoots,
    'local_audio_invalid',
    'The local audio file is missing or outside the configured input directory.',
  );
  await inspectPcm16Mono16kWavQuality(source, options.allowedSourceRoots);
  const temporaryRoot = resolve(options.temporaryRoot);
  if (!isSafeDirectoryName(options.runDirectoryName)) {
    throw new LocalSttError('local_temp_path_invalid', 'The local STT temporary path is invalid.');
  }
  const runDirectory = resolve(temporaryRoot, options.runDirectoryName);
  assertSafeChildPath(temporaryRoot, runDirectory);
  await mkdir(runDirectory, { recursive: false });
  const wav = await readFile(source);
  const data = locatePcmData(wav);
  const totalFrames = data.size / BYTES_PER_FRAME;
  const chunkFrames = millisecondsToFrames(options.chunkDurationMs);
  const overlapFrames = millisecondsToFrames(options.overlapDurationMs);
  const stepFrames = chunkFrames - overlapFrames;
  const boundaries: ChunkBoundary[] = [];
  for (let startFrame = 0, index = 0; startFrame < totalFrames; startFrame += stepFrames, index += 1) {
    const endFrame = Math.min(startFrame + chunkFrames, totalFrames);
    const chunkData = wav.subarray(
      data.offset + startFrame * BYTES_PER_FRAME,
      data.offset + endFrame * BYTES_PER_FRAME,
    );
    const filePath = resolve(runDirectory, `chunk-${String(index + 1).padStart(3, '0')}.wav`);
    assertSafeChildPath(runDirectory, filePath);
    await writeFile(filePath, createPcmWav(chunkData), { flag: 'wx', mode: 0o600 });
    boundaries.push({
      index,
      startFrame,
      endFrame,
      startMs: framesToMilliseconds(startFrame),
      endMs: framesToMilliseconds(endFrame),
      frameCount: endFrame - startFrame,
      filePath,
    });
    if (endFrame === totalFrames) break;
  }
  return { boundaries, runDirectory };
}

export async function removeTemporaryRunDirectory(runDirectory: string, temporaryRoot: string): Promise<void> {
  assertSafeChildPath(resolve(temporaryRoot), resolve(runDirectory));
  await rm(runDirectory, { recursive: true, force: true });
}

export function validateChunkDurations(chunkDurationMs: number, overlapDurationMs: number): void {
  if (!Number.isSafeInteger(chunkDurationMs) || chunkDurationMs < MIN_CHUNK_MS || chunkDurationMs > MAX_CHUNK_MS) {
    throw new LocalSttError('local_chunk_duration_invalid', 'The local STT chunk duration is invalid.');
  }
  if (!Number.isSafeInteger(overlapDurationMs) || overlapDurationMs < 0 || overlapDurationMs >= chunkDurationMs) {
    throw new LocalSttError('local_chunk_overlap_invalid', 'The local STT chunk overlap is invalid.');
  }
  if (millisecondsToFrames(chunkDurationMs) <= millisecondsToFrames(overlapDurationMs)) {
    throw new LocalSttError('local_chunk_overlap_invalid', 'The local STT chunk overlap is invalid.');
  }
}

export function assertSafeChildPath(root: string, candidate: string): void {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const fromRoot = relative(absoluteRoot, absoluteCandidate);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new LocalSttError('local_temp_path_invalid', 'The local STT temporary path is invalid.');
  }
}

export function parseWhisperTimestampOutput(output: string): TimestampedSegment[] {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');
  const segments: TimestampedSegment[] = [];
  for (const line of output.replace(ansiPattern, '').split(/\r?\n/u)) {
    const match = /^\s*\[(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\]\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    const startMs = timestampPartsToMs(match.slice(1, 5));
    const endMs = timestampPartsToMs(match.slice(5, 9));
    if (endMs < startMs) continue;
    const text = match[9] ?? '';
    if (text) segments.push({ startMs, endMs, text });
  }
  return segments;
}

export function deduplicateChunkTranscripts(transcripts: readonly string[]): DeduplicationResult {
  const cleaned = transcripts.map((transcript) => transcript.trim()).filter(Boolean);
  const rawMergedTranscript = cleaned.join(' ');
  if (cleaned.length === 0) return { rawMergedTranscript, deduplicatedTranscript: '', removedDuplicateParts: [] };
  let merged = cleaned[0] ?? '';
  const removedDuplicateParts: RemovedDuplicatePart[] = [];
  for (let index = 1; index < cleaned.length; index += 1) {
    const next = cleaned[index] ?? '';
    const overlap = findConservativeOverlap(merged, next);
    if (!overlap) {
      merged = joinTranscriptParts(merged, next);
      continue;
    }
    removedDuplicateParts.push({
      previousChunkIndex: index - 1,
      currentChunkIndex: index,
      removedText: next.slice(0, overlap.rawPrefixEnd),
      reason: overlap.reason,
      similarity: overlap.similarity,
    });
    merged = joinTranscriptParts(merged, next.slice(overlap.rawPrefixEnd));
  }
  return { rawMergedTranscript, deduplicatedTranscript: merged.trim(), removedDuplicateParts };
}

export function assessTargetRecovery(target: string, transcript: string): TargetRecovery {
  if (transcript.includes(target)) {
    return { target, status: 'exactRecovered', similarity: 1, matchedText: target, missingNormalizedCharacters: '' };
  }
  const normalizedTarget = normalizeJapanese(target);
  const mappedTranscript = normalizeWithMap(transcript);
  const exactIndex = mappedTranscript.normalized.indexOf(normalizedTarget);
  if (exactIndex >= 0) {
    const matchedText = rawSliceFromNormalizedRange(mappedTranscript, exactIndex, exactIndex + normalizedTarget.length);
    return { target, status: 'substantiallyRecovered', similarity: 1, matchedText, missingNormalizedCharacters: '' };
  }
  const best = findBestWindow(normalizedTarget, mappedTranscript.normalized);
  if (!best || best.similarity < 0.45) {
    return { target, status: 'missing', similarity: best?.similarity ?? 0, matchedText: best ? rawSliceFromNormalizedRange(mappedTranscript, best.start, best.end) : null, missingNormalizedCharacters: normalizedTarget };
  }
  const matchedText = rawSliceFromNormalizedRange(mappedTranscript, best.start, best.end);
  const missingNormalizedCharacters = missingCharacters(normalizedTarget, mappedTranscript.normalized.slice(best.start, best.end));
  return {
    target,
    status: best.similarity >= 0.82 ? 'substantiallyRecovered' : 'partiallyRecovered',
    similarity: best.similarity,
    matchedText,
    missingNormalizedCharacters,
  };
}

export async function runChunkComparisonCondition(input: ChunkComparisonRunInput): Promise<ChunkComparisonRunRecord> {
  const audioPath = await validateExistingFile(input.audioPath, [input.inputRoot], 'local_audio_invalid', 'The local benchmark audio is invalid.');
  const modelPath = await validateExistingFile(input.modelPath, [input.modelRoot], 'local_model_missing', 'The local benchmark model is invalid.');
  await validateExistingFile(input.executablePath, [input.binaryRoot], 'local_executable_missing', 'The local benchmark executable is invalid.');
  const wav = await inspectPcm16Mono16kWavQuality(audioPath, [input.inputRoot]);
  let runDirectory: string | undefined;
  let boundaries: ChunkBoundary[];
  if (input.condition.chunkDurationMs === null) {
    boundaries = [{
      index: 0,
      startFrame: 0,
      endFrame: wav.dataBytes / BYTES_PER_FRAME,
      startMs: 0,
      endMs: wav.durationMs,
      frameCount: wav.dataBytes / BYTES_PER_FRAME,
      filePath: audioPath,
    }];
  } else {
    const split = await splitPcm16Mono16kWav({
      sourcePath: audioPath,
      allowedSourceRoots: [input.inputRoot],
      temporaryRoot: input.temporaryRoot,
      runDirectoryName: `${safeLabel(input.condition.label)}-${input.runType}-${input.runNumber}-${Date.now()}`,
      chunkDurationMs: input.condition.chunkDurationMs,
      overlapDurationMs: input.condition.overlapDurationMs,
    });
    boundaries = split.boundaries;
    runDirectory = split.runDirectory;
  }
  try {
    const transcripts: string[] = [];
    const timestampedSegments: TimestampedSegment[] = [];
    const processingTimes: number[] = [];
    const argumentsByChunk: string[][] = [];
    let cpuWeightedTotal = 0;
    let cpuWeight = 0;
    let cpuPeak: number | undefined;
    let peakMemory: number | undefined;
    let logicalProcessors: number | undefined;
    for (const boundary of boundaries) {
      const args = [
        '--model', modelPath,
        '--file', boundary.filePath,
        '--language', 'ja',
        '--threads', '4',
      ];
      if (!input.condition.timestamps) args.push('--no-timestamps');
      args.push('--no-prints', '--no-gpu');
      const result = await input.processManager.run({
        executablePath: input.executablePath,
        allowedExecutableRoots: [input.binaryRoot],
        arguments: args,
        timeoutMs: input.timeoutMs,
      });
      argumentsByChunk.push(args);
      processingTimes.push(result.totalProcessingMs);
      const parsedSegments = input.condition.timestamps ? parseWhisperTimestampOutput(result.stdout) : [];
      if (input.condition.timestamps && parsedSegments.length === 0 && result.stdout.trim()) {
        throw new LocalSttError('local_timestamp_parse_failed', 'whisper.cpp timestamp output could not be parsed safely.');
      }
      const transcript = input.condition.timestamps
        ? parsedSegments.map((segment) => segment.text).join(' ')
        : result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).join(' ');
      transcripts.push(transcript);
      for (const segment of parsedSegments) {
        timestampedSegments.push({
          startMs: boundary.startMs + segment.startMs,
          endMs: boundary.startMs + segment.endMs,
          text: segment.text,
        });
      }
      if (result.cpuAveragePercent !== undefined) {
        cpuWeightedTotal += result.cpuAveragePercent * result.totalProcessingMs;
        cpuWeight += result.totalProcessingMs;
      }
      if (result.cpuPeakPercent !== undefined) cpuPeak = Math.max(cpuPeak ?? 0, result.cpuPeakPercent);
      if (result.peakMemoryBytes !== undefined) peakMemory = Math.max(peakMemory ?? 0, result.peakMemoryBytes);
      logicalProcessors ??= result.logicalProcessorCount;
    }
    const merge = deduplicateChunkTranscripts(transcripts);
    const evaluationTranscript = merge.deduplicatedTranscript;
    const target1 = assessTargetRecovery(input.targetPhrases[0], evaluationTranscript);
    const target2 = assessTargetRecovery(input.targetPhrases[1], evaluationTranscript);
    const processingTimeMs = processingTimes.reduce((total, value) => total + value, 0);
    const realTimeFactor = calculateRealTimeFactor(processingTimeMs, wav.durationSeconds);
    const recovered = (status: RecoveryStatus): boolean => status === 'exactRecovered' || status === 'substantiallyRecovered';
    return {
      provider: 'local-whisper',
      model: 'whisper-small-q5_1',
      language: 'ja',
      evaluationMode: input.condition.evaluationMode,
      conditionLabel: input.condition.label,
      chunkDurationMs: input.condition.chunkDurationMs,
      overlapDurationMs: input.condition.overlapDurationMs,
      chunkCount: boundaries.length,
      audioDurationMs: wav.durationMs,
      processingTimeMs,
      realTimeFactor,
      realTimeFactorRating: rateRealTimeFactor(realTimeFactor),
      firstResultTimeMs: null,
      finalResultTimeMs: processingTimeMs,
      normalizedCer: calculateNormalizedJapaneseCharacterErrorRate(input.spokenReference, evaluationTranscript),
      rawCer: calculateRawCharacterErrorRate(input.spokenReference, evaluationTranscript),
      missingTargetPhrase1: target1.status === 'missing',
      missingTargetPhrase2: target2.status === 'missing',
      bothTargetPhrasesRecovered: recovered(target1.status) && recovered(target2.status),
      targetPhrase1Recovery: target1,
      targetPhrase2Recovery: target2,
      rawMergedTranscript: merge.rawMergedTranscript,
      deduplicatedTranscript: evaluationTranscript,
      removedDuplicateParts: merge.removedDuplicateParts,
      segmentTimestamps: timestampedSegments,
      chunkBoundaries: boundaries,
      perChunkProcessingTimeMs: processingTimes,
      processCpuAveragePercent: cpuWeight > 0 ? cpuWeightedTotal / cpuWeight : null,
      processCpuPeakPercent: cpuPeak ?? null,
      peakWorkingSetBytes: peakMemory ?? null,
      logicalProcessorCount: logicalProcessors ?? availableParallelism(),
      threadCount: 4,
      modelSha256: input.modelSha256,
      audioSha256: input.audioSha256,
      whisperArguments: argumentsByChunk,
      runType: input.runType,
      runNumber: input.runNumber,
      errorCode: null,
      testedAt: new Date().toISOString(),
    };
  } finally {
    if (runDirectory) await removeTemporaryRunDirectory(runDirectory, input.temporaryRoot);
  }
}

export async function sha256File(filePath: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function locatePcmData(wav: Buffer): { offset: number; size: number } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new LocalSttError('local_wav_format_unsupported', 'The WAV file must be uncompressed 16-bit, 16 kHz, mono PCM.');
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) break;
    if (id === 'data') return { offset: start, size };
    offset = start + size + (size % 2);
  }
  throw new LocalSttError('local_wav_format_unsupported', 'The WAV file must be uncompressed 16-bit, 16 kHz, mono PCM.');
}

function createPcmWav(data: Buffer): Buffer {
  const output = Buffer.alloc(44 + data.length);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + data.length, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * BYTES_PER_FRAME, 28);
  output.writeUInt16LE(BYTES_PER_FRAME, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(data.length, 40);
  data.copy(output, 44);
  return output;
}

function millisecondsToFrames(milliseconds: number): number {
  return Math.round(milliseconds * SAMPLE_RATE / 1_000);
}

function framesToMilliseconds(frames: number): number {
  return frames / SAMPLE_RATE * 1_000;
}

function isSafeDirectoryName(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value) && value !== '.' && value !== '..';
}

function safeLabel(value: string): string {
  const label = value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return label || 'condition';
}

function timestampPartsToMs(parts: string[]): number {
  const [hours, minutes, seconds, milliseconds] = parts.map(Number);
  return (((hours ?? 0) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)) * 1_000 + (milliseconds ?? 0);
}

function joinTranscriptParts(left: string, right: string): string {
  const a = left.trimEnd();
  const b = right.trimStart();
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

function findConservativeOverlap(previous: string, next: string): {
  rawPrefixEnd: number;
  reason: RemovedDuplicatePart['reason'];
  similarity: number;
} | null {
  const previousMapped = normalizeWithMap(previous);
  const nextMapped = normalizeWithMap(next);
  const maxLength = Math.min(160, previousMapped.normalized.length, nextMapped.normalized.length);
  for (let length = maxLength; length >= 8; length -= 1) {
    if (previousMapped.normalized.slice(-length) === nextMapped.normalized.slice(0, length)) {
      return { rawPrefixEnd: rawPrefixEnd(nextMapped, length), reason: 'exactSuffixPrefix', similarity: 1 };
    }
  }
  for (let length = maxLength; length >= 12; length -= 1) {
    const left = previousMapped.normalized.slice(-length);
    const right = nextMapped.normalized.slice(0, length);
    const similarity = stringSimilarity(left, right);
    if (similarity >= 0.92) {
      return { rawPrefixEnd: rawPrefixEnd(nextMapped, length), reason: 'highSimilaritySuffixPrefix', similarity };
    }
  }
  return null;
}

function normalizeJapanese(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\s]+/gu, '');
}

function normalizeWithMap(raw: string): { raw: string; normalized: string; rawIndexes: number[] } {
  let normalized = '';
  const rawIndexes: number[] = [];
  for (let index = 0; index < raw.length;) {
    const codePoint = raw.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const canonical = character.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\s]+/gu, '');
    for (const canonicalCharacter of canonical) {
      normalized += canonicalCharacter;
      rawIndexes.push(index);
    }
    index += character.length;
  }
  return { raw, normalized, rawIndexes };
}

function rawPrefixEnd(mapped: ReturnType<typeof normalizeWithMap>, normalizedLength: number): number {
  const rawStart = mapped.rawIndexes[normalizedLength - 1];
  if (rawStart === undefined) return 0;
  const codePoint = mapped.raw.codePointAt(rawStart);
  return rawStart + (codePoint !== undefined && codePoint > 0xFFFF ? 2 : 1);
}

function rawSliceFromNormalizedRange(mapped: ReturnType<typeof normalizeWithMap>, start: number, end: number): string {
  const rawStart = mapped.rawIndexes[start];
  const rawEndStart = mapped.rawIndexes[end - 1];
  if (rawStart === undefined || rawEndStart === undefined) return '';
  const codePoint = mapped.raw.codePointAt(rawEndStart);
  return mapped.raw.slice(rawStart, rawEndStart + (codePoint !== undefined && codePoint > 0xFFFF ? 2 : 1));
}

function findBestWindow(target: string, transcript: string): { start: number; end: number; similarity: number } | null {
  if (!target || !transcript) return null;
  const minimum = Math.max(1, Math.floor(target.length * 0.65));
  const maximum = Math.min(transcript.length, Math.ceil(target.length * 1.15));
  let best: { start: number; end: number; similarity: number } | null = null;
  for (let length = minimum; length <= maximum; length += 1) {
    for (let start = 0; start + length <= transcript.length; start += 1) {
      const similarity = stringSimilarity(target, transcript.slice(start, start + length));
      if (!best || similarity > best.similarity) best = { start, end: start + length, similarity };
    }
  }
  return best;
}

function missingCharacters(reference: string, candidate: string): string {
  let candidateIndex = 0;
  let missing = '';
  for (const character of reference) {
    const found = candidate.indexOf(character, candidateIndex);
    if (found < 0) missing += character;
    else candidateIndex = found + 1;
  }
  return missing;
}

function stringSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const denominator = Math.max([...left].length, [...right].length);
  if (denominator === 0) return 1;
  return 1 - levenshtein([...left], [...right]) / denominator;
}

function levenshtein(left: string[], right: string[]): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? left.length;
}
