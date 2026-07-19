// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAudioFrame, type AudioFrameMetadata, type ServerMessage } from '../../shared/protocol';
import { UnavailableExternalSpeechToTextProvider } from '../src/providers/externalProvider';
import { MockServerSpeechToTextProvider } from '../src/providers/mockProvider';
import type {
  ServerProviderError,
  ServerSpeechToTextProvider,
  ServerTranscriptResult,
} from '../src/providers/types';
import { TranscriptionWebSocketSession } from '../src/session';
import { TranscriptionSessionRegistry } from '../src/sessionRegistry';

const sessions: TranscriptionWebSocketSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.useRealTimers();
});

function createSession(provider: ServerSpeechToTextProvider = new MockServerSpeechToTextProvider()) {
  const messages: ServerMessage[] = [];
  const terminate = vi.fn();
  const session = new TranscriptionWebSocketSession(
    provider,
    { connectionTimeoutMs: 60_000, audioIdleTimeoutMs: 60_000 },
    (message) => messages.push(message),
    terminate,
  );
  sessions.push(session);
  return { session, messages, terminate };
}

async function start(session: TranscriptionWebSocketSession, sessionId = 'session-1'): Promise<void> {
  await session.handleText(JSON.stringify({
    type: 'start',
    sessionId,
    language: 'ja',
    audioFormat: 'audio/webm;codecs=opus',
  }));
}

