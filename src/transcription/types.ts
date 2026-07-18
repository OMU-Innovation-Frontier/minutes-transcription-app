import type { AudioChunk } from '../audio/types';
import type { TranscriptCorrection } from '../../shared/correction';

export type TranscriptionLanguage = 'ja-JP' | 'en-US';
export type TranscriptionConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'transcribing'
  | 'reconnecting'
  | 'resuming'
  | 'replaying'
  | 'degraded'
  | 'utterance-waiting'
  | 'recognition-queued'
  | 'recognizing'
  | 'recognition-complete'
  | 'stopped'
  | 'error';
export type TranscriptionState = TranscriptionConnectionStatus;

export interface TranscriptUpdate {
  sessionId: string;
  segmentId: string;
  sequence: number;
  revision: number;
  text: string;
  isFinal: boolean;
  language: TranscriptionLanguage;
  provider: string;
  startTime: number;
  endTime?: number;
  confidence?: number;
  createdAt: string;
  utteranceId?: string;
  model?: string;
  processingTimeMs?: number;
  audioDurationMs?: number;
  realTimeFactor?: number;
}

export interface ProviderRecognitionStatus {
  state: 'listening' | 'queued' | 'recognizing' | 'completed';
  queueLength: number;
  model?: string;
  language: 'ja' | 'en';
  utteranceId?: string;
  audioDurationMs?: number;
  processingTimeMs?: number;
  realTimeFactor?: number;
}

export type TranscriptLanguage = 'ja' | 'en';

export interface RawTranscriptSegment {
  id: string;
  sessionId: string;
  text: string;
  isFinal: boolean;
  startTime: number;
  endTime?: number;
  language: TranscriptLanguage;
  provider: string;
  revision: number;
}

export type SentenceCompletionReason =
  | 'punctuation'
  | 'merged_short_continuation'
  | 'silence'
  | 'max_duration'
  | 'max_length'
  | 'manual'
  | 'recording_stopped';

export interface CompletedSentence {
  id: string;
  sessionId: string;
  rawSegmentIds: string[];
  rawText: string;
  displayText: string;
  language: TranscriptLanguage;
  startTime: number;
  endTime: number;
  completionReason: SentenceCompletionReason;
  correction?: TranscriptCorrection;
}

export interface TranscriptionError {
  code: 'unsupported' | 'permission-denied' | 'network' | 'service' | 'configuration' | 'protocol' | 'unknown';
  message: string;
  cause?: unknown;
}

export interface SpeechToTextCallbacks {
  onStateChange?: (state: TranscriptionState) => void;
  onReconnectAttempt?: (attempt: number, maxAttempts: number, delayMs: number) => void;
  onTranscript?: (update: TranscriptUpdate) => void;
  onError?: (error: TranscriptionError) => void;
  onWarning?: (error: TranscriptionError) => void;
  onBufferedAudioChange?: (snapshot: import('../audio/pendingAudioQueue').AudioBufferSnapshot) => void;
  onProviderStatus?: (status: ProviderRecognitionStatus) => void;
}

export interface StartTranscriptionOptions {
  sessionId: string;
  language: TranscriptionLanguage;
  audioFormat: string;
  callbacks?: SpeechToTextCallbacks;
}

/**
 * Speech recognition is isolated behind this interface so a WebSocket/API
 * adapter can replace the browser or mock provider without changing capture UI.
 */
export interface SpeechToTextProvider {
  readonly id: string;
  readonly label: string;
  readonly isMock: boolean;
  readonly audioCaptureMode?: import('../audio/types').AudioCaptureMode;
  isSupported(): boolean;
  start(options: StartTranscriptionOptions): Promise<void>;
  acceptChunk(chunk: AudioChunk): void | Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
  reconnect?(): void;
}

export type SpeechToTextProviderKind = 'browser' | 'mock' | 'websocket' | 'local-whisper';
