import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, freemem } from 'node:os';
import { dirname } from 'node:path';
import {
  calculateHotwordAccuracy,
  calculateNormalizedEnglishWordErrorRate,
  calculateNormalizedJapaneseCharacterErrorRate,
  calculateRawCharacterErrorRate,
  calculateRealTimeFactor,
  rateRealTimeFactor,
  type RealTimeFactorRating,
} from '../evaluationHarness.js';
import { inspectPcm16Mono16kWavQuality, type LocalAudioConverter, type PcmWavInspection, type PcmWavQualityInspection } from './audioConverter.js';
import type { LocalFileSpeechToTextProvider } from './localSttTypes.js';

export interface LocalBenchmarkCase {
  language: 'ja' | 'en';
  audioPath: string;
  reference: string;
  testCaseId?: string;
  spokenReference?: string | null;
  hotwords: readonly string[];
}

export type TermMatchStatus = 'exactMatch' | 'normalizedMatch' | 'failed';

export interface TermMatchResult {
  term: string;
  status: TermMatchStatus;
}

export interface LocalBenchmarkRunRecord {
  provider: string;
  model: string;
  language: 'ja' | 'en';
  testCaseId: string;
  audioDurationMs: number;
  processingTimeMs: number;
  realTimeFactor: number;
  realTimeFactorRating: RealTimeFactorRating;
  firstResultTimeMs: number | null;
  finalResultTimeMs: number;
  rawTranscript: string;
  scriptReference: string;
  spokenReference: string | null;
  scriptBasedRawCer: number | null;
  scriptBasedNormalizedCer: number | null;
  scriptBasedWer: number | null;
  spokenBasedRawCer: number | null;
  spokenBasedNormalizedCer: number | null;
  spokenBasedWer: number | null;
  cer: number | null;
  cerRaw: number | null;
  cerNormalized: number | null;
  rawCer: number | null;
  normalizedCer: number | null;
  wer: number | null;
  hotwordHitRate: number | null;
  termMatches: readonly TermMatchResult[];
  processCpuAveragePercent: number | null;
  processCpuPeakPercent: number | null;
  peakWorkingSetBytes: number | null;
  logicalProcessorCount: number;
  threadCount: number;
  runType: 'cold' | 'warm';
  runNumber: number;
  modelSha256: string;
  audioSha256: string;
  whisperArguments: readonly string[];
  errorCode: string | null;
  testedAt: string;
  transcript: string;
}

export interface LocalBenchmarkCaseMetadata {
  language: 'ja' | 'en';
  testCaseId: string;
  audioSha256: string;
  wavFormat: PcmWavInspection;
  wavQuality: PcmWavQualityInspection;
  audioDurationMs: number;
  spokenReferenceStatus: 'verified' | 'unverified';
}

export interface LocalBenchmarkSuiteMetadata {
  provider: string;
  model: string;
  modelSha256: string;
  availableMemoryBytesBefore: number;
  logicalProcessorCount: number;
  whisperCppThreads: number;
  whisperCppExecutionArguments: readonly string[];
  processingLocation: 'local';
  audioSentExternally: false;
  coldRunDefinition: string;
  startedAt: string;
  cases: LocalBenchmarkCaseMetadata[];
}

export interface LocalBenchmarkSuiteInput {
  provider: LocalFileSpeechToTextProvider;
  converter: Pick<LocalAudioConverter, 'prepare'>;
  cases: readonly LocalBenchmarkCase[];
  modelPath: string;
  resultsJsonlPath: string;
  metadataPath: string;
  warmRuns?: number;
}

