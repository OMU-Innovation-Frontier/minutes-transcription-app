import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { WireLanguage } from '../../../../shared/protocol.js';
import { inspectPcm16Mono16kWavQuality, type PcmWavQualityInspection } from './audioConverter.js';
import { assertSafeChildPath, sha256File } from './chunkComparison.js';
import { LocalProcessManager, validateExistingFile } from './localProcessManager.js';
import {
  LOCAL_WHISPER_MODEL_ID,
  SMALL_Q5_1_SHA256,
  WHISPER_CLI_SHA256,
  runTimestampedWhisperFile,
} from './localWhisperRuntime.js';
import { LocalSttError } from './localSttTypes.js';
import {
  hashText,
  type RealtimeDebugAudioMetadata,
  type WhisperArgumentProfile,
} from './realtimeDebugAudio.js';

export type RealtimeComparisonClassification =
  | 'identical'
  | 'text-different'
  | 'configuration-different'
  | 'audio-mismatch'
  | 'invalid-audio'
  | 'runtime-error';

export interface RealtimeAudioComparisonResult {
  schemaVersion: 1;
  wavFileName: string;
  wavSha256: string | null;
  metadataWavSha256: string | null;
  realtimeTranscriptSha256: string | null;
  offlineTranscriptSha256: string | null;
  transcriptHashMatch: boolean | null;
  realtimeTranscriptCharacters: null;
  offlineTranscriptCharacters: number | null;
  realtimeSegmentCount: number | null;
  offlineSegmentCount: number | null;
  segmentCountMatch: boolean | null;
  realtimeProcessingTimeMs: number | null;
  offlineProcessingTimeMs: number | null;
  realtimeRtf: number | null;
  offlineRtf: number | null;
  modelMatch: boolean;
  languageMatch: boolean;
  argumentMatch: boolean;
  audioDiagnostics: PcmWavQualityInspection | null;
  classification: RealtimeComparisonClassification;
  explanation: string;
  errorCode: string | null;
  humanErrorClassification: 'unknown';
  testedAt: string;
  offlineTranscript?: string;
  resultFileName?: string;
}

export interface RealtimeAudioComparisonOptions {
  wavPath: string;
  localRoot: string;
  debugAudioDirectory: string;
  timeoutMs: number;
  showTranscript?: boolean;
  saveResult?: boolean;
}

interface ClassificationInput {
  audioMatches: boolean;
  audioValid: boolean;
  runtimeSucceeded: boolean;
  configurationMatches: boolean;
  transcriptMatches: boolean;
}

export function classifyRealtimeComparison(input: ClassificationInput): RealtimeComparisonClassification {
  if (!input.audioMatches) return 'audio-mismatch';
  if (!input.audioValid) return 'invalid-audio';
  if (!input.runtimeSucceeded) return 'runtime-error';
  if (!input.configurationMatches) return 'configuration-different';
  return input.transcriptMatches ? 'identical' : 'text-different';
}

export function includeTranscriptWhenRequested(
  result: RealtimeAudioComparisonResult,
  transcript: string,
  showTranscript: boolean,
): RealtimeAudioComparisonResult {
  return showTranscript ? { ...result, offlineTranscript: transcript } : result;
}

