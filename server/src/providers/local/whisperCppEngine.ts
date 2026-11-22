import { resolve } from 'node:path';
import type { WireLanguage } from '../../../../shared/protocol.js';
import { parseWhisperTimestampOutput, sha256File } from './chunkComparison.js';
import type { LocalWhisperEngine, LocalWhisperEngineInput, LocalWhisperEngineResult } from './localWhisperEngine.js';
import {
  requireLocalWhisperArtifactSha256,
  resolveLocalWhisperArtifact,
  validateLocalWhisperArtifact,
  WINDOWS_WHISPER_CLI_SHA256,
} from './localWhisperArtifact.js';
import { LocalProcessManager, validateExistingFile } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';

export const SMALL_Q5_1_SHA256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';
export const WHISPER_CLI_SHA256 = WINDOWS_WHISPER_CLI_SHA256;
export const WHISPER_CPP_MODEL_ID = 'whisper-small-q5_1';

export interface WhisperCppEngineOptions {
  root: string;
  modelId: string;
  threads: number;
  executablePath?: string;
  executableSha256?: string;
}

export class WhisperCppEngine implements LocalWhisperEngine {
  readonly descriptor;
  private readonly binaryRoot: string;
  private readonly modelRoot: string;
  private readonly executablePath: string;
  private readonly executableSha256?: string;
  private readonly modelPath: string;
  private readonly processes = new LocalProcessManager(1);

  constructor(private readonly options: WhisperCppEngineOptions) {
    this.binaryRoot = resolve(options.root, 'bin');
    this.modelRoot = resolve(options.root, 'models');
    const artifact = resolveLocalWhisperArtifact({
      binaryRoot: this.binaryRoot,
      executablePath: options.executablePath,
      executableSha256: options.executableSha256,
    });
    this.executablePath = artifact.executablePath;
    this.executableSha256 = artifact.expectedSha256;
    this.modelPath = resolve(this.modelRoot, 'ggml-small-q5_1.bin');
    this.descriptor = {
      id: 'whisper-cpp' as const,
      modelId: WHISPER_CPP_MODEL_ID,
      threadCount: options.threads,
      ...(artifact.expectedSha256 ? {
        debugArtifacts: {
          modelSha256: SMALL_Q5_1_SHA256,
          executableSha256: artifact.expectedSha256,
        },
      } : {}),
    };
  }

  async initialize(): Promise<void> {
    if (this.options.modelId !== 'small-q5_1') {
      throw new LocalSttError('local_model_unsupported', 'The configured Local Whisper model is not supported.');
    }
    if (this.options.threads !== 4) throw new LocalSttError('local_threads_invalid', 'Local Whisper requires four CPU threads.');
    const executableSha256 = requireLocalWhisperArtifactSha256({
      executablePath: this.executablePath,
      expectedSha256: this.executableSha256,
    });
    const [model] = await Promise.all([
      validateExistingFile(this.modelPath, [this.modelRoot], 'local_model_missing', 'The Local Whisper model is not available.'),
      validateLocalWhisperArtifact({
        executablePath: this.executablePath,
        expectedSha256: executableSha256,
      }, this.binaryRoot),
    ]);
    const modelHash = await sha256File(model);
    if (modelHash !== SMALL_Q5_1_SHA256) throw new LocalSttError('local_model_hash_mismatch', 'The Local Whisper model failed integrity verification.');
  }

  transcribe(input: LocalWhisperEngineInput): Promise<LocalWhisperEngineResult> {
    return runTimestampedWhisperFile({
      processes: this.processes,
      executablePath: this.executablePath,
      binaryRoot: this.binaryRoot,
      modelPath: this.modelPath,
      audioPath: input.audioPath,
      language: input.language,
      threads: this.options.threads,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }

  close(): Promise<void> {
    return this.processes.close();
  }
}

export async function runTimestampedWhisperFile(options: {
  processes: LocalProcessManager;
  executablePath: string;
  binaryRoot: string;
  modelPath: string;
  audioPath: string;
  language: WireLanguage;
  threads: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<LocalWhisperEngineResult> {
  const result = await options.processes.run({
    executablePath: options.executablePath,
    allowedExecutableRoots: [options.binaryRoot],
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    arguments: buildLocalWhisperArguments(
      options.modelPath,
      options.audioPath,
      options.language,
      options.threads,
    ),
  });
  const segments = parseWhisperTimestampOutput(result.stdout);
  const outputLines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (segments.length === 0 && outputLines.length > 0) {
    throw new LocalSttError('local_timestamp_parse_failed', 'Local Whisper returned an unrecognized timestamp format.');
  }
  return {
    transcript: segments.map((segment) => segment.text).join(' ').trim(),
    segments,
    processingTimeMs: result.totalProcessingMs,
    processExitCode: result.exitCode,
    processCpuAveragePercent: result.cpuAveragePercent,
    processCpuPeakPercent: result.cpuPeakPercent,
    peakWorkingSetBytes: result.peakMemoryBytes,
    unparsedOutputLineCount: Math.max(0, outputLines.length - segments.length),
  };
}

export function buildLocalWhisperArguments(
  modelPath: string,
  audioPath: string,
  language: WireLanguage,
  threads: number,
): string[] {
  if (language !== 'ja' && language !== 'en') throw new LocalSttError('local_language_unsupported', 'Local Whisper language is invalid.');
  if (threads !== 4) throw new LocalSttError('local_threads_invalid', 'Local Whisper requires four CPU threads.');
  return [
    '--model', modelPath,
    '--file', audioPath,
    '--language', language,
    '--threads', String(threads),
    '--no-prints',
    '--no-gpu',
  ];
}
