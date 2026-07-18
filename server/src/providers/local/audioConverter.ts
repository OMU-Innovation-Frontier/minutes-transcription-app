import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { LocalProcessManager, validateExistingFile } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';

const SUPPORTED_INPUT_EXTENSIONS = new Set(['.wav', '.webm', '.ogg', '.mp3']);

export interface PreparedLocalAudio {
  wavPath: string;
  durationSeconds: number;
  converted: boolean;
  deleteAfterUse: boolean;
  format: PcmWavInspection;
}

export interface PcmWavInspection {
  durationSeconds: number;
  audioFormat: 1;
  channels: 1;
  sampleRate: 16_000;
  bitsPerSample: 16;
  dataBytes: number;
}

export interface PcmWavQualityInspection extends PcmWavInspection {
  riff: 'RIFF';
  wave: 'WAVE';
  riffDeclaredBytes: number;
  fileBytes: number;
  signedPcm: true;
  littleEndian: true;
  byteRate: 32_000;
  blockAlign: 2;
  durationMs: number;
  rms: number;
  peak: number;
  clippingRatio: number;
  dcOffset: number;
  lowAmplitudeRatio: number;
  lowAmplitudeThreshold: number;
  first300MsRms: number;
  last300MsRms: number;
  incompletePcmFrame: false;
  silentWarning: boolean;
  clippingWarning: boolean;
}

export interface AudioConverterOptions {
  ffmpegPath?: string;
  allowedAudioRoots: readonly string[];
  allowedBinaryRoots: readonly string[];
  temporaryDirectory: string;
  timeoutMs: number;
}

export class LocalAudioConverter {
  constructor(
    private readonly options: AudioConverterOptions,
    private readonly processes: LocalProcessManager,
  ) {}

  async prepare(sourcePath: string): Promise<PreparedLocalAudio> {
    const source = await validateExistingFile(
      sourcePath,
      this.options.allowedAudioRoots,
      'local_audio_invalid',
      'The local audio file is missing or outside the configured input directory.',
    );
    const extension = extname(source).toLocaleLowerCase();
    if (!SUPPORTED_INPUT_EXTENSIONS.has(extension)) {
      throw new LocalSttError('local_audio_format_unsupported', 'The local audio format is not supported.');
    }
    if (extension === '.wav') {
      try {
        const wav = await inspectPcm16Mono16kWav(source, this.options.allowedAudioRoots);
        return { wavPath: source, durationSeconds: wav.durationSeconds, converted: false, deleteAfterUse: false, format: wav };
      } catch (error) {
        if (!(error instanceof LocalSttError) || error.code !== 'local_wav_format_unsupported') throw error;
      }
    }
    if (!this.options.ffmpegPath) {
      throw new LocalSttError(
        'local_ffmpeg_missing',
        'ffmpeg is required to convert this audio to 16 kHz mono PCM WAV, but no local executable is configured.',
      );
    }
    await mkdir(this.options.temporaryDirectory, { recursive: true });
    const outputPath = resolve(this.options.temporaryDirectory, `local-stt-${randomUUID()}.wav`);
    await this.processes.run({
      executablePath: this.options.ffmpegPath,
      allowedExecutableRoots: this.options.allowedBinaryRoots,
      timeoutMs: this.options.timeoutMs,
      arguments: [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-i', source,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath,
      ],
    });
    const wav = await inspectPcm16Mono16kWav(outputPath, [this.options.temporaryDirectory]);
    return { wavPath: outputPath, durationSeconds: wav.durationSeconds, converted: true, deleteAfterUse: true, format: wav };
  }
}

export async function inspectPcm16Mono16kWav(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<PcmWavInspection> {
  const validated = await validateExistingFile(
    filePath,
    allowedRoots,
    'local_audio_invalid',
    'The local audio file is missing or outside the configured input directory.',
  );
  const handle = await open(validated, 'r');
  try {
    const header = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const data = header.subarray(0, bytesRead);
    if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
      throw unsupportedWav();
    }
    let offset = 12;
    let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
    let dataBytes: number | undefined;
    while (offset + 8 <= data.length) {
      const chunkId = data.toString('ascii', offset, offset + 4);
      const chunkSize = data.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      if (chunkId === 'fmt ' && chunkSize >= 16 && chunkStart + 16 <= data.length) {
        format = {
          audioFormat: data.readUInt16LE(chunkStart),
          channels: data.readUInt16LE(chunkStart + 2),
          sampleRate: data.readUInt32LE(chunkStart + 4),
          bitsPerSample: data.readUInt16LE(chunkStart + 14),
        };
      }
      if (chunkId === 'data') {
        dataBytes = chunkSize;
        break;
      }
      offset = chunkStart + chunkSize + (chunkSize % 2);
    }
    if (!format || dataBytes === undefined || format.audioFormat !== 1 || format.channels !== 1
      || format.sampleRate !== 16_000 || format.bitsPerSample !== 16) {
      throw unsupportedWav();
    }
    return {
      durationSeconds: dataBytes / (format.sampleRate * format.channels * (format.bitsPerSample / 8)),
      audioFormat: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
      dataBytes,
    };
  } finally {
    await handle.close();
  }
}

