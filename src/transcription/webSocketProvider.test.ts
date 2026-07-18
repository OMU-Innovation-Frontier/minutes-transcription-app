import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeAudioFrame } from '../../shared/protocol';
import type { AudioChunk } from '../audio/types';
import { MemoryPendingAudioStorage, PendingAudioQueue } from '../audio/pendingAudioQueue';
import { WebSocketSpeechToTextProvider } from './webSocketProvider';
import type {
  StartTranscriptionOptions,
  TranscriptUpdate,
  TranscriptionError,
  TranscriptionState,
} from './types';

const providers: WebSocketSpeechToTextProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.abort()));
  vi.useRealTimers();
});

function createHarness(dependencies: ConstructorParameters<typeof WebSocketSpeechToTextProvider>[0] = {}) {
  const sockets: FakeWebSocket[] = [];
  const states: TranscriptionState[] = [];
  const updates: TranscriptUpdate[] = [];
  const errors: TranscriptionError[] = [];
  const warnings: TranscriptionError[] = [];
  const reconnects: Array<{ attempt: number; maximum: number; delay: number }> = [];
  const buffered: Awaited<ReturnType<PendingAudioQueue['snapshot']>>[] = [];
  const queue = new PendingAudioQueue({
    maxSeconds: 60,
    maxBytes: 1_000,
    storage: new MemoryPendingAudioStorage(),
    onChange: (snapshot) => buffered.push(snapshot),
  });
  const provider = new WebSocketSpeechToTextProvider({
    url: 'ws://localhost:8787/transcription',
    createWebSocket: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    queue,
    random: () => 0.5,
    ...dependencies,
  });
  providers.push(provider);
  return { provider, queue, sockets, states, updates, errors, warnings, reconnects, buffered };
}

function options(
  harness: ReturnType<typeof createHarness>,
  sessionId = 'session-1',
): StartTranscriptionOptions {
  return {
    sessionId,
    language: 'ja-JP',
    audioFormat: 'audio/webm;codecs=opus',
    callbacks: {
      onStateChange: (state) => harness.states.push(state),
      onTranscript: (update) => harness.updates.push(update),
      onError: (error) => harness.errors.push(error),
      onWarning: (warning) => harness.warnings.push(warning),
      onReconnectAttempt: (attempt, maximum, delay) => harness.reconnects.push({ attempt, maximum, delay }),
      onBufferedAudioChange: (snapshot) => harness.buffered.push(snapshot),
    },
  };
}

function chunk(sequence: number): AudioChunk {
  const data = new Blob([new Uint8Array([sequence + 1])]);
  Object.defineProperty(data, 'arrayBuffer', {
    value: async () => new Uint8Array([sequence + 1]).buffer,
  });
  return {
    sequence,
    capturedAt: sequence * 1_000,
    mimeType: 'audio/webm;codecs=opus',
    data,
  };
}

function localPcmChunk(sequence: number): AudioChunk {
  const bytes = new Uint8Array([sequence + 1, 0]);
  const data = new Blob([bytes]);
  Object.defineProperty(data, 'arrayBuffer', { value: async () => bytes.buffer });
  return {
    sequence, capturedAt: sequence * 1_000,
    mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le', data,
    sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 1,
  };
}

async function connect(harness: ReturnType<typeof createHarness>, sessionId = 'session-1'): Promise<FakeWebSocket> {
  const started = harness.provider.start(options(harness, sessionId));
  const socket = harness.sockets.at(-1);
  if (!socket) throw new Error('socket was not created');
  socket.open();
  socket.message({ type: 'ready', sessionId });
  await started;
  return socket;
}

