import { toMicrophoneError } from './errors';
import {
  type AudioCaptureMode,
  type AudioCaptureCallbacks,
  type AudioChunkSink,
  type CaptureState,
  MicrophoneError,
} from './types';
import { encodePcm16Mono, resampleMono } from '../localRecording/wavCodec';

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const DEFAULT_CHUNK_DURATION_MS = 1_000;
const PCM_SAMPLE_RATE = 16_000;
const PCM_FRAMES_PER_CHUNK = PCM_SAMPLE_RATE * DEFAULT_CHUNK_DURATION_MS / 1_000;
const AUDIO_MIME_TYPE_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/ogg',
] as const;

export interface AudioCaptureDependencies {
  mediaDevices?: MediaDevices;
  createMediaRecorder?: (stream: MediaStream, mimeType?: string) => MediaRecorder;
  createAudioContext?: () => AudioContext;
  requestAnimationFrame?: typeof window.requestAnimationFrame;
  cancelAnimationFrame?: typeof window.cancelAnimationFrame;
  now?: () => number;
}

export class AudioCapture {
  private state: CaptureState = 'idle';
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private pcmProcessor: ScriptProcessorNode | null = null;
  private pcmMutedOutput: GainNode | null = null;
  private pcmChunks: Float32Array[] = [];
  private pcmFrameCount = 0;
  private animationFrame: number | null = null;
  private sequence = 0;
  private mimeType = 'application/octet-stream';
  private readonly pendingSinkOperations = new Set<Promise<void>>();

  private readonly mediaDevices: MediaDevices | undefined;
  private readonly createMediaRecorder: ((stream: MediaStream, mimeType?: string) => MediaRecorder) | undefined;
  private readonly createAudioContext: (() => AudioContext) | undefined;
  private readonly requestFrame: typeof window.requestAnimationFrame;
  private readonly cancelFrame: typeof window.cancelAnimationFrame;
  private readonly now: () => number;

  constructor(
    private readonly sink: AudioChunkSink,
    private readonly callbacks: AudioCaptureCallbacks = {},
    dependencies: AudioCaptureDependencies = {},
  ) {
    this.mediaDevices = dependencies.mediaDevices ?? navigator.mediaDevices;
    this.createMediaRecorder = dependencies.createMediaRecorder ??
      (typeof MediaRecorder === 'undefined'
        ? undefined
        : (stream, mimeType) => new MediaRecorder(stream, mimeType ? { mimeType } : undefined));
    this.createAudioContext = dependencies.createAudioContext ?? getAudioContextFactory();
    this.requestFrame = dependencies.requestAnimationFrame ?? window.requestAnimationFrame.bind(window);
    this.cancelFrame = dependencies.cancelAnimationFrame ?? window.cancelAnimationFrame.bind(window);
    this.now = dependencies.now ?? Date.now;
  }

  get currentState(): CaptureState {
    return this.state;
  }

  get currentMimeType(): string {
    return this.mimeType;
  }

  async start(mode: AudioCaptureMode = 'media-recorder'): Promise<void> {
    if (this.state !== 'idle') return;

    if (!this.mediaDevices?.getUserMedia || !this.createAudioContext
      || (mode === 'media-recorder' && !this.createMediaRecorder)) {
      const error = new MicrophoneError(
        'unsupported',
        'このブラウザはマイク録音に対応していません。最新版のChrome、Edge、Firefox、Safariをお試しください。',
      );
      this.callbacks.onError?.(error);
      throw error;
    }

    this.setState('starting');

    try {
      this.stream = await this.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
      this.setupLevelMeter(this.stream);
      this.sequence = 0;
      if (mode === 'pcm16-16khz') this.setupPcmCapture(this.stream);
      else {
        this.setupRecorder(this.stream);
        const recorder = this.recorder;
        if (!recorder) throw new MicrophoneError('unsupported', '音声レコーダーを初期化できませんでした。');
        recorder.start(DEFAULT_CHUNK_DURATION_MS);
      }
      this.setState('recording');
      this.measureLevel();
    } catch (cause) {
      await this.releaseResources();
      const error = toMicrophoneError(cause);
      this.setState('error');
      this.callbacks.onError?.(error);
      this.setState('idle');
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopping') return;

    this.setState('stopping');
    const recorder = this.recorder;
    let firstError: unknown;

    try {
      if (recorder && recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder.addEventListener('stop', () => resolve(), { once: true });
          recorder.stop();
        });
      }
      if (this.pcmProcessor) this.flushPcmFrames();
      await Promise.allSettled(this.pendingSinkOperations);
    } catch (error) {
      firstError = error;
    }