describe('TranscriptionWebSocketSession', () => {
  it('starts a session, receives binary audio, and returns mock transcripts', async () => {
    const { session, messages } = createSession();
    await start(session);
    expect(messages[0]).toEqual({ type: 'ready', sessionId: 'session-1' });

    await session.handleBinary(new Uint8Array(encodeAudioFrame('session-1', 0, new Uint8Array([1, 2]).buffer)));
    expect(messages[1]).toMatchObject({
      type: 'transcript',
      sessionId: 'session-1',
      revision: 0,
      isFinal: false,
    });
  });

  it('rejects out-of-order and stale-session audio frames', async () => {
    const { session, messages } = createSession();
    await start(session);
    await session.handleBinary(new Uint8Array(encodeAudioFrame('session-1', 1, new Uint8Array([1]).buffer)));
    await session.handleBinary(new Uint8Array(encodeAudioFrame('old-session', 0, new Uint8Array([1]).buffer)));

    expect(messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'out_of_order_chunk' }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'stale_session' }));
  });

  it('sends the final mock result before stopped', async () => {
    const { session, messages } = createSession();
    await start(session);
    await session.handleBinary(new Uint8Array(encodeAudioFrame('session-1', 0, new Uint8Array([1]).buffer)));
    await session.handleText(JSON.stringify({ type: 'stop', sessionId: 'session-1' }));

    const finalIndex = messages.findIndex((message) => message.type === 'transcript' && message.isFinal);
    const stoppedIndex = messages.findIndex((message) => message.type === 'stopped');
    expect(finalIndex).toBeGreaterThan(0);
    expect(stoppedIndex).toBeGreaterThan(finalIndex);
  });

  it('returns a safe API-key error without exposing internal data', async () => {
    const { session, messages } = createSession(new UnavailableExternalSpeechToTextProvider(undefined));
    await start(session);

    expect(messages).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'api_key_missing',
        retryable: false,
      }),
    ]);
    expect(JSON.stringify(messages)).not.toContain('STT_API_KEY');
  });

  it('rejects invalid JSON and closes provider resources on disconnect', async () => {
    const provider = new RecordingProvider();
    const { session, messages } = createSession(provider);
    await session.handleText('{invalid');
    await start(session);
    await session.close();

    expect(messages[0]).toMatchObject({ type: 'error', code: 'invalid_json' });
    expect(provider.closedSessions).toEqual(['session-1']);
  });

  it('resumes the same session from the last received sequence without double processing', async () => {
    const provider = new RecordingProvider();
    const registry = new TranscriptionSessionRegistry(() => provider, { resumeTtlMs: 60_000, maxSessions: 2 });
    const firstMessages: ServerMessage[] = [];
    const first = new TranscriptionWebSocketSession(
      provider,
      { connectionTimeoutMs: 60_000, audioIdleTimeoutMs: 60_000 },
      (message) => firstMessages.push(message),
      vi.fn(),
      registry,
    );
    sessions.push(first);
    await start(first);
    await first.handleBinary(new Uint8Array(encodeAudioFrame('session-1', 0, new Uint8Array([1]).buffer)));
    await first.close();
    provider.emitTranscript({
      sessionId: 'session-1', segmentId: 'late-final', revision: 0, text: 'late result',
      isFinal: true, language: 'ja', startTime: 1, endTime: 2,
    });

    const resumedMessages: ServerMessage[] = [];
    const resumed = new TranscriptionWebSocketSession(
      provider,
      { connectionTimeoutMs: 60_000, audioIdleTimeoutMs: 60_000 },
      (message) => resumedMessages.push(message),
      vi.fn(),
      registry,
    );
    sessions.push(resumed);
    await resumed.handleText(JSON.stringify({
      type: 'resume', sessionId: 'session-1', language: 'ja',
      audioFormat: 'audio/webm;codecs=opus', lastAcknowledgedSequence: -1,
    }));
    expect(resumedMessages[0]).toEqual({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: 0 });
    expect(resumedMessages[1]).toMatchObject({ type: 'transcript', segmentId: 'late-final', text: 'late result' });
    await resumed.handleBinary(new Uint8Array(encodeAudioFrame('session-1', 0, new Uint8Array([1]).buffer)));
    await resumed.handleBinary(new Uint8Array(encodeAudioFrame('session-1', 1, new Uint8Array([2]).buffer)));
    expect(provider.audioSequences).toEqual([0, 1]);
    expect(resumedMessages.filter((message) => message.type === 'audio_ack').map((message) => message.sequence)).toEqual([0, 1]);
    await registry.closeAll();
  });

  it('selects local-whisper and acknowledges PCM only after it is accepted once', async () => {
    const provider = new RecordingProvider();
    const requestedProviders: Array<string | undefined> = [];
    const registry = new TranscriptionSessionRegistry((requested) => {
      requestedProviders.push(requested);
      return provider;
    }, { resumeTtlMs: 60_000, maxSessions: 2 });
    const messages: ServerMessage[] = [];
    const session = new TranscriptionWebSocketSession(
      provider,
      { connectionTimeoutMs: 60_000, audioIdleTimeoutMs: 60_000 },
      (message) => messages.push(message),
      vi.fn(),
      registry,
    );
    sessions.push(session);
    await session.handleText(JSON.stringify({
      type: 'start', sessionId: 'local-session', language: 'ja', provider: 'local-whisper',
      audioFormat: 'audio/pcm;rate=16000;channels=1;format=s16le',
    }));
    const metadata: AudioFrameMetadata = {
      capturedAt: 1_234, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 2,
    };
    const frame = new Uint8Array(encodeAudioFrame(
      'local-session', 0, new Uint8Array([1, 0, 2, 0]).buffer, metadata,
    ));
    await session.handleBinary(frame);
    await session.handleBinary(frame);

    expect(requestedProviders).toEqual(['local-whisper']);
    expect(provider.audioSequences).toEqual([0]);
    expect(provider.audioMetadata).toEqual([metadata]);
    expect(messages.filter((message) => message.type === 'audio_ack')).toEqual([
      { type: 'audio_ack', sessionId: 'local-session', sequence: 0 },
      { type: 'audio_ack', sessionId: 'local-session', sequence: 0 },
    ]);
    await registry.closeAll();
  });

  it('answers ping with pong without changing the active session', async () => {
    const { session, messages } = createSession();
    await start(session);
    await session.handleText(JSON.stringify({ type: 'ping', sessionId: 'session-1' }));

    expect(messages.at(-1)).toEqual({ type: 'pong', sessionId: 'session-1' });
  });

  it('rejects resume safely after the session TTL expires', async () => {
    vi.useFakeTimers();
    const provider = new RecordingProvider();
    const registry = new TranscriptionSessionRegistry(() => provider, { resumeTtlMs: 1_000, maxSessions: 2 });
    const first = new TranscriptionWebSocketSession(
      provider,
      { connectionTimeoutMs: 60_000, audioIdleTimeoutMs: 60_000 },
      vi.fn(),
      vi.fn(),
      registry,
    );
    sessions.push(first);
    await start(first);
    await first.close();
    await vi.advanceTimersByTimeAsync(1_001);

    const messages: ServerMessage[] = [];
    const resumed = new TranscriptionWebSocketSession(
      provider,
      { connectionTimeoutMs: 60_000, audioIdleTimeoutMs: 60_000 },
      (message) => messages.push(message),
      vi.fn(),
      registry,
    );
    sessions.push(resumed);
    await resumed.handleText(JSON.stringify({
      type: 'resume', sessionId: 'session-1', language: 'ja',
      audioFormat: 'audio/webm;codecs=opus', lastAcknowledgedSequence: -1,
    }));

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'error', code: 'session_not_found', retryable: false,
    }));
    await registry.closeAll();
  });

  it('never resumes a stopped session even while it is inside the TTL', async () => {
    const provider = new RecordingProvider();
    const registry = new TranscriptionSessionRegistry(() => provider, { resumeTtlMs: 60_000, maxSessions: 2 });
    const first = new TranscriptionWebSocketSession(
      provider,
      { connectionTimeoutMs: 60_000, audioIdleTimeoutMs: 60_000 },
      vi.fn(),
      vi.fn(),
      registry,
    );
    sessions.push(first);
    await start(first);
    await first.handleText(JSON.stringify({ type: 'stop', sessionId: 'session-1' }));

    const messages: ServerMessage[] = [];
    const resumed = new TranscriptionWebSocketSession(
      provider,
      { connectionTimeoutMs: 60_000, audioIdleTimeoutMs: 60_000 },
      (message) => messages.push(message),
      vi.fn(),
      registry,
    );
    sessions.push(resumed);
    await resumed.handleText(JSON.stringify({
      type: 'resume', sessionId: 'session-1', language: 'ja',
      audioFormat: 'audio/webm;codecs=opus', lastAcknowledgedSequence: -1,
    }));

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'error', code: 'session_stopped', retryable: false,
    }));
    await registry.closeAll();
  });
});

class RecordingProvider implements ServerSpeechToTextProvider {
  readonly id = 'recording';
  readonly closedSessions: string[] = [];
  readonly audioSequences: number[] = [];
  readonly audioMetadata: Array<AudioFrameMetadata | undefined> = [];
  private startedSessionId = '';
  private transcriptCallback: (result: ServerTranscriptResult) => void = () => undefined;
  async startSession(options: { sessionId: string }): Promise<void> { this.startedSessionId = options.sessionId; }
  async sendAudio(options: {
    sessionId: string; sequence: number; audio: Uint8Array; metadata?: AudioFrameMetadata;
  }): Promise<void> {
    void options.sessionId;
    void options.audio;
    this.audioSequences.push(options.sequence);
    this.audioMetadata.push(options.metadata);
  }
  async stopSession(): Promise<void> {}
  async dispose(): Promise<void> { this.closedSessions.push(this.startedSessionId); }
  onTranscript(callback: (result: ServerTranscriptResult) => void): void { this.transcriptCallback = callback; }
  onError(callback: (error: ServerProviderError) => void): void { void callback; }
  emitTranscript(result: ServerTranscriptResult): void { this.transcriptCallback(result); }
}
