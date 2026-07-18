import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { WireLanguage } from '../../../../shared/protocol.js';
import { inspectPcm16Mono16kWavQuality, type PcmWavQualityInspection } from './audioConverter.js';
import { assertSafeChildPath, sha256File } from './chunkComparison.js';
import type { PcmUtterance, VadConfiguration } from './pcmUtteranceSegmenter.js';

export type RealtimeAudioErrorClassification =
  | 'beginning_clipped'
  | 'ending_clipped'
  | 'split_too_early'
  | 'hallucination'
  | 'word_substitution'
  | 'phrase_omission'
  | 'duplicate_text'
  | 'punctuation_only'
  | 'proper_noun_error'
  | 'unknown';

export interface RealtimeDebugAudioOptions {
  enabled: boolean;
  localRoot: string;
  directory: string;
  maxFiles: number;
  maxBytes: number;
  onWarning?: (code: RealtimeDebugAudioWarningCode) => void;
}

export type RealtimeDebugAudioWarningCode =
  | 'debug_audio_limit_reached'
  | 'debug_audio_save_failed'
  | 'debug_audio_metadata_failed';

export interface WhisperArgumentProfile {
  language: WireLanguage;
  threads: 4;
  timestamps: true;
  noGpu: true;
  noPrints: true;
  model: 'whisper-small-q5_1';
}

export interface RealtimeDebugAudioMetadata {
  schemaVersion: 1;
  sessionIdHash: string;
  utteranceId: string;
  language: WireLanguage;
  provider: 'local-whisper';
  model: 'whisper-small-q5_1';
  threadCount: 4;
  sampleRate: 16_000;
  channels: 1;
  encoding: 'pcm_s16le';
  frameCount: number;
  audioDurationMs: number;
  capturedSequenceStart: number;
  capturedSequenceEnd: number;
  utteranceReason: 'silence' | 'max_duration' | 'recording_stopped';
  silenceDurationMs: number;
  preSpeechBufferMs: number;
  minimumUtteranceDurationMs: number;
  maxUtteranceDurationMs: number;
  rmsThreshold: number;
  adaptiveNoiseFloor: number;
  wavSha256: string;
  modelSha256: string;
  whisperCliSha256: string;
  whisperArgumentProfile: WhisperArgumentProfile;
  audioDiagnostics: PcmWavQualityInspection;
  realtimeProcessingTimeMs: number | null;
  realtimeRtf: number | null;
  realtimeSegmentCount: number | null;
  realtimeTranscriptSha256: string | null;
  realtimeErrorCode: string | null;
  humanErrorClassification: RealtimeAudioErrorClassification;
  createdAt: string;
}

export interface RealtimeDebugCapture {
  wavPath: string;
  metadataPath: string;
  fileName: string;
  metadata: RealtimeDebugAudioMetadata;
}

export interface RealtimeDebugCaptureInput {
  temporaryWavPath: string;
  sessionId: string;
  utteranceId: string;
  language: WireLanguage;
  utterance: PcmUtterance;
  vad: VadConfiguration;
  modelSha256: string;
  whisperCliSha256: string;
}

export interface RealtimeDebugFinalization {
  processingTimeMs: number | null;
  realTimeFactor: number | null;
  segmentCount: number | null;
  transcript: string | null;
  errorCode: string | null;
}

export class RealtimeDebugAudioStore {
  private readonly root: string;
  private readonly directory: string;
  private readonly saved: RealtimeDebugCapture[] = [];

