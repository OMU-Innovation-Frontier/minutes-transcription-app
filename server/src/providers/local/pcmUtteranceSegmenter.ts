export interface VadConfiguration {
  sampleRate: 16_000;
  analysisWindowMs: number;
  silenceDurationMs: number;
  maxUtteranceDurationMs: number;
  minimumUtteranceDurationMs: number;
  preSpeechBufferMs: number;
  rmsThreshold: number;
  noiseFloorMultiplier: number;
  speechStartWindows: number;
}

export interface PcmUtterance {
  pcm: Buffer;
  startFrame: number;
  endFrame: number;
  audioDurationMs: number;
  sequenceStart: number;
  sequenceEnd: number;
  reason: 'silence' | 'max_duration' | 'session_stop';
  adaptiveNoiseFloor: number;
}

interface BufferedWindow {
  samples: Int16Array;
  startFrame: number;
  sequence: number;
}

interface SegmenterState {
  totalFrames: number;
  preSpeech: BufferedWindow[];
  preSpeechFrames: number;
  activeWindows: BufferedWindow[];
  activeFrames: number;
  activeStartFrame: number;
  sequenceStart: number;
  sequenceEnd: number;
  trailingSilenceFrames: number;
  consecutiveSpeechWindows: number;
  noiseFloorRms: number;
}

export const DEFAULT_VAD_CONFIGURATION: VadConfiguration = {
  sampleRate: 16_000,
  analysisWindowMs: 20,
  silenceDurationMs: 1_300,
  maxUtteranceDurationMs: 20_000,
  minimumUtteranceDurationMs: 300,
  preSpeechBufferMs: 300,
  rmsThreshold: 0.012,
  noiseFloorMultiplier: 3,
  speechStartWindows: 2,
};

export class PcmUtteranceSegmenter {
  private state: SegmenterState = initialState();
  private readonly windowFrames: number;
  private readonly silenceFrames: number;
  private readonly maxFrames: number;
  private readonly minimumFrames: number;
  private readonly preSpeechFramesLimit: number;

  constructor(private readonly config: VadConfiguration = DEFAULT_VAD_CONFIGURATION) {
    validateVadConfiguration(config);
    this.windowFrames = millisecondsToFrames(config.analysisWindowMs, config.sampleRate);
    this.silenceFrames = millisecondsToFrames(config.silenceDurationMs, config.sampleRate);
    this.maxFrames = millisecondsToFrames(config.maxUtteranceDurationMs, config.sampleRate);
    this.minimumFrames = millisecondsToFrames(config.minimumUtteranceDurationMs, config.sampleRate);
    this.preSpeechFramesLimit = millisecondsToFrames(config.preSpeechBufferMs, config.sampleRate);
  }

