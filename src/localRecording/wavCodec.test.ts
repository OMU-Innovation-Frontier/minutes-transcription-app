import { describe, expect, it } from 'vitest';
import {
  encodePcm16MonoWav,
  inspectAudioQuality,
  inspectPcm16Mono16kWav,
  resampleMono,
} from './wavCodec';

describe('local evaluation WAV encoding', () => {
  it('resamples browser-rate mono audio to exactly 16 kHz', () => {
    const input = new Float32Array(48_000).fill(0.25);
    const output = resampleMono(input, 48_000, 16_000);
    expect(output).toHaveLength(16_000);
    expect(output[8_000]).toBeCloseTo(0.25, 5);
  });

  it('writes and rereads a signed 16-bit little-endian PCM WAV header', () => {
    const wav = encodePcm16MonoWav(new Float32Array([-1, 0, 1]));
    const format = inspectPcm16Mono16kWav(wav);
    expect(format).toMatchObject({
      valid: true,
      audioFormat: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
      byteRate: 32_000,
      blockAlign: 2,
      dataBytes: 6,
    });
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(32_767);
  });

  it('rejects a WAV whose reread sample rate is not 16 kHz', () => {
    const wav = encodePcm16MonoWav(new Float32Array(100));
    new DataView(wav).setUint32(24, 8_000, true);
    expect(inspectPcm16Mono16kWav(wav)).toMatchObject({ valid: false });
  });

  it('flags a silent recording using a documented simple threshold', () => {
    expect(inspectAudioQuality(new Float32Array(16_000))).toMatchObject({ silent: true, clipped: false });
  });

  it('flags sustained clipping without rejecting the WAV container', () => {
    const quality = inspectAudioQuality(new Float32Array(16_000).fill(1));
    expect(quality).toMatchObject({ silent: false, clipped: true, peak: 1, clippingRatio: 1 });
  });
});
