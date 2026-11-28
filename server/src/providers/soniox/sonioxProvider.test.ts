// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { loadServerConfig } from '../../config.js';
import { GROQ_PCM_MIME_TYPE } from '../groq/groqWhisperServerProvider.js';
import { SonioxProvider, type SonioxSocket } from './sonioxProvider.js';
import { parseSonioxResult } from './sonioxTranscript.js';

it('uses the corrected secret first and only assigns the old name to Soniox when explicitly configured', () => {
  const formerValue = String(true);
  const correctedValue = String(false);
  expect(loadServerConfig({ SONIX_API_KEY: formerValue })).toMatchObject({ sonixApiKey: formerValue, sonioxApiKey: undefined });
  expect(loadServerConfig({ SONIX_API_KEY: formerValue, SONIOX_LEGACY_KEY_NAME: 'true' })).toMatchObject({
    sonixApiKey: undefined, sonioxApiKey: formerValue,
  });
  expect(loadServerConfig({ SONIX_API_KEY: formerValue, SONIOX_API_KEY: correctedValue, SONIOX_LEGACY_KEY_NAME: 'true' })).toMatchObject({
    sonixApiKey: undefined, sonioxApiKey: correctedValue,
  });
});

it('streams audio, revises provisional text, and preserves anonymous labels through finalization', async () => {
  const sessionId = 'synthetic-session';
  let receive: (data: unknown) => void = () => undefined;
  const socket: SonioxSocket = {
    bufferedAmount: 0, send: vi.fn(), close: vi.fn(),
    listen: (onMessage) => { receive = onMessage; },
  };
  const connect = vi.fn(async () => socket);
  const provider = new SonioxProvider({ externalEnabled: true, apiKey: String(true) }, connect);
  const results = vi.fn();
  provider.onTranscript(results);
  try {
    await provider.startSession({ sessionId, language: 'ja', mimeType: GROQ_PCM_MIME_TYPE });
    expect(socket.send).toHaveBeenNthCalledWith(1, JSON.stringify({
      model: 'stt-rt-v6', audio_format: 'pcm_s16le', sample_rate: 16_000, num_channels: 1,
      language_hints: ['ja'], enable_speaker_diarization: true,
    }));
    const audio = new Uint8Array(3_200);
    await provider.sendAudio({ sessionId, sequence: 0, audio,
      metadata: { capturedAt: 1_100, frameCount: 1_600, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le' } });
    expect(socket.send).toHaveBeenNthCalledWith(2, audio);
    receive(JSON.stringify({ tokens: [{ text: '合成の途中', speaker: '2', is_final: false }] }));
    expect(results).toHaveBeenLastCalledWith(expect.objectContaining({
      text: '話者A　合成の途中', isFinal: false, provider: 'soniox',
    }));
    receive(JSON.stringify({ tokens: [
      { text: '一番。', speaker: '2', is_final: true, start_ms: 0, end_ms: 40 },
      { text: '二番。', speaker: '1', is_final: true, start_ms: 40, end_ms: 80 },
    ] }));
    const stopping = provider.stopSession(sessionId);
    expect(socket.send).toHaveBeenLastCalledWith('');
    receive(JSON.stringify({ tokens: [{ text: '三番。', speaker: '2', is_final: true, start_ms: 80, end_ms: 100 }], finished: true }));
    await stopping;
    expect(results.mock.calls.map(([result]) => result).filter((result) => result.isFinal)).toEqual([
      expect.objectContaining({ text: '一番。', speakerLabel: '話者A', startTime: 1_000 }),
      expect.objectContaining({ text: '二番。', speakerLabel: '話者B' }),
      expect.objectContaining({ text: '三番。', speakerLabel: '話者A', endTime: 1_100 }),
    ]);
    expect(socket.close).toHaveBeenCalledOnce();
  } finally {
    await provider.dispose();
  }
});

it('preserves the disconnect stage when a queued audio frame arrives after the socket closes', async () => {
  let closeByPeer: (code: number) => void = () => undefined;
  const socket: SonioxSocket = {
    bufferedAmount: 0, send: vi.fn(), close: vi.fn(),
    listen: (_onMessage, onEnd) => { closeByPeer = onEnd; },
  };
  const provider = new SonioxProvider({ externalEnabled: true, apiKey: String(true) }, async () => socket);
  const onError = vi.fn();
  provider.onError(onError);
  const sessionId = 'synthetic-session';
  await provider.startSession({ sessionId, language: 'ja', mimeType: GROQ_PCM_MIME_TYPE });
  try {
    closeByPeer(1006);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'soniox_closed_before_audio',
      safeMessage: expect.stringContaining('1006'),
    }));
    await expect(provider.sendAudio({ sessionId, sequence: 0, audio: new Uint8Array(3_200) }))
      .rejects.toBe(onError.mock.calls[0]?.[0]);
  } finally {
    await provider.dispose();
  }
});

it('reports the billing category without passing the upstream error text to the user', () => {
  let failure: unknown;
  try {
    parseSonioxResult(JSON.stringify({ error_code: 402, error_message: 'upstream detail' }));
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'soniox_billing', safeMessage: expect.stringContaining('402') });
  expect(failure).not.toMatchObject({ safeMessage: expect.stringContaining('upstream detail') });
});
