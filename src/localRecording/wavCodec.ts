export const LOCAL_RECORDING_SAMPLE_RATE = 16_000;

export interface WavFormatInspection {
  valid: boolean;
  audioFormat?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  byteRate?: number;
  blockAlign?: number;
  dataBytes?: number;
  durationMs?: number;
  errors: string[];
}

export interface AudioQualityInspection {
  rms: number;
  peak: number;
  clippingRatio: number;
  silent: boolean;
  clipped: boolean;
}

export function resampleMono(samples: Float32Array, sourceSampleRate: number, targetSampleRate = LOCAL_RECORDING_SAMPLE_RATE): Float32Array {
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0
    || !Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    throw new RangeError('Sample rates must be positive finite numbers.');
  }
  if (samples.length === 0 || sourceSampleRate === targetSampleRate) return samples.slice();
  const outputLength = Math.max(1, Math.round(samples.length * targetSampleRate / sourceSampleRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceSampleRate / targetSampleRate;
  if (ratio <= 1) {
    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * ratio;
      const left = Math.min(samples.length - 1, Math.floor(sourcePosition));
      const right = Math.min(samples.length - 1, left + 1);
      const fraction = sourcePosition - left;
      output[index] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
    }
    return output;
  }
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = outputIndex * ratio;
    const end = Math.min(samples.length, (outputIndex + 1) * ratio);
    const first = Math.floor(start);
    const last = Math.min(samples.length - 1, Math.ceil(end) - 1);
    let weightedSum = 0;
    let totalWeight = 0;
    for (let sourceIndex = first; sourceIndex <= last; sourceIndex += 1) {
      const weight = Math.max(0, Math.min(end, sourceIndex + 1) - Math.max(start, sourceIndex));
      weightedSum += (samples[sourceIndex] ?? 0) * weight;
      totalWeight += weight;
    }
    output[outputIndex] = totalWeight > 0 ? weightedSum / totalWeight : 0;
  }
  return output;
}

export function encodePcm16MonoWav(samples: Float32Array, sampleRate = LOCAL_RECORDING_SAMPLE_RATE): ArrayBuffer {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be a positive integer.');
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(encodePcm16Mono(samples)));
  return buffer;
}

export function encodePcm16Mono(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767), true);
  }
  return buffer;
}

export function inspectPcm16Mono16kWav(buffer: ArrayBuffer): WavFormatInspection {
  const errors: string[] = [];
  if (buffer.byteLength < 44) return { valid: false, errors: ['WAVヘッダーが44 bytes未満です。'] };
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF') errors.push('RIFF識別子がありません。');
  if (readAscii(view, 8, 4) !== 'WAVE') errors.push('WAVE識別子がありません。');
  let offset = 12;
  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let byteRate: number | undefined;
  let blockAlign: number | undefined;
  let bitsPerSample: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > view.byteLength) {
      errors.push(`${chunkId || '不明'}チャンクがファイル範囲を超えています。`);
      break;
    }
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      byteRate = view.getUint32(chunkStart + 8, true);
      blockAlign = view.getUint16(chunkStart + 12, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (audioFormat === undefined) errors.push('fmtチャンクがありません。');
  if (dataBytes === undefined) errors.push('dataチャンクがありません。');
  if (audioFormat !== undefined && audioFormat !== 1) errors.push('エンコーディングがPCMではありません。');
  if (channels !== undefined && channels !== 1) errors.push('チャンネル数がmonoではありません。');
  if (sampleRate !== undefined && sampleRate !== LOCAL_RECORDING_SAMPLE_RATE) errors.push('サンプルレートが16000 Hzではありません。');
  if (bitsPerSample !== undefined && bitsPerSample !== 16) errors.push('量子化ビット数が16-bitではありません。');
  if (byteRate !== undefined && byteRate !== LOCAL_RECORDING_SAMPLE_RATE * 2) errors.push('byte rateがPCM形式と一致しません。');
  if (blockAlign !== undefined && blockAlign !== 2) errors.push('block alignがPCM形式と一致しません。');
  if (dataBytes !== undefined && dataBytes % 2 !== 0) errors.push('PCMデータ長が16-bit境界に一致しません。');
  return {
    valid: errors.length === 0,
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    byteRate,
    blockAlign,
    dataBytes,
    durationMs: dataBytes === undefined || sampleRate === undefined || channels === undefined || bitsPerSample === undefined
      ? undefined
      : dataBytes / (sampleRate * channels * (bitsPerSample / 8)) * 1_000,
    errors,
  };
}

export function inspectAudioQuality(samples: Float32Array): AudioQualityInspection {
  if (samples.length === 0) return { rms: 0, peak: 0, clippingRatio: 0, silent: true, clipped: false };
  let squareSum = 0;
  let peak = 0;
  let clippedSamples = 0;
  for (const rawSample of samples) {
    const sample = Math.max(-1, Math.min(1, rawSample));
    const absolute = Math.abs(sample);
    squareSum += sample * sample;
    peak = Math.max(peak, absolute);
    if (absolute >= 0.99) clippedSamples += 1;
  }
  const rms = Math.sqrt(squareSum / samples.length);
  const clippingRatio = clippedSamples / samples.length;
  return {
    rms,
    peak,
    clippingRatio,
    silent: rms < 0.003,
    clipped: clippingRatio > 0.001,
  };
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function readAscii(view: DataView, offset: number, length: number): string {
  if (offset < 0 || offset + length > view.byteLength) return '';
  return String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)));
}