export async function inspectPcm16Mono16kWavQuality(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<PcmWavQualityInspection> {
  const validated = await validateExistingFile(
    filePath,
    allowedRoots,
    'local_audio_invalid',
    'The local audio file is missing or outside the configured input directory.',
  );
  const basic = await inspectPcm16Mono16kWav(validated, allowedRoots);
  const wav = await readFile(validated);
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw unsupportedWav();
  }
  const riffDeclaredBytes = wav.readUInt32LE(4) + 8;
  let offset = 12;
  let byteRate: number | undefined;
  let blockAlign: number | undefined;
  let dataOffset: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > wav.length) throw unsupportedWav();
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      byteRate = wav.readUInt32LE(chunkStart + 8);
      blockAlign = wav.readUInt16LE(chunkStart + 12);
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataBytes = chunkSize;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (riffDeclaredBytes !== wav.length || byteRate !== 32_000 || blockAlign !== 2
    || dataOffset === undefined || dataBytes === undefined || dataBytes !== basic.dataBytes
    || dataBytes % 2 !== 0) {
    throw unsupportedWav();
  }
  let squareSum = 0;
  let sampleSum = 0;
  let peak = 0;
  let clippedSamples = 0;
  let lowAmplitudeSamples = 0;
  const lowAmplitudeThreshold = 0.01;
  const sampleCount = dataBytes / 2;
  const firstWindowSamples: number[] = [];
  const lastWindowSamples: number[] = [];
  const diagnosticWindowFrames = Math.min(sampleCount, Math.round(16_000 * 0.3));
  for (let sampleOffset = dataOffset; sampleOffset < dataOffset + dataBytes; sampleOffset += 2) {
    const sample = wav.readInt16LE(sampleOffset) / 32_768;
    const absolute = Math.abs(sample);
    squareSum += sample * sample;
    sampleSum += sample;
    peak = Math.max(peak, absolute);
    if (absolute >= 0.99) clippedSamples += 1;
    if (absolute < lowAmplitudeThreshold) lowAmplitudeSamples += 1;
    const sampleIndex = (sampleOffset - dataOffset) / 2;
    if (sampleIndex < diagnosticWindowFrames) firstWindowSamples.push(sample);
    if (sampleIndex >= sampleCount - diagnosticWindowFrames) lastWindowSamples.push(sample);
  }
  const rms = sampleCount === 0 ? 0 : Math.sqrt(squareSum / sampleCount);
  const clippingRatio = sampleCount === 0 ? 0 : clippedSamples / sampleCount;
  return {
    ...basic,
    riff: 'RIFF',
    wave: 'WAVE',
    riffDeclaredBytes,
    fileBytes: wav.length,
    signedPcm: true,
    littleEndian: true,
    byteRate: 32_000,
    blockAlign: 2,
    durationMs: basic.durationSeconds * 1_000,
    rms,
    peak,
    clippingRatio,
    dcOffset: sampleCount === 0 ? 0 : sampleSum / sampleCount,
    lowAmplitudeRatio: sampleCount === 0 ? 1 : lowAmplitudeSamples / sampleCount,
    lowAmplitudeThreshold,
    first300MsRms: calculateNormalizedRms(firstWindowSamples),
    last300MsRms: calculateNormalizedRms(lastWindowSamples),
    incompletePcmFrame: false,
    silentWarning: rms < 0.003,
    clippingWarning: clippingRatio > 0.001,
  };
}

function calculateNormalizedRms(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  let squareSum = 0;
  for (const sample of samples) squareSum += sample * sample;
  return Math.sqrt(squareSum / samples.length);
}

function unsupportedWav(): LocalSttError {
  return new LocalSttError(
    'local_wav_format_unsupported',
    'The WAV file must be uncompressed 16-bit, 16 kHz, mono PCM.',
  );
}
