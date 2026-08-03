// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GroqWhisperClient } from './groqWhisperClient.js';
import { GroqWhisperRuntime } from './groqWhisperRuntime.js';
import { GROQ_PCM_MIME_TYPE, GroqWhisperServerProvider } from './groqWhisperServerProvider.js';
import { GroqWhisperUsageGuard } from './groqWhisperUsageGuard.js';

describe('GroqWhisperServerProvider', () => {
  it.each([
    [false, 'placeholder', 'groq_external_disabled'],
    [true, undefined, 'groq_api_key_missing'],
  ])('requires server opt-in and credentials before start', async (externalEnabled, apiKey, code) => {
    const { provider, runtime, fetchMock } = createProvider({ externalEnabled, apiKey });
    await expect(provider.startSession({ sessionId: 'session', language: 'ja', mimeType: GROQ_PCM_MIME_TYPE }))
      .rejects.toMatchObject({ code });
    expect(fetchMock).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('rejects an unsupported MIME type before sending audio', async () => {
    const { provider, runtime, fetchMock } = createProvider();
    await expect(provider.startSession({ sessionId: 'session', language: 'ja', mimeType: 'audio/webm' }))
      .rejects.toMatchObject({ code: 'groq_audio_format_unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('does not send silence', async () => {
    const { provider, runtime, fetchMock } = createProvider();
    await provider.startSession({ sessionId: 'session', language: 'en', mimeType: GROQ_PCM_MIME_TYPE });
    const audio = new Uint8Array(16_000);
    await provider.sendAudio({ sessionId: 'session', sequence: 0, audio,
      metadata: { capturedAt: 0, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 8_000 } });
    await provider.stopSession('session');
    expect(fetchMock).not.toHaveBeenCalled();
    await provider.dispose();
    await runtime.close();
  });

  it('finalizes at the maximum utterance duration', async () => {
    const { provider, runtime, fetchMock } = createProvider({
      vad: { speechStartWindows: 1, preSpeechBufferMs: 20, minimumUtteranceDurationMs: 100,
        maxUtteranceDurationMs: 1_000, silenceDurationMs: 500, rmsThreshold: 0.001 },
    });
    await provider.startSession({ sessionId: 'session', language: 'ja', mimeType: GROQ_PCM_MIME_TYPE });
    const audio = voicedPcm(16_000);
    await provider.sendAudio({ sessionId: 'session', sequence: 0, audio,
      metadata: { capturedAt: 0, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 16_000 } });
    await provider.stopSession('session');
    expect(fetchMock).toHaveBeenCalledOnce();
    await provider.dispose();
    await runtime.close();
  });

  it('waits for an in-flight final result before stop resolves', async () => {
    let release: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ text: 'late result' }), { headers: { 'content-type': 'application/json' } });
    });
    const { provider, runtime } = createProvider({ fetch: fetchMock,
      vad: { speechStartWindows: 1, preSpeechBufferMs: 20, minimumUtteranceDurationMs: 100, rmsThreshold: 0.001 } });
    const transcripts = vi.fn();
    provider.onTranscript(transcripts);
    await provider.startSession({ sessionId: 'session', language: 'en', mimeType: GROQ_PCM_MIME_TYPE });
    const audio = voicedPcm(8_000);
    await provider.sendAudio({ sessionId: 'session', sequence: 0, audio,
      metadata: { capturedAt: 0, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 8_000 } });
    let stopped = false;
    const stopping = provider.stopSession('session').then(() => { stopped = true; });
    await waitFor(() => fetchMock.mock.calls.length === 1);
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(transcripts).toHaveBeenCalledOnce();
    await provider.dispose();
    await runtime.close();
  });

  it('coalesces repeated stop calls without a duplicate flush or request', async () => {
    let release: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ text: 'single result' }), { headers: { 'content-type': 'application/json' } });
    });
    const { provider, runtime } = createProvider({ fetch: fetchMock,
      vad: { speechStartWindows: 1, preSpeechBufferMs: 20, minimumUtteranceDurationMs: 100, rmsThreshold: 0.001 } });
    const transcripts = vi.fn();
    provider.onTranscript(transcripts);
    await provider.startSession({ sessionId: 'session', language: 'ja', mimeType: GROQ_PCM_MIME_TYPE });
    await provider.sendAudio({ sessionId: 'session', sequence: 0, audio: voicedPcm(8_000),
      metadata: { capturedAt: 0, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 8_000 } });
    const firstStop = provider.stopSession('session');
    const secondStop = provider.stopSession('session');
    await waitFor(() => fetchMock.mock.calls.length === 1);
    release?.();
    await Promise.all([firstStop, secondStop]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(transcripts).toHaveBeenCalledOnce();
    await provider.dispose();
    await runtime.close();
  });
  it('reuses VAD, emits final metrics, and flushes before stop resolves', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ text: '確定結果' }), {
      headers: { 'content-type': 'application/json' },
    }));
    const runtime = new GroqWhisperRuntime(
      new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000, fetch: fetchMock }),
      new GroqWhisperUsageGuard({ maxSessionSeconds: 100, maxHourSeconds: 100, maxDaySeconds: 100 }),
      { maxConcurrency: 2, maxQueueSize: 8 },
    );
    const provider = new GroqWhisperServerProvider(runtime, { stopTimeoutMs: 1_000,
      vad: { speechStartWindows: 1, preSpeechBufferMs: 20, minimumUtteranceDurationMs: 100,
        maxUtteranceDurationMs: 20_000, silenceDurationMs: 1_300, rmsThreshold: 0.001 } });
    const transcripts = vi.fn();
    const statuses: string[] = [];
    provider.onTranscript(transcripts);
    provider.onStatus((status) => statuses.push(status.state));
    await provider.startSession({ sessionId: 'session', language: 'ja', mimeType: GROQ_PCM_MIME_TYPE, sampleRate: 16_000 });
    const audio = voicedPcm(8_000);
    await provider.sendAudio({ sessionId: 'session', sequence: 0, audio,
      metadata: { capturedAt: 0, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le', frameCount: 8_000 } });
    await provider.stopSession('session');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(transcripts).toHaveBeenCalledWith(expect.objectContaining({
      text: '確定結果', isFinal: true, provider: 'groq-whisper', model: 'whisper-large-v3-turbo',
      audioDurationMs: 500,
    }));
    expect(statuses).toEqual(expect.arrayContaining(['listening', 'queued', 'recognizing', 'completed']));
    await provider.dispose();
    await runtime.close();
  });

  it('rejects invalid PCM metadata without making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const runtime = new GroqWhisperRuntime(
      new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000, fetch: fetchMock }),
      new GroqWhisperUsageGuard({ maxSessionSeconds: 100, maxHourSeconds: 100, maxDaySeconds: 100 }),
      { maxConcurrency: 2, maxQueueSize: 8 },
    );
    const provider = new GroqWhisperServerProvider(runtime, { stopTimeoutMs: 1_000, vad: {} });
    await provider.startSession({ sessionId: 'session', language: 'en', mimeType: GROQ_PCM_MIME_TYPE });
    await expect(provider.sendAudio({ sessionId: 'session', sequence: 0, audio: Uint8Array.of(1, 2) }))
      .rejects.toMatchObject({ code: 'groq_pcm_invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
    await provider.cancelSession('session');
    await provider.dispose();
    await runtime.close();
  });
});

