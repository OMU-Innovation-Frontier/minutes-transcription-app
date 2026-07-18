import type { WireLanguage } from '../../../../shared/protocol.js';

export type LocalProviderId = 'local-whisper' | 'local-kotoba' | 'local-qwen';

export interface LocalModelDefinition {
  id: string;
  provider: LocalProviderId;
  displayName: string;
  fileName: string;
  sourceUrl: string;
  downloadSizeLabel: string;
  downloadSizeBytes?: number;
  estimatedRamMiB?: number;
  license: string;
  quantization: string;
  languages: readonly WireLanguage[];
  whisperCppCompatible: boolean;
  openVinoEncoderCompatible: boolean;
}

export interface LocalFileTranscriptionInput {
  audioPath: string;
  language: WireLanguage;
  hotwords?: readonly string[];
}

export interface LocalFileTranscriptionResult {
  provider: LocalProviderId;
  model: string;
  language: WireLanguage;
  transcript: string;
  totalProcessingMs: number;
  firstResultLatencyMs?: number;
  finalLatencyMs: number;
  processCpuAveragePercent?: number;
  processCpuPeakPercent?: number;
  peakWorkingSetBytes?: number;
  logicalProcessorCount?: number;
  executionArguments: readonly string[];
  threads: number;
}

export interface LocalFileSpeechToTextProvider {
  readonly id: LocalProviderId;
  readonly model: LocalModelDefinition;
  transcribeFile(input: LocalFileTranscriptionInput): Promise<LocalFileTranscriptionResult>;
  describeFileInvocation?(input: LocalFileTranscriptionInput): Promise<{ arguments: readonly string[]; threads: number }>;
  close(): Promise<void>;
}

export class LocalSttError extends Error {
  constructor(
    public readonly code: string,
    public readonly safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(safeMessage, options);
    this.name = 'LocalSttError';
  }
}
