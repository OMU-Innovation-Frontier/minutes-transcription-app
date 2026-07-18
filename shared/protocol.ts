export const PROTOCOL_VERSION = 1;
export const PCM_AUDIO_FRAME_VERSION = 2;
export const MAX_AUDIO_CHUNK_BYTES = 1_000_000;
export const MAX_CONTROL_MESSAGE_BYTES = 16_384;
export const MAX_SESSION_ID_BYTES = 128;

export type WireLanguage = 'ja' | 'en';
export type ServerProviderRequest = 'server-default' | 'local-whisper';
export type PcmEncoding = 'pcm_s16le';
export type LocalWhisperErrorCode =
  | 'local_stt_disabled'
  | 'local_model_missing'
  | 'local_model_hash_mismatch'
  | 'local_model_unsupported'
  | 'local_executable_missing'
  | 'local_executable_hash_mismatch'
  | 'local_audio_format_unsupported'
  | 'local_pcm_invalid'
  | 'local_language_unsupported'
  | 'local_threads_invalid'
  | 'local_vad_configuration_invalid'
  | 'local_queue_limit'
  | 'local_session_limit'
  | 'local_session_inactive'
  | 'local_runtime_closed'
  | 'local_process_start_failed'
  | 'local_process_timeout'
  | 'local_process_failed'
  | 'local_process_cancelled'
  | 'local_output_limit'
  | 'local_timestamp_parse_failed'
  | 'local_temp_cleanup_failed'
  | 'local_recognition_failed';

export interface AudioFrameMetadata {
  capturedAt: number;
  sampleRate: number;
  channels: number;
  encoding: PcmEncoding;
  frameCount: number;
}

export interface TranscriptWireSegment {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
}

export type ResumeMessage = {
  type: 'resume';
  sessionId: string;
  language: WireLanguage;
  audioFormat: string;
  lastAcknowledgedSequence: number;
  provider?: ServerProviderRequest;
};

export type ResumedMessage = {
  type: 'resumed';
  sessionId: string;
  lastReceivedSequence: number;
};

/** The server accepted this sequence; it no longer needs to be replayed. */
export type AudioAcknowledgement = {
  type: 'audio_ack';
  sessionId: string;
  sequence: number;
};

export type ClientControlMessage =
  | {
      type: 'start';
      sessionId: string;
      language: WireLanguage;
      audioFormat: string;
      provider?: ServerProviderRequest;
    }
  | ResumeMessage
  | {
      type: 'stop';
      sessionId: string;
    }
  | {
      type: 'cancel';
      sessionId: string;
    }
  | {
      type: 'ping';
      sessionId: string;
    };