export async function runLocalBenchmarkSuite(input: LocalBenchmarkSuiteInput): Promise<{
  metadata: LocalBenchmarkSuiteMetadata;
  records: LocalBenchmarkRunRecord[];
}> {
  const warmRuns = input.warmRuns ?? 3;
  if (!Number.isSafeInteger(warmRuns) || warmRuns < 1 || warmRuns > 20) throw new RangeError('warmRuns must be between 1 and 20.');
  const preparedCases = await Promise.all(input.cases.map(async (benchmarkCase) => {
    const prepared = await input.converter.prepare(benchmarkCase.audioPath);
    if (prepared.deleteAfterUse) throw new Error('The CPU baseline suite accepts prevalidated PCM WAV without conversion.');
    const wavQuality = await inspectPcm16Mono16kWavQuality(prepared.wavPath, [dirname(prepared.wavPath)]);
    return { benchmarkCase, prepared, wavQuality, audioSha256: await sha256(prepared.wavPath) };
  }));
  const firstCase = preparedCases[0];
  if (!firstCase) throw new RangeError('At least one benchmark case is required.');
  const availableMemoryBytesBefore = freemem();
  const logicalProcessorCount = availableParallelism();
  if (!input.provider.describeFileInvocation) throw new Error('The local provider cannot describe a reproducible invocation.');
  const firstInput = {
    audioPath: firstCase.prepared.wavPath,
    language: firstCase.benchmarkCase.language,
    hotwords: firstCase.benchmarkCase.hotwords,
  } as const;
  const invocation = await input.provider.describeFileInvocation(firstInput);
  const modelSha256 = await sha256(input.modelPath);
  const metadata: LocalBenchmarkSuiteMetadata = {
    provider: input.provider.id,
    model: input.provider.model.id,
    modelSha256,
    availableMemoryBytesBefore,
    logicalProcessorCount,
    whisperCppThreads: invocation.threads,
    whisperCppExecutionArguments: invocation.arguments,
    processingLocation: 'local',
    audioSentExternally: false,
    coldRunDefinition: 'The first process invocation for each language is labelled cold; OS file caches are not forcibly cleared.',
    startedAt: new Date().toISOString(),
    cases: preparedCases.map(({ benchmarkCase, prepared, wavQuality, audioSha256 }) => ({
      language: benchmarkCase.language,
      testCaseId: benchmarkCase.testCaseId ?? `${benchmarkCase.language}-default`,
      audioSha256,
      wavFormat: prepared.format,
      wavQuality,
      audioDurationMs: prepared.durationSeconds * 1_000,
      spokenReferenceStatus: benchmarkCase.spokenReference ? 'verified' : 'unverified',
    })),
  };
  await mkdir(dirname(input.metadataPath), { recursive: true });
  await writeFile(input.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const records: LocalBenchmarkRunRecord[] = [];
  const probe = await input.provider.transcribeFile(firstInput);
  // The probe is the first (cold) run for the first case; do not discard a paid-in-time measurement.
  const firstColdRecord = toRecord(
    firstCase.benchmarkCase,
    firstCase.prepared.durationSeconds,
    probe,
    'cold',
    1,
    modelSha256,
    firstCase.audioSha256,
  );
  records.push(firstColdRecord);
  await appendRecord(input.resultsJsonlPath, firstColdRecord);
  for (let caseIndex = 0; caseIndex < preparedCases.length; caseIndex += 1) {
    const current = preparedCases[caseIndex];
    if (!current) continue;
    if (caseIndex > 0) {
      const cold = await input.provider.transcribeFile({
        audioPath: current.prepared.wavPath,
        language: current.benchmarkCase.language,
        hotwords: current.benchmarkCase.hotwords,
      });
      const record = toRecord(
        current.benchmarkCase,
        current.prepared.durationSeconds,
        cold,
        'cold',
        1,
        modelSha256,
        current.audioSha256,
      );
      records.push(record);
      await appendRecord(input.resultsJsonlPath, record);
    }
    for (let runNumber = 1; runNumber <= warmRuns; runNumber += 1) {
      const result = await input.provider.transcribeFile({
        audioPath: current.prepared.wavPath,
        language: current.benchmarkCase.language,
        hotwords: current.benchmarkCase.hotwords,
      });
      const record = toRecord(
        current.benchmarkCase,
        current.prepared.durationSeconds,
        result,
        'warm',
        runNumber,
        modelSha256,
        current.audioSha256,
      );
      records.push(record);
      await appendRecord(input.resultsJsonlPath, record);
    }
  }
  return { metadata, records };
}

function toRecord(
  benchmarkCase: LocalBenchmarkCase,
  audioDurationSeconds: number,
  result: Awaited<ReturnType<LocalFileSpeechToTextProvider['transcribeFile']>>,
  runType: 'cold' | 'warm',
  runNumber: number,
  modelSha256: string,
  audioSha256: string,
): LocalBenchmarkRunRecord {
  const rtf = calculateRealTimeFactor(result.totalProcessingMs, audioDurationSeconds);
  const cerRaw = benchmarkCase.language === 'ja' ? calculateRawCharacterErrorRate(benchmarkCase.reference, result.transcript) : null;
  const cerNormalized = benchmarkCase.language === 'ja'
    ? calculateNormalizedJapaneseCharacterErrorRate(benchmarkCase.reference, result.transcript)
    : null;
  const spokenReference = benchmarkCase.spokenReference ?? null;
  const spokenRawCer = benchmarkCase.language === 'ja' && spokenReference !== null
    ? calculateRawCharacterErrorRate(spokenReference, result.transcript)
    : null;
  const spokenNormalizedCer = benchmarkCase.language === 'ja' && spokenReference !== null
    ? calculateNormalizedJapaneseCharacterErrorRate(spokenReference, result.transcript)
    : null;
  const scriptWer = benchmarkCase.language === 'en'
    ? calculateNormalizedEnglishWordErrorRate(benchmarkCase.reference, result.transcript)
    : null;
  const spokenWer = benchmarkCase.language === 'en' && spokenReference !== null
    ? calculateNormalizedEnglishWordErrorRate(spokenReference, result.transcript)
    : null;
  return {
    provider: result.provider,
    model: result.model,
    language: benchmarkCase.language,
    testCaseId: benchmarkCase.testCaseId ?? `${benchmarkCase.language}-default`,
    audioDurationMs: audioDurationSeconds * 1_000,
    processingTimeMs: result.totalProcessingMs,
    realTimeFactor: rtf,
    realTimeFactorRating: rateRealTimeFactor(rtf),
    firstResultTimeMs: result.firstResultLatencyMs ?? null,
    finalResultTimeMs: result.finalLatencyMs,
    rawTranscript: result.transcript,
    scriptReference: benchmarkCase.reference,
    spokenReference,
    scriptBasedRawCer: cerRaw,
    scriptBasedNormalizedCer: cerNormalized,
    scriptBasedWer: scriptWer,
    spokenBasedRawCer: spokenRawCer,
    spokenBasedNormalizedCer: spokenNormalizedCer,
    spokenBasedWer: spokenWer,
    cer: cerNormalized,
    cerRaw,
    cerNormalized,
    rawCer: cerRaw,
    normalizedCer: cerNormalized,
    wer: scriptWer,
    hotwordHitRate: benchmarkCase.hotwords.length
      ? calculateHotwordAccuracy(benchmarkCase.hotwords, result.transcript)
      : null,
    termMatches: classifyTermMatches(benchmarkCase.hotwords, result.transcript),
    processCpuAveragePercent: result.processCpuAveragePercent ?? null,
    processCpuPeakPercent: result.processCpuPeakPercent ?? null,
    peakWorkingSetBytes: result.peakWorkingSetBytes ?? null,
    logicalProcessorCount: result.logicalProcessorCount ?? availableParallelism(),
    threadCount: result.threads,
    runType,
    runNumber,
    modelSha256,
    audioSha256,
    whisperArguments: result.executionArguments,
    errorCode: null,
    testedAt: new Date().toISOString(),
    transcript: result.transcript,
  };
}

export function classifyTermMatches(terms: readonly string[], transcript: string): TermMatchResult[] {
  return terms.map((term) => ({
    term,
    status: transcript.includes(term)
      ? 'exactMatch'
      : matchesNormalizedTerm(term, transcript)
        ? 'normalizedMatch'
        : 'failed',
  }));
}

function matchesNormalizedTerm(term: string, transcript: string): boolean {
  const canonical = term.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\s]+/gu, '');
  if (!canonical) return false;
  const characters = [...canonical];
  const pattern = characters.map((character) => escapeRegExp(character)).join('[\\p{P}\\s]*');
  const prefix = /^[a-z0-9]/u.test(canonical) ? '(?<![a-z0-9])' : '';
  const suffix = /[a-z0-9]$/u.test(canonical) ? '(?![a-z0-9])' : '';
  return new RegExp(`${prefix}${pattern}${suffix}`, 'u').test(transcript.normalize('NFKC').toLocaleLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function appendRecord(filePath: string, record: LocalBenchmarkRunRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function sha256(filePath: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