describe('WebSocketSpeechToTextProvider', () => {
  it('connects and sends start metadata before audio', async () => {
    const harness = createHarness();
    const socket = await connect(harness);

    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'start',
      sessionId: 'session-1',
      language: 'ja',
      audioFormat: 'audio/webm;codecs=opus',
    });
    expect(harness.states).toEqual(['connecting', 'ready']);
  });

  it('sends sequenced binary audio only after ready', async () => {
    const harness = createHarness();
    const startPromise = harness.provider.start(options(harness));
    const socket = harness.sockets[0];
    if (!socket) throw new Error('socket was not created');
    socket.open();
    const audioPromise = harness.provider.acceptChunk(chunk(0));
    expect(socket.sent).toHaveLength(1);

    socket.message({ type: 'ready', sessionId: 'session-1' });
    await Promise.all([startPromise, audioPromise]);
    await harness.provider.acceptChunk(chunk(1));

    const frames = socket.sent.slice(1).map((value) => decodeAudioFrame(value as ArrayBuffer));
    expect(frames.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(harness.states).toContain('ready');
  });

  it('selects Local Whisper, sends PCM metadata, and exposes final-only recognition status', async () => {
    const harness = createHarness({ mode: 'local-whisper' });
    const started = harness.provider.start({
      ...options(harness),
      audioFormat: 'audio/pcm;rate=16000;channels=1;format=s16le',
    });
    const socket = harness.sockets[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ provider: 'local-whisper' });
    socket.message({ type: 'ready', sessionId: 'session-1' });
    await started;
    const data = new Blob([new Uint8Array(640)]);
    Object.defineProperty(data, 'arrayBuffer', { value: async () => new Uint8Array(640).buffer });
    await harness.provider.acceptChunk({
      sequence: 0, capturedAt: 123, mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le', data,
      sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 320,
    });
    const frame = decodeAudioFrame(socket.sent[1] as ArrayBuffer);
    expect(frame.metadata).toEqual({ capturedAt: 123, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 320 });
    socket.message({
      type: 'recognition_status', sessionId: 'session-1', state: 'recognizing', queueLength: 1,
      model: 'whisper-small-q5_1', language: 'ja', audioDurationMs: 500,
    });
    expect(harness.states.at(-1)).toBe('recognizing');
    socket.message({
      type: 'transcript', sessionId: 'session-1', segmentId: 'u1', revision: 0, text: '確定結果',
      isFinal: true, language: 'ja', startTime: 1, endTime: 2, provider: 'local-whisper',
      model: 'whisper-small-q5_1', processingTimeMs: 250, audioDurationMs: 500, realTimeFactor: 0.5,
    });
    expect(harness.updates[0]).toMatchObject({ isFinal: true, provider: 'local-whisper', model: 'whisper-small-q5_1', realTimeFactor: 0.5 });
  });

  it('sends stop and cleans up after stopped', async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    const stopped = harness.provider.stop();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'stop', sessionId: 'session-1' });

    socket.message({ type: 'stopped', sessionId: 'session-1' });
    await stopped;
    expect(socket.close).toHaveBeenCalledOnce();
    expect(harness.states.at(-1)).toBe('disconnected');
  });

  it('reconnects on normal stop, replays unacknowledged audio, then sends stop', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ mode: 'local-whisper' });
    const first = await connect(harness);
    await harness.provider.acceptChunk(localPcmChunk(0));
    first.disconnect();
    const stopped = harness.provider.stop();

    await vi.advanceTimersByTimeAsync(500);
    const resumed = harness.sockets[1]!;
    resumed.open();
    resumed.message({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: -1 });
    await vi.waitFor(() => expect(resumed.sent.some((item) => item instanceof ArrayBuffer)).toBe(true));
    const replay = resumed.sent.find((item) => item instanceof ArrayBuffer) as ArrayBuffer;
    expect(decodeAudioFrame(replay).sequence).toBe(0);
    resumed.message({ type: 'audio_ack', sessionId: 'session-1', sequence: 0 });
    await vi.waitFor(() => expect(resumed.sent.some((item) => typeof item === 'string'
      && JSON.parse(item).type === 'stop')).toBe(true));
    resumed.message({ type: 'stopped', sessionId: 'session-1' });
    await stopped;
    expect((await harness.queue.snapshot('session-1')).chunkCount).toBe(0);
  });

  it('rejects stale sessions and duplicate transcript revisions', async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    const transcript = {
      type: 'transcript',
      sessionId: 'session-1',
      segmentId: 'segment-1',
      revision: 0,
      text: '暫定',
      isFinal: false,
      language: 'ja',
      startTime: 1,
    };
    socket.message({ ...transcript, sessionId: 'old-session' });
    socket.message(transcript);
    socket.message(transcript);

    expect(harness.updates).toHaveLength(1);
  });

  it('ignores events from an old WebSocket generation', async () => {
    const harness = createHarness();
    const oldSocket = await connect(harness, 'session-1');
    const oldMessageHandler = oldSocket.onmessage;
    oldSocket.disconnect();

    const newSocket = await connect(harness, 'session-2');
    oldMessageHandler?.(new MessageEvent('message', { data: JSON.stringify({
      type: 'transcript',
      sessionId: 'session-2',
      segmentId: 'stale',
      revision: 0,
      text: '古い接続',
      isFinal: true,
      language: 'ja',
      startTime: 1,
      endTime: 2,
    }) }));
    newSocket.message({
      type: 'transcript',
      sessionId: 'session-2',
      segmentId: 'new',
      revision: 0,
      text: '新しい接続',
      isFinal: true,
      language: 'ja',
      startTime: 1,
      endTime: 2,
    });

    expect(harness.updates.map(({ text }) => text)).toEqual(['新しい接続']);
  });

  it('shows safe server errors and allows a new session after disconnect', async () => {
    const harness = createHarness();
    const firstSocket = await connect(harness, 'session-1');
    firstSocket.message({
      type: 'error',
      sessionId: 'session-1',
      code: 'api_key_missing',
      message: 'APIキーがサーバーに設定されていません。',
      retryable: false,
    });
    expect(harness.errors.at(-1)).toMatchObject({ code: 'configuration' });

    const secondSocket = await connect(harness, 'session-2');
    expect(secondSocket).not.toBe(firstSocket);
    expect(harness.states).toContain('error');
    expect(harness.states.filter((state) => state === 'ready')).toHaveLength(2);
  });

  it('reports reconnecting without stopping the active recording session', async () => {
    const harness = createHarness();
    const socket = await connect(harness);
    socket.disconnect();

    expect(harness.states).toContain('reconnecting');
    expect(harness.states.at(-1)).toBe('reconnecting');
    expect(harness.errors).toHaveLength(0);
  });

  it('starts only one reconnect when error and close both fire', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = await connect(harness);
    const staleClose = first.onclose;

    first.error();
    staleClose?.(new CloseEvent('close', { code: 1006 }));
    await vi.advanceTimersByTimeAsync(500);

    expect(harness.sockets).toHaveLength(2);
    expect(harness.reconnects.filter(({ attempt }) => attempt === 1)).toHaveLength(1);
    expect(harness.errors).toHaveLength(0);
  });

  it('moves an offline reconnect forward on online and waits for resumed before replaying', async () => {
    vi.useFakeTimers();
    const network = new FakeNetworkEvents();
    let online = true;
    const harness = createHarness({ networkEvents: network, isOnline: () => online });
    const first = await connect(harness);
    await harness.provider.acceptChunk(chunk(0));
    first.message({ type: 'audio_ack', sessionId: 'session-1', sequence: 0 });
    await vi.waitFor(async () => expect((await harness.queue.snapshot('session-1')).chunkCount).toBe(0));

    online = false;
    network.emit('offline');
    await harness.provider.acceptChunk(chunk(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.states.at(-1)).toBe('reconnecting');

    online = true;
    network.emit('online');
    expect(harness.sockets).toHaveLength(2);
    const resumed = harness.sockets[1]!;
    resumed.open();
    expect(JSON.parse(resumed.sent[0] as string)).toMatchObject({ type: 'resume', sessionId: 'session-1' });
    expect(resumed.sent).toHaveLength(1);
    expect(harness.states.at(-1)).toBe('resuming');

    resumed.message({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: 0 });
    await vi.waitFor(() => expect(resumed.sent).toHaveLength(2));
    expect(decodeAudioFrame(resumed.sent[1] as ArrayBuffer).sequence).toBe(1);
    expect(harness.states).toContain('replaying');
    resumed.message({ type: 'audio_ack', sessionId: 'session-1', sequence: 1 });
    await vi.waitFor(() => expect(harness.states.at(-1)).toBe('transcribing'));
    expect((await harness.queue.snapshot('session-1')).durationSeconds).toBe(0);
    expect(harness.errors).toHaveLength(0);
  });

  it('replays sent but unacknowledged chunks and omits server-confirmed chunks', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = await connect(harness);
    await harness.provider.acceptChunk(chunk(0));
    await harness.provider.acceptChunk(chunk(1));
    expect((await harness.queue.snapshot('session-1')).sentUnacknowledgedCount).toBe(2);
    first.disconnect();

    await vi.advanceTimersByTimeAsync(500);
    const resumed = harness.sockets[1]!;
    resumed.open();
    resumed.message({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: 0 });
    await vi.waitFor(() => expect(resumed.sent).toHaveLength(2));
    expect(decodeAudioFrame(resumed.sent[1] as ArrayBuffer).sequence).toBe(1);
    resumed.message({ type: 'audio_ack', sessionId: 'session-1', sequence: 1 });
    await vi.waitFor(async () => expect((await harness.queue.snapshot('session-1')).chunkCount).toBe(0));
  });

  it('keeps unacknowledged replay data when disconnected again', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = await connect(harness);
    first.disconnect();
    await harness.provider.acceptChunk(chunk(0));

    await vi.advanceTimersByTimeAsync(500);
    const second = harness.sockets[1]!;
    second.open();
    second.message({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: -1 });
    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    second.disconnect();
    expect((await harness.queue.snapshot('session-1')).sentUnacknowledgedCount).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    const third = harness.sockets[2]!;
    third.open();
    third.message({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: -1 });
    await vi.waitFor(() => expect(third.sent).toHaveLength(2));
    expect(decodeAudioFrame(third.sent[1] as ArrayBuffer).sequence).toBe(0);
    third.message({ type: 'audio_ack', sessionId: 'session-1', sequence: 0 });
    await vi.waitFor(() => expect(harness.states.at(-1)).toBe('transcribing'));
  });

  it('ignores stale close and error callbacks after a newer generation opens', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = await connect(harness);
    const staleClose = first.onclose;
    const staleError = first.onerror;
    first.disconnect();
    await vi.advanceTimersByTimeAsync(500);
    const second = harness.sockets[1]!;
    second.open();
    second.message({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: -1 });
    await vi.waitFor(() => expect(harness.states.at(-1)).toBe('transcribing'));

    staleError?.(new Event('error'));
    staleClose?.(new CloseEvent('close', { code: 1006 }));
    expect(harness.sockets).toHaveLength(2);
    expect(harness.states.at(-1)).toBe('transcribing');
  });

  it('does not reconnect after recording is stopped', async () => {
    vi.useFakeTimers();
    const network = new FakeNetworkEvents();
    const harness = createHarness({ networkEvents: network });
    const socket = await connect(harness);
    const stopped = harness.provider.stop();
    socket.message({ type: 'stopped', sessionId: 'session-1' });
    await stopped;
    network.emit('offline');
    network.emit('online');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.states.at(-1)).toBe('disconnected');
  });

  it('queues disconnected audio and resumes only missing sequences in order', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = await connect(harness);
    await harness.provider.acceptChunk(chunk(0));
    first.disconnect();
    await harness.provider.acceptChunk(chunk(1));
    expect((await harness.provider.getBufferedAudioSnapshot()).chunkCount).toBe(2);

    await vi.advanceTimersByTimeAsync(500);
    const resumed = harness.sockets[1];
    if (!resumed) throw new Error('resume socket was not created');
    resumed.open();
    expect(JSON.parse(resumed.sent[0] as string)).toMatchObject({
      type: 'resume', sessionId: 'session-1', lastAcknowledgedSequence: -1,
    });
    resumed.message({ type: 'resumed', sessionId: 'session-1', lastReceivedSequence: 0 });
    await vi.waitFor(() => expect(resumed.sent).toHaveLength(2));
    expect(decodeAudioFrame(resumed.sent[1] as ArrayBuffer).sequence).toBe(1);
    resumed.message({ type: 'audio_ack', sessionId: 'session-1', sequence: 1 });
    await vi.waitFor(async () => expect((await harness.provider.getBufferedAudioSnapshot()).chunkCount).toBe(0));
    vi.useRealTimers();
  });

  it('uses exponential reconnect delays', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ reconnectBaseDelayMs: 500, reconnectMaxDelayMs: 5_000 });
    const first = await connect(harness);
    first.disconnect();
    await vi.advanceTimersByTimeAsync(499);
    expect(harness.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sockets).toHaveLength(2);
    harness.sockets[1]?.open();
    harness.sockets[1]?.disconnect();
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sockets).toHaveLength(3);
    vi.useRealTimers();
  });

  it('detects a half-open connection when heartbeat pong never arrives', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 2_000 });
    const socket = await connect(harness);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'ping', sessionId: 'session-1' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.states.at(-1)).toBe('reconnecting');
    expect(harness.errors).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.sockets).toHaveLength(2);
  });

  it('stops automatic retries at the configured maximum and allows manual reconnect', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ reconnectMaxAttempts: 1 });
    const first = await connect(harness);
    first.disconnect();
    await vi.advanceTimersByTimeAsync(500);
    harness.sockets[1]?.open();
    harness.sockets[1]?.disconnect();
    expect(harness.states.at(-1)).toBe('error');
    expect(harness.errors.at(-1)?.message).toContain('上限');
    harness.provider.reconnect();
    expect(harness.sockets).toHaveLength(3);
    expect(harness.states.at(-1)).toBe('reconnecting');
    vi.useRealTimers();
  });
});

class FakeWebSocket {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: (string | ArrayBuffer)[] = [];
  readonly close = vi.fn(() => { this.readyState = 3; });

  send(data: string | ArrayBuffer): void { this.sent.push(data); }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  message(value: object): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
  disconnect(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code: 1006 }));
  }
  error(): void {
    this.onerror?.(new Event('error'));
  }
}

class FakeNetworkEvents {
  private readonly listeners = new Map<'online' | 'offline', Set<EventListener>>();

  addEventListener(type: 'online' | 'offline', listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'online' | 'offline', listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'online' | 'offline'): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}