export type ServerMessage =
  | { type: 'ready'; sessionId: string }
  | ResumedMessage
  | AudioAcknowledgement
  | { type: 'pong'; sessionId: string }
  | {
      type: 'recognition_status';
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
  | {
      type: 'transcript';
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
  | {
      type: 'error';
      sessionId?: string;
      code: string;
      message: string;
      retryable: boolean;
    }
  | { type: 'stopped'; sessionId: string };

export interface AudioFrame {
  sessionId: string;
  sequence: number;
  audio: Uint8Array;
  metadata?: AudioFrameMetadata;
}

export class ProtocolValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

export function encodeAudioFrame(
  sessionId: string,
  sequence: number,
  audio: ArrayBuffer,
  metadata?: AudioFrameMetadata,
): ArrayBuffer {
  const sessionBytes = new TextEncoder().encode(sessionId);
  validateSessionBytes(sessionBytes);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new ProtocolValidationError('invalid_sequence', '音声チャンクのsequenceが不正です。');
  }
  if (audio.byteLength > MAX_AUDIO_CHUNK_BYTES) {
    throw new ProtocolValidationError('audio_too_large', '音声チャンクが上限を超えています。');
  }

  if (metadata) validateAudioMetadata(metadata, audio.byteLength);
  const fixedHeaderLength = metadata ? 25 : 7;
  const headerLength = fixedHeaderLength + sessionBytes.byteLength;
  const frame = new ArrayBuffer(headerLength + audio.byteLength);
  const view = new DataView(frame);
  view.setUint8(0, metadata ? PCM_AUDIO_FRAME_VERSION : PROTOCOL_VERSION);
  view.setUint32(1, sequence);
  view.setUint16(5, sessionBytes.byteLength);
  if (metadata) {
    view.setFloat64(7, metadata.capturedAt, true);
    view.setUint32(15, metadata.sampleRate, true);
    view.setUint8(19, metadata.channels);
    view.setUint8(20, 1);
    view.setUint32(21, metadata.frameCount, true);
  }
  new Uint8Array(frame, fixedHeaderLength, sessionBytes.byteLength).set(sessionBytes);
  new Uint8Array(frame, headerLength).set(new Uint8Array(audio));
  return frame;
}

export function decodeAudioFrame(input: ArrayBuffer | Uint8Array): AudioFrame {
  const bytes = input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (bytes.byteLength < 7) throw new ProtocolValidationError('invalid_audio_frame', '音声フレームが短すぎます。');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION && version !== PCM_AUDIO_FRAME_VERSION) {
    throw new ProtocolValidationError('unsupported_protocol', '未対応の音声プロトコルです。');
  }
  const sequence = view.getUint32(1);
  const sessionLength = view.getUint16(5);
  const fixedHeaderLength = version === PCM_AUDIO_FRAME_VERSION ? 25 : 7;
  if (bytes.byteLength < fixedHeaderLength || sessionLength === 0 || sessionLength > MAX_SESSION_ID_BYTES
    || fixedHeaderLength + sessionLength > bytes.byteLength) {
    throw new ProtocolValidationError('invalid_session', '音声フレームのsessionIdが不正です。');
  }
  const audio = bytes.slice(fixedHeaderLength + sessionLength);
  if (audio.byteLength === 0) throw new ProtocolValidationError('empty_audio', '音声チャンクが空です。');
  if (audio.byteLength > MAX_AUDIO_CHUNK_BYTES) {
    throw new ProtocolValidationError('audio_too_large', '音声チャンクが上限を超えています。');
  }

  let sessionId: string;
  try {
    sessionId = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(fixedHeaderLength, fixedHeaderLength + sessionLength));
  } catch {
    throw new ProtocolValidationError('invalid_session', 'sessionIdの文字コードが不正です。');
  }
  const metadata = version === PCM_AUDIO_FRAME_VERSION ? decodeAudioMetadata(view, audio.byteLength) : undefined;
  return {
    sessionId,
    sequence,
    audio,
    metadata,
  };
}

export function parseClientControlMessage(text: string): ClientControlMessage {
  if (new TextEncoder().encode(text).byteLength > MAX_CONTROL_MESSAGE_BYTES) {
    throw new ProtocolValidationError('message_too_large', '制御メッセージが上限を超えています。');
  }
  const value = parseJsonObject(text);
  if (value.type === 'start' || value.type === 'resume') {
    assertSessionId(value.sessionId);
    if (value.language !== 'ja' && value.language !== 'en') {
      throw new ProtocolValidationError('invalid_language', '認識言語が不正です。');
    }
    if (typeof value.audioFormat !== 'string' || value.audioFormat.length === 0 || value.audioFormat.length > 128) {
      throw new ProtocolValidationError('invalid_audio_format', '音声形式が不正です。');
    }
    const common = {
      sessionId: value.sessionId,
      language: value.language as WireLanguage,
      audioFormat: value.audioFormat,
      provider: parseProviderRequest(value.provider),
    };
    if (value.type === 'resume') {
      assertSequence(value.lastAcknowledgedSequence, true);
      return { type: 'resume', ...common, lastAcknowledgedSequence: value.lastAcknowledgedSequence };
    }
    return { type: 'start', ...common };
  }
  if (value.type === 'stop' || value.type === 'cancel' || value.type === 'ping') {
    assertSessionId(value.sessionId);
    return { type: value.type, sessionId: value.sessionId };
  }
  throw new ProtocolValidationError('invalid_message_type', '未対応の制御メッセージです。');
}

