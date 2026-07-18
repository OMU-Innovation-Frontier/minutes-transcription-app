import { unlink } from 'node:fs/promises';
import {
  appendSttEvaluationRecord,
  calculateCharacterErrorRate,
  calculateHotwordAccuracy,
  calculateRealTimeFactor,
  calculateWordErrorRate,
  rateRealTimeFactor,
  type RealTimeFactorRating,
} from '../evaluationHarness.js';
import type { SttBenchmarkResult } from '../types.js';
import type { LocalAudioConverter } from './audioConverter.js';
import type { LocalFileSpeechToTextProvider } from './localSttTypes.js';

export interface LocalBenchmarkInput {
  provider: LocalFileSpeechToTextProvider;
  converter: Pick<LocalAudioConverter, 'prepare'>;
  audioPath: string;
  language: 'ja' | 'en';
  groundTruthTranscript?: string;
  hotwords?: readonly string[];
  evaluationFile?: string;
}

export interface LocalBenchmarkResult extends SttBenchmarkResult {
  realTimeFactor: number;
  realTimeFactorRating: RealTimeFactorRating;
  processingLocation: 'local';
  audioSentExternally: false;
  modelPathIncluded: false;
}

export async function runLocalSttBenchmark(input: LocalBenchmarkInput): Promise<LocalBenchmarkResult> {
  const prepared = await input.converter.prepare(input.audioPath);
  try {
    const transcription = await input.provider.transcribeFile({
      audioPath: prepared.wavPath,
      language: input.language,
      hotwords: input.hotwords,
    });
    const realTimeFactor = calculateRealTimeFactor(
      transcription.totalProcessingMs,
      prepared.durationSeconds,
    );
    const record: LocalBenchmarkResult = {
      provider: transcription.provider,
      model: transcription.model,
      language: input.language,
      audioDurationSeconds: prepared.durationSeconds,
      transcript: transcription.transcript,
      characterErrorRate: input.language === 'ja' && input.groundTruthTranscript !== undefined
        ? calculateCharacterErrorRate(input.groundTruthTranscript, transcription.transcript)
        : undefined,
      wordErrorRate: input.language === 'en' && input.groundTruthTranscript !== undefined
        ? calculateWordErrorRate(input.groundTruthTranscript, transcription.transcript)
        : undefined,
      hotwordAccuracy: input.hotwords?.length
        ? calculateHotwordAccuracy(input.hotwords, transcription.transcript)
        : undefined,
      firstPartialLatencyMs: transcription.firstResultLatencyMs,
      finalLatencyMs: transcription.finalLatencyMs,
      totalProcessingMs: transcription.totalProcessingMs,
      realTimeFactor,
      realTimeFactorRating: rateRealTimeFactor(realTimeFactor),
      cpuUsagePercent: transcription.processCpuAveragePercent,
      peakMemoryBytes: transcription.peakWorkingSetBytes,
      testedAt: new Date().toISOString(),
      processingLocation: 'local',
      audioSentExternally: false,
      modelPathIncluded: false,
    };
    if (input.evaluationFile) await appendSttEvaluationRecord(input.evaluationFile, record);
    return record;
  } finally {
    if (prepared.deleteAfterUse) await unlink(prepared.wavPath).catch(() => undefined);
  }
}
