export interface AudioChunk {
  sequence: number;
  capturedAt: number;
  mimeType: string;
  data: Blob;
  sampleRate?: number;
  channels?: number;
  encoding?: 'pcm_s16le';
  frameCount?: number;
}

export type AudioCaptureMode = 'media-recorder' | 'pcm16-16khz';

/** Replace this sink with a WebSocket or speech-to-text adapter later. */
export interface AudioChunkSink {
  handle(chunk: AudioChunk): void | Promise<void>;
}

export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';
export type CaptureState = RecordingStatus;

export interface AudioCaptureCallbacks {
  onStateChange?: (state: CaptureState) => void;
  onLevel?: (level: number) => void;
  onError?: (error: MicrophoneError) => void;
  onSinkError?: (error: unknown) => void;
}

export type MicrophoneErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'device-not-found'
  | 'device-busy'
  | 'unknown';

export class MicrophoneError extends Error {
  constructor(
    public readonly code: MicrophoneErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MicrophoneError';
  }
}
