// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createPcm16MonoWav } from './pcmToWav.js';

describe('createPcm16MonoWav', () => {
  it('writes a valid PCM16 mono 16 kHz header and unchanged samples', () => {
    const pcm = Uint8Array.from([1, 2, 3, 4]);
    const before = Uint8Array.from(pcm);
    const wav = createPcm16MonoWav(pcm);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([...pcm]);
    expect(pcm).toEqual(before);
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt16LE(32)).toBe(2);
  });

  it('rejects empty and incomplete PCM frames', () => {
    expect(() => createPcm16MonoWav(new Uint8Array())).toThrow();
    expect(() => createPcm16MonoWav(Uint8Array.of(1))).toThrow();
  });
});