function voicedPcm(frames: number): Uint8Array {
  const pcm = new Uint8Array(frames * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < frames; index += 1) view.setInt16(index * 2, index % 2 ? 12_000 : -12_000, true);
  return pcm;
}

function createProvider(options: {
  externalEnabled?: boolean;
  apiKey?: string;
  fetch?: typeof fetch;
  vad?: ConstructorParameters<typeof GroqWhisperServerProvider>[1]['vad'];
} = {}) {
  const fetchMock = options.fetch ?? vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ text: 'result' }), {
    headers: { 'content-type': 'application/json' },
  }));
  const runtime = new GroqWhisperRuntime(
    new GroqWhisperClient({ apiKey: options.apiKey === undefined && !('apiKey' in options) ? 'placeholder' : options.apiKey,
      externalEnabled: options.externalEnabled ?? true, timeoutMs: 1_000, fetch: fetchMock }),
    new GroqWhisperUsageGuard({ maxSessionSeconds: 100, maxHourSeconds: 100, maxDaySeconds: 100 }),
    { maxConcurrency: 2, maxQueueSize: 8 },
  );
  return { provider: new GroqWhisperServerProvider(runtime, { stopTimeoutMs: 1_000, vad: options.vad ?? {} }),
    runtime, fetchMock };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition not reached');
}
