import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_CHUNK_BYTES,
  ProtocolValidationError,
  decodeAudioFrame,
  encodeAudioFrame,
  parseClientControlMessage,
  parseServerMessage,
} from './protocol';

describe('WebSocket protocol', () => {
  it('validates start and stop control messages', () => {
    expect(parseClientControlMessage(JSON.stringify({
      type: 'start',
      sessionId: 'session-1',
      language: 'ja',
      audioFormat: 'audio/webm;codecs=opus',
    }))).toMatchObject({ type: 'start', language: 'ja' });
    expect(parseClientControlMessage(JSON.stringify({ type: 'stop', sessionId: 'session-1' })))
      .toEqual({ type: 'stop', sessionId: 'session-1' });
  });

  it('validates resume and audio acknowledgement messages', () => {
    expect(parseClientControlMessage(JSON.stringify({
      type: 'resume', sessionId: 'session-1', language: 'ja',
      audioFormat: 'audio/webm', lastAcknowledgedSequence: -1,
    }))).toMatchObject({ type: 'resume', lastAcknowledgedSequence: -1 });
    expect(parseServerMessage(JSON.stringify({
      type: 'resumed', sessionId: 'session-1', lastReceivedSequence: 4,
    }))).toEqual({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: 4 });
    expect(parseServerMessage(JSON.stringify({
      type: 'audio_ack', sessionId: 'session-1', sequence: 5,
    }))).toEqual({ type: 'audio_ack', sessionId: 'session-1', sequence: 5 });
  });

  it('round-trips PCM16 frame metadata while retaining legacy audio frames', () => {
    const pcm = new ArrayBuffer(640);
    const encoded = encodeAudioFrame('session-1', 2, pcm, {
      capturedAt: 123, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 320,
    });
    expect(decodeAudioFrame(encoded)).toMatchObject({
      sessionId: 'session-1', sequence: 2,
      metadata: { capturedAt: 123, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 320 },
    });
    expect(decodeAudioFrame(encodeAudioFrame('session-1', 3, new ArrayBuffer(2))).metadata).toBeUndefined();
  });

  it('parses Local Whisper selection, status, and final transcript metrics', () => {
    expect(parseClientControlMessage(JSON.stringify({
      type: 'start', sessionId: 'session-1', language: 'ja',
      audioFormat: 'audio/pcm;rate=16000;channels=1;format=s16le', provider: 'local-whisper',
    }))).toMatchObject({ provider: 'local-whisper' });
    expect(parseServerMessage(JSON.stringify({
      type: 'recognition_status', sessionId: 'session-1', state: 'recognizing', queueLength: 1,
      model: 'whisper-small-q5_1', language: 'ja', audioDurationMs: 1_000,
    }))).toMatchObject({ state: 'recognizing', queueLength: 1 });
    expect(parseServerMessage(JSON.stringify({
      type: 'transcript', sessionId: 'session-1', segmentId: 'u1', revision: 0, text: 'test',
      isFinal: true, language: 'ja', startTime: 0, endTime: 1_000, provider: 'local-whisper',
      model: 'whisper-small-q5_1', processingTimeMs: 500, audioDurationMs: 1_000, realTimeFactor: 0.5,
      segments: [{ startTimeMs: 0, endTimeMs: 900, text: 'test' }],
    }))).toMatchObject({ provider: 'local-whisper', realTimeFactor: 0.5 });
  });

  it('validates heartbeat ping and pong messages', () => {
    expect(parseClientControlMessage(JSON.stringify({ type: 'ping', sessionId: 'session-1' })))
      .toEqual({ type: 'ping', sessionId: 'session-1' });
    expect(parseServerMessage(JSON.stringify({ type: 'pong', sessionId: 'session-1' })))
      .toEqual({ type: 'pong', sessionId: 'session-1' });
  });

  it('rejects invalid control and server messages', () => {
    expect(() => parseClientControlMessage('{bad json')).toThrow(ProtocolValidationError);
    expect(() => parseClientControlMessage(JSON.stringify({ type: 'start', sessionId: '../bad', language: 'ja' })))
      .toThrowError(expect.objectContaining({ code: 'invalid_session' }));
    expect(() => parseServerMessage(JSON.stringify({ type: 'transcript', text: 42 })))
      .toThrowError(expect.objectContaining({ code: 'invalid_session' }));
  });

  it('encodes and decodes a binary audio frame', () => {
    const audio = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = decodeAudioFrame(encodeAudioFrame('session-1', 7, audio));
    expect(result.sessionId).toBe('session-1');
    expect(result.sequence).toBe(7);
    expect([...result.audio]).toEqual([1, 2, 3, 4]);
  });

  it('rejects an oversized audio chunk', () => {
    expect(() => encodeAudioFrame('session-1', 0, new ArrayBuffer(MAX_AUDIO_CHUNK_BYTES + 1)))
      .toThrowError(expect.objectContaining({ code: 'audio_too_large' }));
  });
});
