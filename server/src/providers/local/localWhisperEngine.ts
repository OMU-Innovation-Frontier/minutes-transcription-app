import type { WireLanguage } from '../../../../shared/protocol.js';
import type { TimestampedSegment } from './chunkComparison.js';

export type LocalWhisperEngineId = 'whisper-cpp' | 'mlx-whisper';

export interface LocalWhisperEngineDescriptor {
  id: LocalWhisperEngineId;
  modelId: string;
  threadCount: number | null;
  debugArtifacts?: {
    modelSha256: string;
    executableSha256: string;
  };
}

export interface LocalWhisperEngineResult {
  transcript: string;
  segments: TimestampedSegment[];
  processingTimeMs: number;
  processExitCode?: number;
  processCpuAveragePercent?: number;
  processCpuPeakPercent?: number;
  peakWorkingSetBytes?: number;
  unparsedOutputLineCount: number;
}

export interface LocalWhisperEngineInput {
  audioPath: string;
  language: WireLanguage;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LocalWhisperEngine {
  readonly descriptor: LocalWhisperEngineDescriptor;
  initialize(): Promise<void>;
  transcribe(input: LocalWhisperEngineInput): Promise<LocalWhisperEngineResult>;
  close(): Promise<void>;
}