export async function compareRealtimeDebugAudio(
  options: RealtimeAudioComparisonOptions,
): Promise<RealtimeAudioComparisonResult> {
  const localRoot = resolve(options.localRoot);
  const debugRoot = resolve(options.debugAudioDirectory);
  assertSafeChildPath(localRoot, debugRoot);
  const requested = resolve(options.wavPath);
  if (extname(requested).toLowerCase() !== '.wav') {
    throw new LocalSttError('local_audio_invalid', 'Only debug WAV files can be compared.');
  }
  const wavPath = await validateExistingFile(
    requested,
    [debugRoot],
    'local_audio_invalid',
    'The comparison input must be inside the Local Whisper debug audio directory.',
  );
  const metadataPath = wavPath.slice(0, -4) + '.metadata.json';
  const testedAt = new Date().toISOString();
  let metadata: RealtimeDebugAudioMetadata;
  try {
    const validatedMetadata = await validateExistingFile(
      metadataPath,
      [debugRoot],
      'local_debug_metadata_missing',
      'The debug WAV metadata file is missing.',
    );
    metadata = parseMetadata(await readFile(validatedMetadata, 'utf8'));
  } catch (error) {
    return await finalizeResult(options, debugRoot, wavPath, baseResult({
      wavFileName: basename(wavPath),
      classification: 'runtime-error',
      explanation: 'Comparison could not start because valid debug metadata was not available.',
      errorCode: error instanceof LocalSttError ? error.code : 'local_debug_metadata_invalid',
      testedAt,
    }));
  }

  const wavSha256 = await sha256File(wavPath);
  if (wavSha256 !== metadata.wavSha256) {
    return await finalizeResult(options, debugRoot, wavPath, baseResult({
      wavFileName: basename(wavPath),
      wavSha256,
      metadataWavSha256: metadata.wavSha256,
      realtimeTranscriptSha256: metadata.realtimeTranscriptSha256,
      realtimeSegmentCount: metadata.realtimeSegmentCount,
      realtimeProcessingTimeMs: metadata.realtimeProcessingTimeMs,
      realtimeRtf: metadata.realtimeRtf,
      classification: 'audio-mismatch',
      explanation: 'The debug WAV SHA-256 does not match its metadata, so Whisper was not started.',
      errorCode: 'local_debug_audio_hash_mismatch',
      testedAt,
    }));
  }

  let audioDiagnostics: PcmWavQualityInspection;
  try {
    audioDiagnostics = await inspectPcm16Mono16kWavQuality(wavPath, [debugRoot]);
  } catch (error) {
    return await finalizeResult(options, debugRoot, wavPath, baseResult({
      wavFileName: basename(wavPath),
      wavSha256,
      metadataWavSha256: metadata.wavSha256,
      realtimeTranscriptSha256: metadata.realtimeTranscriptSha256,
      classification: 'invalid-audio',
      explanation: 'The debug WAV failed PCM WAV validation, so Whisper was not started.',
      errorCode: error instanceof LocalSttError ? error.code : 'local_wav_format_unsupported',
      testedAt,
    }));
  }

  const language = isWireLanguage(metadata.language) ? metadata.language : undefined;
  const actualProfile = language ? createArgumentProfile(language) : undefined;
  const modelMatch = metadata.model === LOCAL_WHISPER_MODEL_ID
    && metadata.modelSha256 === SMALL_Q5_1_SHA256;
  const languageMatch = language !== undefined;
  const argumentMatch = actualProfile !== undefined
    && equalArgumentProfiles(metadata.whisperArgumentProfile, actualProfile);
  const configurationMatches = modelMatch && languageMatch && argumentMatch
    && metadata.whisperCliSha256 === WHISPER_CLI_SHA256;
  if (!language) {
    return await finalizeResult(options, debugRoot, wavPath, baseResult({
      wavFileName: basename(wavPath), wavSha256, metadataWavSha256: metadata.wavSha256,
      realtimeTranscriptSha256: metadata.realtimeTranscriptSha256,
      realtimeSegmentCount: metadata.realtimeSegmentCount,
      realtimeProcessingTimeMs: metadata.realtimeProcessingTimeMs,
      realtimeRtf: metadata.realtimeRtf,
      modelMatch, languageMatch, argumentMatch, audioDiagnostics,
      classification: 'configuration-different',
      explanation: 'The stored language is not supported by the comparison runner.',
      errorCode: 'local_language_unsupported', testedAt,
    }));
  }

  const binaryRoot = resolve(localRoot, 'bin');
  const modelRoot = resolve(localRoot, 'models');
  const executablePath = resolve(binaryRoot, 'v1.9.1/Release/whisper-cli.exe');
  const modelPath = resolve(modelRoot, 'ggml-small-q5_1.bin');
  const processes = new LocalProcessManager(1);
  try {
    const [actualModelHash, actualExecutableHash] = await Promise.all([
      sha256File(await validateExistingFile(modelPath, [modelRoot], 'local_model_missing', 'The Local Whisper model is unavailable.')),
      sha256File(await validateExistingFile(executablePath, [binaryRoot], 'local_executable_missing', 'The whisper.cpp executable is unavailable.')),
    ]);
    if (actualModelHash !== SMALL_Q5_1_SHA256 || actualExecutableHash !== WHISPER_CLI_SHA256) {
      throw new LocalSttError('local_integrity_mismatch', 'Local Whisper integrity verification failed.');
    }
    const recognition = await runTimestampedWhisperFile({
      processes, executablePath, binaryRoot, modelPath, audioPath: wavPath,
      language, threads: 4, timeoutMs: options.timeoutMs,
    });
    const offlineTranscriptSha256 = hashText(recognition.transcript);
    const transcriptHashMatch = metadata.realtimeTranscriptSha256 === offlineTranscriptSha256;
    const classification = classifyRealtimeComparison({
      audioMatches: true,
      audioValid: true,
      runtimeSucceeded: true,
      configurationMatches,
      transcriptMatches: transcriptHashMatch,
    });
    const result = includeTranscriptWhenRequested(baseResult({
        wavFileName: basename(wavPath), wavSha256, metadataWavSha256: metadata.wavSha256,
        realtimeTranscriptSha256: metadata.realtimeTranscriptSha256,
        offlineTranscriptSha256, transcriptHashMatch,
        offlineTranscriptCharacters: recognition.transcript.length,
        realtimeSegmentCount: metadata.realtimeSegmentCount,
        offlineSegmentCount: recognition.segments.length,
        segmentCountMatch: metadata.realtimeSegmentCount === recognition.segments.length,
        realtimeProcessingTimeMs: metadata.realtimeProcessingTimeMs,
        offlineProcessingTimeMs: recognition.processingTimeMs,
        realtimeRtf: metadata.realtimeRtf,
        offlineRtf: recognition.processingTimeMs / metadata.audioDurationMs,
        modelMatch, languageMatch, argumentMatch, audioDiagnostics,
        classification,
        explanation: explanationFor(classification),
        errorCode: null,
        testedAt,
      }), recognition.transcript, options.showTranscript === true);
    return await finalizeResult(options, debugRoot, wavPath, result);
  } catch (error) {
    return await finalizeResult(options, debugRoot, wavPath, baseResult({
      wavFileName: basename(wavPath), wavSha256, metadataWavSha256: metadata.wavSha256,
      realtimeTranscriptSha256: metadata.realtimeTranscriptSha256,
      realtimeSegmentCount: metadata.realtimeSegmentCount,
      realtimeProcessingTimeMs: metadata.realtimeProcessingTimeMs,
      realtimeRtf: metadata.realtimeRtf,
      modelMatch, languageMatch, argumentMatch, audioDiagnostics,
      classification: 'runtime-error',
      explanation: 'Offline Local Whisper recognition failed safely.',
      errorCode: error instanceof LocalSttError ? error.code : 'local_recognition_failed',
      testedAt,
    }));
  } finally {
    await processes.close();
  }
}

