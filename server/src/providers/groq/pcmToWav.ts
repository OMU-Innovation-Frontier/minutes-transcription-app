import { ServerProviderError } from '../types.js';

export const GROQ_PCM_SAMPLE_RATE = 16_000;

export function createPcm16MonoWav(pcm: Uint8Array): Buffer {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new ServerProviderError('groq_pcm_invalid', false, '受信したPCM音声が不正です。');
  }
  const wav = Buffer.allocUnsafe(44 + pcm.byteLength);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(GROQ_PCM_SAMPLE_RATE, 24);
  wav.writeUInt32LE(GROQ_PCM_SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(wav, 44);
  return wav;
}