    try {
      await this.releaseResources();
    } catch (error) {
      firstError ??= error;
    }
    this.callbacks.onLevel?.(0);
    this.setState('idle');
    if (firstError) throw firstError;
  }

  private setupRecorder(stream: MediaStream): void {
    const preferredMimeType = selectSupportedAudioMimeType();
    const recorder = this.createMediaRecorder?.(stream, preferredMimeType);
    if (!recorder) throw new MicrophoneError('unsupported', 'このブラウザでは音声をチャンク化できません。');
    this.mimeType = recorder.mimeType || preferredMimeType || 'application/octet-stream';

    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size === 0) return;
      const chunk = {
        sequence: this.sequence++,
        capturedAt: this.now(),
        mimeType: event.data.type || this.mimeType,
        data: event.data,
      };
      this.dispatchChunk(chunk);
    });

    this.recorder = recorder;
  }

  private setupPcmCapture(stream: MediaStream): void {
    const context = this.audioContext;
    if (!context) throw new MicrophoneError('unsupported', 'PCM録音用AudioContextを初期化できませんでした。');
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, Math.max(1, source.channelCount || 1), 1);
    const mutedOutput = context.createGain();
    mutedOutput.gain.value = 0;
    this.pcmChunks = [];
    this.pcmFrameCount = 0;
    this.mimeType = 'audio/pcm;rate=16000;channels=1;format=s16le';
    processor.onaudioprocess = (event) => {
      const mono = downmix(event.inputBuffer);
      const resampled = resampleMono(mono, context.sampleRate, PCM_SAMPLE_RATE);
      this.pcmChunks.push(resampled);
      this.pcmFrameCount += resampled.length;
      while (this.pcmFrameCount >= PCM_FRAMES_PER_CHUNK) this.emitPcmFrames(PCM_FRAMES_PER_CHUNK);
    };
    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(context.destination);
    this.pcmProcessor = processor;
    this.pcmMutedOutput = mutedOutput;
  }

  private flushPcmFrames(): void {
    if (this.pcmFrameCount > 0) this.emitPcmFrames(this.pcmFrameCount);
  }

  private emitPcmFrames(frameCount: number): void {
    const samples = takeFrames(this.pcmChunks, frameCount);
    this.pcmFrameCount -= samples.length;
    if (samples.length === 0) return;
    const pcm = encodePcm16Mono(samples);
    this.dispatchChunk({
      sequence: this.sequence++, capturedAt: this.now(), mimeType: this.mimeType,
      data: new Blob([pcm], { type: this.mimeType }), sampleRate: PCM_SAMPLE_RATE,
      channels: 1, encoding: 'pcm_s16le', frameCount: samples.length,
    });
  }

  private dispatchChunk(chunk: Parameters<AudioChunkSink['handle']>[0]): void {
    const operation = Promise.resolve(this.sink.handle(chunk))
      .catch((error: unknown) => this.callbacks.onSinkError?.(error))
      .finally(() => this.pendingSinkOperations.delete(operation));
    this.pendingSinkOperations.add(operation);
  }

  private setupLevelMeter(stream: MediaStream): void {
    const context = this.createAudioContext?.();
    if (!context) throw new MicrophoneError('unsupported', 'このブラウザでは入力レベルを表示できません。');

    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    context.createMediaStreamSource(stream).connect(analyser);
    this.audioContext = context;
    this.analyser = analyser;
  }

  private measureLevel = (): void => {
    if (this.state !== 'recording' || !this.analyser) return;

    const values = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(values);
    let sumSquares = 0;
    for (const value of values) {
      const normalized = (value - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / values.length);
    this.callbacks.onLevel?.(Math.min(1, rms * 4));
    this.animationFrame = this.requestFrame(this.measureLevel);
  };

  private async releaseResources(): Promise<void> {
    if (this.animationFrame !== null) this.cancelFrame(this.animationFrame);
    this.animationFrame = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    if (this.pcmProcessor) this.pcmProcessor.onaudioprocess = null;
    this.pcmProcessor?.disconnect();
    this.pcmMutedOutput?.disconnect();
    this.pcmProcessor = null;
    this.pcmMutedOutput = null;
    this.pcmChunks = [];
    this.pcmFrameCount = 0;
    this.analyser = null;
    const context = this.audioContext;
    this.audioContext = null;
    if (context && context.state !== 'closed') await context.close();
  }

  private setState(state: CaptureState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
}

function getAudioContextFactory(): (() => AudioContext) | undefined {
  const AudioContextConstructor = window.AudioContext;
  return AudioContextConstructor ? () => new AudioContextConstructor() : undefined;
}

export function selectSupportedAudioMimeType(
  recorderType: Pick<typeof MediaRecorder, 'isTypeSupported'> | undefined =
    typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
): string | undefined {
  if (!recorderType?.isTypeSupported) return undefined;
  return AUDIO_MIME_TYPE_CANDIDATES.find((mimeType) => recorderType.isTypeSupported(mimeType));
}

export { AUDIO_CONSTRAINTS, AUDIO_MIME_TYPE_CANDIDATES, DEFAULT_CHUNK_DURATION_MS };

function downmix(buffer: AudioBuffer): Float32Array {
  const output = new Float32Array(buffer.length);
  const channels = Math.max(1, buffer.numberOfChannels);
  for (let channel = 0; channel < channels; channel += 1) {
    const input = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    for (let index = 0; index < output.length; index += 1) output[index] = (output[index] ?? 0) + (input[index] ?? 0) / channels;
  }
  return output;
}

function takeFrames(chunks: Float32Array[], requested: number): Float32Array {
  const output = new Float32Array(requested);
  let written = 0;
  while (written < requested && chunks.length > 0) {
    const first = chunks[0];
    if (!first) break;
    const count = Math.min(first.length, requested - written);
    output.set(first.subarray(0, count), written);
    written += count;
    if (count === first.length) chunks.shift();
    else chunks[0] = first.slice(count);
  }
  return written === requested ? output : output.slice(0, written);
}