function baseResult(
  values: Partial<RealtimeAudioComparisonResult>
    & Pick<RealtimeAudioComparisonResult, 'wavFileName' | 'classification' | 'explanation' | 'testedAt'>,
): RealtimeAudioComparisonResult {
  return {
    schemaVersion: 1,
    wavFileName: values.wavFileName,
    wavSha256: values.wavSha256 ?? null,
    metadataWavSha256: values.metadataWavSha256 ?? null,
    realtimeTranscriptSha256: values.realtimeTranscriptSha256 ?? null,
    offlineTranscriptSha256: values.offlineTranscriptSha256 ?? null,
    transcriptHashMatch: values.transcriptHashMatch ?? null,
    realtimeTranscriptCharacters: null,
    offlineTranscriptCharacters: values.offlineTranscriptCharacters ?? null,
    realtimeSegmentCount: values.realtimeSegmentCount ?? null,
    offlineSegmentCount: values.offlineSegmentCount ?? null,
    segmentCountMatch: values.segmentCountMatch ?? null,
    realtimeProcessingTimeMs: values.realtimeProcessingTimeMs ?? null,
    offlineProcessingTimeMs: values.offlineProcessingTimeMs ?? null,
    realtimeRtf: values.realtimeRtf ?? null,
    offlineRtf: values.offlineRtf ?? null,
    modelMatch: values.modelMatch ?? false,
    languageMatch: values.languageMatch ?? false,
    argumentMatch: values.argumentMatch ?? false,
    audioDiagnostics: values.audioDiagnostics ?? null,
    classification: values.classification,
    explanation: values.explanation,
    errorCode: values.errorCode ?? null,
    humanErrorClassification: 'unknown',
    testedAt: values.testedAt,
  };
}

async function finalizeResult(
  options: RealtimeAudioComparisonOptions,
  debugRoot: string,
  wavPath: string,
  result: RealtimeAudioComparisonResult,
): Promise<RealtimeAudioComparisonResult> {
  if (options.saveResult === false) return result;
  const stem = basename(wavPath, '.wav');
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const fileName = `${stem}.comparison-${timestamp}.json`;
  const resultPath = resolve(debugRoot, fileName);
  assertSafeChildPath(debugRoot, resultPath);
  const stagingPath = `${resultPath}.${randomUUID()}.part`;
  try {
    await writeFile(stagingPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(stagingPath, resultPath);
  } finally {
    await rm(stagingPath, { force: true });
  }
  return { ...result, resultFileName: fileName };
}

function parseMetadata(raw: string): RealtimeDebugAudioMetadata {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('wavSha256' in value) || typeof value.wavSha256 !== 'string') {
    throw new LocalSttError('local_debug_metadata_invalid', 'The debug WAV metadata is invalid.');
  }
  return value as RealtimeDebugAudioMetadata;
}

function createArgumentProfile(language: WireLanguage): WhisperArgumentProfile {
  return {
    language, threads: 4, timestamps: true, noGpu: true, noPrints: true,
    model: 'whisper-small-q5_1',
  };
}

function equalArgumentProfiles(left: WhisperArgumentProfile, right: WhisperArgumentProfile): boolean {
  return left.language === right.language && left.threads === right.threads
    && left.timestamps === right.timestamps && left.noGpu === right.noGpu
    && left.noPrints === right.noPrints && left.model === right.model;
}

function isWireLanguage(value: unknown): value is WireLanguage {
  return value === 'ja' || value === 'en';
}

function explanationFor(classification: RealtimeComparisonClassification): string {
  if (classification === 'identical') {
    return 'The same final WAV produced the same transcript hash. WebSocket delivery and UI rendering are therefore less likely causes, but browser resampling and VAD boundaries are not yet ruled out.';
  }
  if (classification === 'text-different') {
    return 'The same WAV produced different transcript hashes. Compare execution settings, provider path, timestamp parsing, text joining, concurrency, and cancellation behavior.';
  }
  if (classification === 'configuration-different') {
    return 'The audio was recognized, but the stored and offline model, language, or argument profile differed.';
  }
  return 'The comparison could not establish equivalent successful recognition.';
}
