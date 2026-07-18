import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_CONSTRAINTS,
  AudioCapture,
  DEFAULT_CHUNK_DURATION_MS,
  selectSupportedAudioMimeType,
} from './audioCapture';
import type { AudioChunk, CaptureState, MicrophoneError } from './types';

class MockMediaRecorder extends EventTarget {
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm';
  start = vi.fn((timeslice?: number) => {
    this.state = 'recording';
    this.lastTimeslice = timeslice;
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.dispatchEvent(new Event('stop'));
  });
  lastTimeslice?: number;

  emitChunk(data: Blob): void {
    const event = new Event('dataavailable') as BlobEvent;
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
}

function createHarness(getUserMedia?: ReturnType<typeof vi.fn>, sink?: (chunk: AudioChunk) => void | Promise<void>) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMediaMock = getUserMedia ?? vi.fn().mockResolvedValue(stream);

  const recorder = new MockMediaRecorder();
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    getByteTimeDomainData: vi.fn((values: Uint8Array) => values.fill(128)),
  } as unknown as AnalyserNode;
  const source = { connect: vi.fn() };
  const processor = { onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null, connect: vi.fn(), disconnect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const audioContext = {
    state: 'running',
    sampleRate: 48_000,
    destination: {},
    createAnalyser: () => analyser,
    createMediaStreamSource: () => source,
    createScriptProcessor: () => processor,
    createGain: () => gain,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;

  const chunks: AudioChunk[] = [];
  const states: CaptureState[] = [];
  const errors: MicrophoneError[] = [];
  const sinkErrors: unknown[] = [];
  const capture = new AudioCapture(
    { handle: sink ?? ((chunk) => { chunks.push(chunk); }) },
    {
      onStateChange: (state) => states.push(state),
      onError: (error) => errors.push(error),
      onSinkError: (error) => sinkErrors.push(error),
    },
    {
      mediaDevices: { getUserMedia: getUserMediaMock } as unknown as MediaDevices,
      createMediaRecorder: () => recorder as unknown as MediaRecorder,
      createAudioContext: () => audioContext,
      requestAnimationFrame: vi.fn(() => 17),
      cancelAnimationFrame: vi.fn(),
      now: () => 1_234,
    },
  );

  return { capture, getUserMedia: getUserMediaMock, recorder, chunks, states, errors, sinkErrors, track, audioContext, processor };
}

describe('AudioCapture', () => {
  it('selects the first browser-supported Opus container without assuming one format', () => {
    const isTypeSupported = vi.fn((mimeType: string) => mimeType === 'audio/ogg;codecs=opus');
    expect(selectSupportedAudioMimeType({ isTypeSupported })).toBe('audio/ogg;codecs=opus');
    expect(isTypeSupported).toHaveBeenCalledWith('audio/webm;codecs=opus');
  });

  it('requests raw microphone audio and starts one-second chunks', async () => {
    const harness = createHarness();

    await harness.capture.start();

    expect(harness.getUserMedia).toHaveBeenCalledWith({
      audio: AUDIO_CONSTRAINTS,
      video: false,
    });
    expect(AUDIO_CONSTRAINTS).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(harness.recorder.start).toHaveBeenCalledWith(DEFAULT_CHUNK_DURATION_MS);
    expect(harness.states).toEqual(['starting', 'recording']);
  });

  it('emits sequenced audio chunks through the replaceable sink', async () => {
    const harness = createHarness();
    await harness.capture.start();

    harness.recorder.emitChunk(new Blob(['first'], { type: 'audio/webm' }));
    harness.recorder.emitChunk(new Blob(['second'], { type: 'audio/webm' }));

    expect(harness.chunks).toHaveLength(2);
    expect(harness.chunks.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(harness.chunks[0]).toMatchObject({ capturedAt: 1_234, mimeType: 'audio/webm' });
  });

  it('captures Local Whisper audio as one-second 16 kHz mono PCM16 without MediaRecorder', async () => {
    const harness = createHarness();
    await harness.capture.start('pcm16-16khz');
    const channel = new Float32Array(48_000).fill(0.25);
    harness.processor.onaudioprocess?.({
      inputBuffer: {
        length: channel.length,
        numberOfChannels: 1,
        getChannelData: () => channel,
      } as unknown as AudioBuffer,
    } as AudioProcessingEvent);
    expect(harness.recorder.start).not.toHaveBeenCalled();
    expect(harness.capture.currentMimeType).toBe('audio/pcm;rate=16000;channels=1;format=s16le');
    expect(harness.chunks).toHaveLength(1);
    expect(harness.chunks[0]).toMatchObject({
      sequence: 0, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 16_000,
    });
    expect(harness.chunks[0]?.data.size).toBe(32_000);
    await harness.capture.stop();
  });

  it('stops the recorder, media tracks, and audio context', async () => {
    const harness = createHarness();
    await harness.capture.start();

    await harness.capture.stop();

    expect(harness.recorder.stop).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.audioContext.close).toHaveBeenCalledOnce();
    expect(harness.capture.currentState).toBe('idle');
  });

  it('reports permission denial and returns to idle', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const harness = createHarness(getUserMedia);

    await expect(harness.capture.start()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(harness.errors).toHaveLength(1);
    expect(harness.capture.currentState).toBe('idle');
  });

  it('reports unsupported browser capabilities before requesting access', async () => {
    const errors: MicrophoneError[] = [];
    const capture = new AudioCapture(
      { handle: vi.fn() },
      { onError: (error) => errors.push(error) },
      {
        mediaDevices: {} as MediaDevices,
        createMediaRecorder: undefined,
        createAudioContext: undefined,
      },
    );

    await expect(capture.start()).rejects.toMatchObject({ code: 'unsupported' });
    expect(errors[0]?.code).toBe('unsupported');
  });

  it('can start and stop repeatedly without overlapping microphone sessions', async () => {
    const harness = createHarness();

    await harness.capture.start();
    await harness.capture.start();
    await harness.capture.stop();
    await harness.capture.start();
    await harness.capture.stop();

    expect(harness.getUserMedia).toHaveBeenCalledTimes(2);
    expect(harness.recorder.start).toHaveBeenCalledTimes(2);
    expect(harness.recorder.stop).toHaveBeenCalledTimes(2);
    expect(harness.capture.currentState).toBe('idle');
  });

  it('can start again after a microphone permission error', async () => {
    const harness = createHarness();
    harness.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));

    await expect(harness.capture.start()).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(harness.capture.start()).resolves.toBeUndefined();

    expect(harness.capture.currentState).toBe('recording');
    await harness.capture.stop();
  });

  it('returns to idle and releases the track when AudioContext cleanup fails', async () => {
    const harness = createHarness();
    vi.mocked(harness.audioContext.close).mockRejectedValueOnce(new Error('close failed'));
    await harness.capture.start();

    await expect(harness.capture.stop()).rejects.toThrow('close failed');

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.capture.currentState).toBe('idle');
  });

  it('keeps MediaRecorder running when the communication sink fails', async () => {
    const harness = createHarness(undefined, async () => { throw new Error('WebSocket disconnected'); });
    await harness.capture.start();
    harness.recorder.emitChunk(new Blob(['audio'], { type: 'audio/webm' }));
    await vi.waitFor(() => expect(harness.sinkErrors).toHaveLength(1));
    expect(harness.capture.currentState).toBe('recording');
    expect(harness.recorder.stop).not.toHaveBeenCalled();
    await harness.capture.stop();
  });
});