  constructor(private readonly options: RealtimeDebugAudioOptions) {
    this.root = resolve(options.localRoot);
    this.directory = resolve(options.directory);
    assertSafeChildPath(this.root, this.directory);
    if (!Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1
      || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new RangeError('Debug audio limits must be positive integers.');
    }
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get directoryPath(): string {
    return this.directory;
  }

  getSavedCaptures(): readonly RealtimeDebugCapture[] {
    return this.saved.map((capture) => ({ ...capture, metadata: { ...capture.metadata } }));
  }

  async capture(input: RealtimeDebugCaptureInput): Promise<RealtimeDebugCapture | undefined> {
    if (!this.options.enabled) return undefined;
    try {
      await mkdir(this.directory, { recursive: true });
      const [realRoot, realDirectory] = await Promise.all([realpath(this.root), realpath(this.directory)]);
      assertSafeChildPath(realRoot, realDirectory);
      const sourceBytes = (await stat(input.temporaryWavPath)).size;
      if (!await this.hasCapacity(sourceBytes)) {
        this.warn('debug_audio_limit_reached');
        return undefined;
      }
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
      const stem = `realtime-${stamp}-${randomUUID()}`;
      const wavPath = resolve(this.directory, `${stem}.wav`);
      const stagingWavPath = resolve(this.directory, `.${stem}.wav.part`);
      const metadataPath = resolve(this.directory, `${stem}.metadata.json`);
      assertSafeChildPath(this.directory, wavPath);
      assertSafeChildPath(this.directory, stagingWavPath);
      assertSafeChildPath(this.directory, metadataPath);

      try {
        await copyFile(input.temporaryWavPath, stagingWavPath);
        const [sourceHash, copiedHash] = await Promise.all([
          sha256File(input.temporaryWavPath),
          sha256File(stagingWavPath),
        ]);
        if (sourceHash !== copiedHash) throw new Error('Debug WAV hash mismatch.');
        await rename(stagingWavPath, wavPath);
        const audioDiagnostics = await inspectPcm16Mono16kWavQuality(wavPath, [this.directory]);
        const metadata: RealtimeDebugAudioMetadata = {
          schemaVersion: 1,
          sessionIdHash: hashText(input.sessionId),
          utteranceId: safeUtteranceId(input.utteranceId),
          language: input.language,
          provider: 'local-whisper',
          model: 'whisper-small-q5_1',
          threadCount: 4,
          sampleRate: 16_000,
          channels: 1,
          encoding: 'pcm_s16le',
          frameCount: input.utterance.pcm.byteLength / 2,
          audioDurationMs: input.utterance.audioDurationMs,
          capturedSequenceStart: input.utterance.sequenceStart,
          capturedSequenceEnd: input.utterance.sequenceEnd,
          utteranceReason: input.utterance.reason === 'session_stop'
            ? 'recording_stopped'
            : input.utterance.reason,
          silenceDurationMs: input.vad.silenceDurationMs,
          preSpeechBufferMs: input.vad.preSpeechBufferMs,
          minimumUtteranceDurationMs: input.vad.minimumUtteranceDurationMs,
          maxUtteranceDurationMs: input.vad.maxUtteranceDurationMs,
          rmsThreshold: input.vad.rmsThreshold,
          adaptiveNoiseFloor: input.utterance.adaptiveNoiseFloor,
          wavSha256: copiedHash,
          modelSha256: input.modelSha256,
          whisperCliSha256: input.whisperCliSha256,
          whisperArgumentProfile: {
            language: input.language,
            threads: 4,
            timestamps: true,
            noGpu: true,
            noPrints: true,
            model: 'whisper-small-q5_1',
          },
          audioDiagnostics,
          realtimeProcessingTimeMs: null,
          realtimeRtf: null,
          realtimeSegmentCount: null,
          realtimeTranscriptSha256: null,
          realtimeErrorCode: null,
          humanErrorClassification: 'unknown',
          createdAt: new Date().toISOString(),
        };
        await writeJsonAtomically(metadataPath, metadata);
        const capture = { wavPath, metadataPath, fileName: basename(wavPath), metadata };
        this.saved.push(capture);
        return capture;
      } catch (error) {
        await Promise.allSettled([
          rm(stagingWavPath, { force: true }),
          rm(wavPath, { force: true }),
          rm(metadataPath, { force: true }),
        ]);
        throw error;
      }
    } catch {
      this.warn('debug_audio_save_failed');
      return undefined;
    }
  }

  async finalize(
    capture: RealtimeDebugCapture | undefined,
    values: RealtimeDebugFinalization,
  ): Promise<void> {
    if (!capture) return;
    capture.metadata.realtimeProcessingTimeMs = values.processingTimeMs;
    capture.metadata.realtimeRtf = values.realTimeFactor;
    capture.metadata.realtimeSegmentCount = values.segmentCount;
    capture.metadata.realtimeTranscriptSha256 = values.transcript === null ? null : hashText(values.transcript);
    capture.metadata.realtimeErrorCode = values.errorCode;
    try {
      await writeJsonAtomically(capture.metadataPath, capture.metadata);
    } catch {
      this.warn('debug_audio_metadata_failed');
    }
  }

  private async hasCapacity(newAudioBytes: number): Promise<boolean> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    let wavFiles = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const candidate = resolve(this.directory, entry.name);
      assertSafeChildPath(this.directory, candidate);
      totalBytes += (await stat(candidate)).size;
      if (entry.name.toLowerCase().endsWith('.wav')) wavFiles += 1;
    }
    return wavFiles < this.options.maxFiles && totalBytes + newAudioBytes <= this.options.maxBytes;
  }

  private warn(code: RealtimeDebugAudioWarningCode): void {
    this.options.onWarning?.(code);
  }
}

export function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const stagingPath = `${filePath}.${randomUUID()}.part`;
  try {
    await writeFile(stagingPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(stagingPath, filePath);
  } finally {
    await rm(stagingPath, { force: true });
  }
}

function safeUtteranceId(value: string): string {
  const finalPart = value.split(':').at(-1)?.replace(/[^a-zA-Z0-9_-]/gu, '-');
  return finalPart && finalPart.length <= 80 ? finalPart : `utterance-${hashText(value).slice(0, 16)}`;
}
