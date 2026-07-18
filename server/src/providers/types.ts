import type { AudioFrameMetadata, TranscriptWireSegment, WireLanguage } from '../../../shared/protocol.js';

export interface ServerTranscriptResult {
  sessionId: string;
  segmentId: string;
  revision: number;
  text: string;
  isFinal: boolean;
  language: WireLanguage;
  confidence?: number;
  startTime: number;
  endTime?: number;
  utteranceId?: string;
  provider?: string;
  model?: string;
  processingTimeMs?: number;
  audioDurationMs?: number;
  realTimeFactor?: number;
  segments?: TranscriptWireSegment[];
}

export interface ServerRecognitionStatus {
  sessionId: string;
  state: 'listening' | 'queued' | 'recognizing' | 'completed';
  queueLength: number;
  model?: string;
  language: WireLanguage;
  utteranceId?: string;
  audioDurationMs?: number;
  processingTimeMs?: number;
  realTimeFactor?: number;
}

export class ServerProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(safeMessage, options);
    this.name = 'ServerProviderError';
  }
}

export interface ServerSpeechToTextProvider {
  readonly id: string;
  startSession(options: {
    sessionId: string;
    language: WireLanguage;
    mimeType: string;
    sampleRate?: number;
    hotwords?: string[];
  }): Promise<void>;
  sendAudio(options: {
    sessionId: string;
    sequence: number;
    audio: Uint8Array;
    metadata?: AudioFrameMetadata;
  }): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  onTranscript(callback: (result: ServerTranscriptResult) => void): void;
  onError(callback: (error: ServerProviderError) => void): void;
  onStatus?(callback: (status: ServerRecognitionStatus) => void): void;
  cancelSession?(sessionId: string): Promise<void>;
}

export interface AudioFormatAdapter {
  readonly targetMimeType: string;
  supports(sourceMimeType: string): boolean;
  convert(audio: Uint8Array, sourceMimeType: string): Promise<Uint8Array>;
}

export interface HotwordEntry {
  text: string;
  language: WireLanguage;
  weight?: number;
  enabled: boolean;
}

export interface SttBenchmarkResult {
  provider: string;
  model: string;
  language: WireLanguage;
  audioDurationSeconds: number;
  transcript: string;
  characterErrorRate?: number;
  wordErrorRate?: number;
  hotwordAccuracy?: number;
  firstPartialLatencyMs?: number;
  finalLatencyMs?: number;
  totalProcessingMs: number;
  realTimeFactor?: number;
  cpuUsagePercent?: number;
  peakMemoryBytes?: number;
  errorCode?: string;
  estimatedCostUsd?: number;
  testedAt: string;
}

export type SttEvaluationRecord = SttBenchmarkResult;