export function parseServerMessage(text: string): ServerMessage {
  if (new TextEncoder().encode(text).byteLength > MAX_CONTROL_MESSAGE_BYTES) {
    throw new ProtocolValidationError('message_too_large', 'サーバーメッセージが上限を超えています。');
  }
  const value = parseJsonObject(text);
  if (value.type === 'ready' || value.type === 'stopped' || value.type === 'pong') {
    assertSessionId(value.sessionId);
    return { type: value.type, sessionId: value.sessionId };
  }
  if (value.type === 'resumed') {
    assertSessionId(value.sessionId);
    assertSequence(value.lastReceivedSequence, true);
    return { type: 'resumed', sessionId: value.sessionId, lastReceivedSequence: value.lastReceivedSequence };
  }
  if (value.type === 'audio_ack') {
    assertSessionId(value.sessionId);
    assertSequence(value.sequence, false);
    return { type: 'audio_ack', sessionId: value.sessionId, sequence: value.sequence };
  }
  if (value.type === 'recognition_status') {
    assertSessionId(value.sessionId);
    if (!['listening', 'queued', 'recognizing', 'completed'].includes(String(value.state))
      || !Number.isSafeInteger(value.queueLength) || (value.queueLength as number) < 0
      || (value.language !== 'ja' && value.language !== 'en')) {
      throw new ProtocolValidationError('invalid_recognition_status', '認識状態メッセージが不正です。');
    }
    for (const field of ['audioDurationMs', 'processingTimeMs', 'realTimeFactor'] as const) {
      if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || (value[field] as number) < 0)) {
        throw new ProtocolValidationError('invalid_recognition_status', '認識状態の計測値が不正です。');
      }
    }
    return {
      type: 'recognition_status', sessionId: value.sessionId, state: value.state as 'listening' | 'queued' | 'recognizing' | 'completed',
      queueLength: value.queueLength as number, language: value.language, model: optionalShortString(value.model),
      utteranceId: optionalShortString(value.utteranceId), audioDurationMs: value.audioDurationMs as number | undefined,
      processingTimeMs: value.processingTimeMs as number | undefined, realTimeFactor: value.realTimeFactor as number | undefined,
    };
  }
  if (value.type === 'error') {
    if (value.sessionId !== undefined) assertSessionId(value.sessionId);
    if (typeof value.code !== 'string' || typeof value.message !== 'string' || typeof value.retryable !== 'boolean') {
      throw new ProtocolValidationError('invalid_error', 'エラーメッセージが不正です。');
    }
    return {
      type: 'error',
      sessionId: value.sessionId,
      code: value.code,
      message: value.message,
      retryable: value.retryable,
    };
  }
  if (value.type === 'transcript') {
    assertSessionId(value.sessionId);
    if (
      typeof value.segmentId !== 'string'
      || typeof value.revision !== 'number'
      || !Number.isSafeInteger(value.revision)
      || typeof value.text !== 'string'
      || typeof value.isFinal !== 'boolean'
      || (value.language !== 'ja' && value.language !== 'en')
      || typeof value.startTime !== 'number'
      || (value.endTime !== undefined && typeof value.endTime !== 'number')
      || (value.confidence !== undefined && typeof value.confidence !== 'number')
    ) {
      throw new ProtocolValidationError('invalid_transcript', '文字起こしメッセージが不正です。');
    }
    return {
      type: 'transcript',
      sessionId: value.sessionId,
      segmentId: value.segmentId,
      revision: value.revision,
      text: value.text,
      isFinal: value.isFinal,
      language: value.language,
      confidence: value.confidence,
      startTime: value.startTime,
      endTime: value.endTime,
      utteranceId: optionalShortString(value.utteranceId),
      provider: optionalShortString(value.provider),
      model: optionalShortString(value.model),
      processingTimeMs: optionalNonNegativeNumber(value.processingTimeMs),
      audioDurationMs: optionalNonNegativeNumber(value.audioDurationMs),
      realTimeFactor: optionalNonNegativeNumber(value.realTimeFactor),
      segments: parseTranscriptSegments(value.segments),
    };
  }
  throw new ProtocolValidationError('invalid_message_type', '未対応のサーバーメッセージです。');
}

