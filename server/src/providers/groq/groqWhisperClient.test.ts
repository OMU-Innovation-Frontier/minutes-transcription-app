// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ServerProviderError } from '../types.js';
import { GROQ_TRANSCRIPTION_ENDPOINT, GroqWhisperClient } from './groqWhisperClient.js';

describe('GroqWhisperClient', () => {
  it('uses the fixed endpoint and expected multipart fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(_input).toBe(GROQ_TRANSCRIPTION_ENDPOINT);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).not.toHaveProperty('content-type');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer placeholder');
      const body = init?.body as FormData;
      expect(body.get('model')).toBe('whisper-large-v3-turbo');
      expect(body.get('language')).toBe('ja');
      expect(body.get('response_format')).toBe('json');
      expect(body.get('temperature')).toBe('0');
      expect((body.get('file') as File).name).toBe('utterance.wav');
      return new Response(JSON.stringify({ text: ' テスト結果 ' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000, fetch: fetchMock });
    await expect(client.transcribe(Uint8Array.of(1, 2), 'ja')).resolves.toBe('テスト結果');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [{ externalEnabled: false, apiKey: 'placeholder' }, 'groq_external_disabled'],
    [{ externalEnabled: true, apiKey: undefined }, 'groq_api_key_missing'],
  ])('requires both opt-ins', async (settings, code) => {
    const client = new GroqWhisperClient({ ...settings, timeoutMs: 1_000, fetch: vi.fn() });
    await expect(client.transcribe(Uint8Array.of(1, 2), 'en')).rejects.toMatchObject({ code });
  });

  it.each([
    [401, 'groq_auth_failed', false], [403, 'groq_auth_failed', false], [413, 'groq_audio_too_large', false],
    [429, 'groq_rate_limited', true], [500, 'groq_request_failed', true],
  ])('maps HTTP %i to a safe error', async (status, code, retryable) => {
    const client = new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000,
      fetch: vi.fn(async () => new Response('{}', { status })) });
    await expect(client.transcribe(Uint8Array.of(1, 2), 'en')).rejects.toMatchObject({ code, retryable });
  });

  it('sends English without placing credentials in the URL or multipart body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).not.toContain('placeholder');
      const body = init?.body as FormData;
      expect(body.get('language')).toBe('en');
      expect([...body.keys()]).toEqual(['file', 'model', 'language', 'response_format', 'temperature']);
      return new Response(JSON.stringify({ text: 'English result' }), { headers: { 'content-type': 'application/json' } });
    });
    const client = new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000, fetch: fetchMock });
    await expect(client.transcribe(Uint8Array.of(1, 2), 'en')).resolves.toBe('English result');
  });

  it('rejects non-JSON, malformed, empty, and oversized responses without exposing bodies', async () => {
    const responses = [
      new Response('plain', { headers: { 'content-type': 'text/plain' } }),
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ text: '' }), { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1000001' } }),
    ];
    for (const response of responses) {
      const client = new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000,
        fetch: vi.fn(async () => response) });
      await expect(client.transcribe(Uint8Array.of(1, 2), 'en')).rejects.toBeInstanceOf(ServerProviderError);
    }
  });

  it('aborts timed out requests', async () => {
    vi.useFakeTimers();
    const client = new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 50,
      fetch: vi.fn((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) });
    const result = expect(client.transcribe(Uint8Array.of(1, 2), 'en')).rejects.toMatchObject({ code: 'groq_request_timeout' });
    await vi.advanceTimersByTimeAsync(50);
    await result;
    vi.useRealTimers();
  });

  it('honors an explicit AbortSignal', async () => {
    const controller = new AbortController();
    const client = new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000,
      fetch: vi.fn((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort',
        () => reject(new DOMException('Aborted', 'AbortError'))))) });
    const result = expect(client.transcribe(Uint8Array.of(1, 2), 'ja', controller.signal))
      .rejects.toMatchObject({ code: 'groq_request_cancelled' });
    controller.abort();
    await result;
  });

  it('maps a network failure to a safe message without exposing the cause or credential', async () => {
    const privateDetail = 'private transport detail';
    const client = new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000,
      fetch: vi.fn(async () => { throw new Error(privateDetail); }) });
    try {
      await client.transcribe(Uint8Array.of(1, 2), 'ja');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'groq_request_failed' });
      expect(String(error)).not.toContain(privateDetail);
      expect(String(error)).not.toContain('placeholder');
    }
  });

  it('rejects an oversized transcript', async () => {
    const client = new GroqWhisperClient({ apiKey: 'placeholder', externalEnabled: true, timeoutMs: 1_000,
      fetch: vi.fn(async () => new Response(JSON.stringify({ text: 'x'.repeat(100_001) }),
        { headers: { 'content-type': 'application/json' } })) });
    await expect(client.transcribe(Uint8Array.of(1, 2), 'ja')).rejects.toMatchObject({ code: 'groq_transcript_too_large' });
  });
});