  accept(sequence: number, pcm: Uint8Array): PcmUtterance[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('sequence must be a non-negative integer.');
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new RangeError('PCM16 data must contain complete non-empty frames.');
    const samples = new Int16Array(pcm.byteLength / 2);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true);
    const utterances: PcmUtterance[] = [];
    for (let offset = 0; offset < samples.length; offset += this.windowFrames) {
      const window = samples.slice(offset, Math.min(samples.length, offset + this.windowFrames));
      const finalized = this.acceptWindow(sequence, window);
      if (finalized) utterances.push(finalized);
    }
    return utterances;
  }

  flush(): PcmUtterance[] {
    if (this.state.activeFrames < this.minimumFrames) {
      this.resetSpeechState();
      return [];
    }
    return [this.finalize('session_stop')];
  }

  snapshot(): SegmenterState {
    return cloneState(this.state);
  }

  restore(snapshot: SegmenterState): void {
    this.state = cloneState(snapshot);
  }

  private acceptWindow(sequence: number, samples: Int16Array): PcmUtterance | undefined {
    const startFrame = this.state.totalFrames;
    this.state.totalFrames += samples.length;
    const rms = calculatePcm16Rms(samples);
    const threshold = Math.max(this.config.rmsThreshold, this.state.noiseFloorRms * this.config.noiseFloorMultiplier);
    const speech = rms >= threshold;
    const window: BufferedWindow = { samples, startFrame, sequence };

    if (this.state.activeFrames === 0) {
      this.pushPreSpeech(window);
      if (speech) this.state.consecutiveSpeechWindows += 1;
      else {
        this.state.consecutiveSpeechWindows = 0;
        this.state.noiseFloorRms = this.state.noiseFloorRms * 0.95 + rms * 0.05;
      }
      if (this.state.consecutiveSpeechWindows >= this.config.speechStartWindows) this.beginSpeech();
      return undefined;
    }

    this.state.activeWindows.push(window);
    this.state.activeFrames += samples.length;
    this.state.sequenceEnd = sequence;
    this.state.trailingSilenceFrames = speech ? 0 : this.state.trailingSilenceFrames + samples.length;
    if (this.state.activeFrames >= this.maxFrames) return this.finalize('max_duration');
    if (this.state.trailingSilenceFrames >= this.silenceFrames && this.state.activeFrames >= this.minimumFrames) {
      return this.finalize('silence');
    }
    return undefined;
  }

  private pushPreSpeech(window: BufferedWindow): void {
    this.state.preSpeech.push(window);
    this.state.preSpeechFrames += window.samples.length;
    while (this.state.preSpeechFrames > this.preSpeechFramesLimit && this.state.preSpeech.length > 1) {
      const removed = this.state.preSpeech.shift();
      if (removed) this.state.preSpeechFrames -= removed.samples.length;
    }
  }

  private beginSpeech(): void {
    const first = this.state.preSpeech[0];
    const last = this.state.preSpeech.at(-1);
    if (!first || !last) return;
    this.state.activeWindows = this.state.preSpeech;
    this.state.activeFrames = this.state.preSpeechFrames;
    this.state.activeStartFrame = first.startFrame;
    this.state.sequenceStart = first.sequence;
    this.state.sequenceEnd = last.sequence;
    this.state.preSpeech = [];
    this.state.preSpeechFrames = 0;
    this.state.trailingSilenceFrames = 0;
  }

  private finalize(reason: PcmUtterance['reason']): PcmUtterance {
    const samples = concatenateSamples(this.state.activeWindows, this.state.activeFrames);
    const startFrame = this.state.activeStartFrame;
    const endFrame = startFrame + samples.length;
    const sequenceStart = this.state.sequenceStart;
    const sequenceEnd = this.state.sequenceEnd;
    const adaptiveNoiseFloor = this.state.noiseFloorRms;
    this.resetSpeechState();
    return {
      pcm: int16ToBuffer(samples), startFrame, endFrame,
      audioDurationMs: samples.length / this.config.sampleRate * 1_000,
      sequenceStart, sequenceEnd, reason, adaptiveNoiseFloor,
    };
  }

  private resetSpeechState(): void {
    this.state.preSpeech = [];
    this.state.preSpeechFrames = 0;
    this.state.activeWindows = [];
    this.state.activeFrames = 0;
    this.state.activeStartFrame = this.state.totalFrames;
    this.state.sequenceStart = -1;
    this.state.sequenceEnd = -1;
    this.state.trailingSilenceFrames = 0;
    this.state.consecutiveSpeechWindows = 0;
  }
}

export function calculatePcm16Rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let squareSum = 0;
  for (const sample of samples) {
    const normalized = sample / 32_768;
    squareSum += normalized * normalized;
  }
  return Math.sqrt(squareSum / samples.length);
}

export function validateVadConfiguration(config: VadConfiguration): void {
  const durations = [config.analysisWindowMs, config.silenceDurationMs, config.maxUtteranceDurationMs,
    config.minimumUtteranceDurationMs, config.preSpeechBufferMs];
  if (config.sampleRate !== 16_000 || durations.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || config.analysisWindowMs > 100 || config.silenceDurationMs >= config.maxUtteranceDurationMs
    || config.minimumUtteranceDurationMs >= config.maxUtteranceDurationMs
    || config.preSpeechBufferMs >= config.maxUtteranceDurationMs
    || !Number.isFinite(config.rmsThreshold) || config.rmsThreshold <= 0 || config.rmsThreshold >= 1
    || !Number.isFinite(config.noiseFloorMultiplier) || config.noiseFloorMultiplier < 1
    || !Number.isSafeInteger(config.speechStartWindows) || config.speechStartWindows < 1 || config.speechStartWindows > 20) {
    throw new RangeError('Invalid VAD configuration.');
  }
}

function initialState(): SegmenterState {
  return {
    totalFrames: 0, preSpeech: [], preSpeechFrames: 0, activeWindows: [], activeFrames: 0,
    activeStartFrame: 0, sequenceStart: -1, sequenceEnd: -1, trailingSilenceFrames: 0,
    consecutiveSpeechWindows: 0, noiseFloorRms: 0.003,
  };
}

function cloneState(state: SegmenterState): SegmenterState {
  return {
    ...state,
    preSpeech: state.preSpeech.map(cloneWindow),
    activeWindows: state.activeWindows.map(cloneWindow),
  };
}

function cloneWindow(window: BufferedWindow): BufferedWindow {
  return { ...window, samples: window.samples.slice() };
}

function millisecondsToFrames(milliseconds: number, sampleRate: number): number {
  return Math.round(milliseconds * sampleRate / 1_000);
}

function concatenateSamples(windows: BufferedWindow[], frameCount: number): Int16Array {
  const output = new Int16Array(frameCount);
  let offset = 0;
  for (const window of windows) {
    output.set(window.samples, offset);
    offset += window.samples.length;
  }
  return output;
}

function int16ToBuffer(samples: Int16Array): Buffer {
  const output = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) output.writeInt16LE(samples[index] ?? 0, index * 2);
  return output;
}