function parseProviderRequest(value: unknown): ServerProviderRequest | undefined {
  if (value === undefined) return undefined;
  if (value === 'server-default' || value === 'local-whisper') return value;
  throw new ProtocolValidationError('invalid_provider', '音声認識プロバイダー指定が不正です。');
}

function validateAudioMetadata(metadata: AudioFrameMetadata, audioBytes: number): void {
  if (!Number.isFinite(metadata.capturedAt) || metadata.capturedAt < 0
    || !Number.isSafeInteger(metadata.sampleRate) || metadata.sampleRate < 8_000 || metadata.sampleRate > 192_000
    || !Number.isSafeInteger(metadata.channels) || metadata.channels < 1 || metadata.channels > 8
    || metadata.encoding !== 'pcm_s16le'
    || !Number.isSafeInteger(metadata.frameCount) || metadata.frameCount <= 0
    || metadata.frameCount * metadata.channels * 2 !== audioBytes) {
    throw new ProtocolValidationError('invalid_audio_metadata', 'PCM音声メタデータが不正です。');
  }
}

function decodeAudioMetadata(view: DataView, audioBytes: number): AudioFrameMetadata {
  const encoding = view.getUint8(20);
  const metadata: AudioFrameMetadata = {
    capturedAt: view.getFloat64(7, true), sampleRate: view.getUint32(15, true), channels: view.getUint8(19),
    encoding: encoding === 1 ? 'pcm_s16le' : 'pcm_s16le', frameCount: view.getUint32(21, true),
  };
  if (encoding !== 1) throw new ProtocolValidationError('invalid_audio_metadata', 'PCMエンコーディングが不正です。');
  validateAudioMetadata(metadata, audioBytes);
  return metadata;
}

function optionalShortString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ProtocolValidationError('invalid_message', '文字列フィールドが不正です。');
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProtocolValidationError('invalid_transcript', '文字起こし計測値が不正です。');
  }
  return value;
}

function parseTranscriptSegments(value: unknown): TranscriptWireSegment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1_000) throw new ProtocolValidationError('invalid_transcript', '文字起こしsegmentが不正です。');
  return value.map((segment) => {
    if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) {
      throw new ProtocolValidationError('invalid_transcript', '文字起こしsegmentが不正です。');
    }
    const item = segment as Record<string, unknown>;
    if (typeof item.startTimeMs !== 'number' || typeof item.endTimeMs !== 'number' || typeof item.text !== 'string'
      || item.startTimeMs < 0 || item.endTimeMs < item.startTimeMs || item.text.length === 0) {
      throw new ProtocolValidationError('invalid_transcript', '文字起こしsegmentが不正です。');
    }
    return { startTimeMs: item.startTimeMs, endTimeMs: item.endTimeMs, text: item.text };
  });
}

function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolValidationError('invalid_json', 'JSONメッセージを解析できません。');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError('invalid_message', 'メッセージはJSONオブジェクトである必要があります。');
  }
  return value as Record<string, unknown>;
}

function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new ProtocolValidationError('invalid_session', 'sessionIdが不正です。');
  validateSessionBytes(new TextEncoder().encode(value));
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new ProtocolValidationError('invalid_session', 'sessionIdに使用できない文字が含まれています。');
  }
}

function validateSessionBytes(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SESSION_ID_BYTES) {
    throw new ProtocolValidationError('invalid_session', 'sessionIdの長さが不正です。');
  }
}

function assertSequence(value: unknown, allowBeforeFirst: boolean): asserts value is number {
  const minimum = allowBeforeFirst ? -1 : 0;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 0xffff_ffff) {
    throw new ProtocolValidationError('invalid_sequence', 'sequenceが不正です。');
  }
}
