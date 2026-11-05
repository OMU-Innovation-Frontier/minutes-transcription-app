// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GROQ_CORRECTION_ENDPOINT,
  GROQ_CORRECTION_RESPONSE_SCHEMA,
  GroqCorrectionClient,
} from './groqCorrectionClient.js';

const messages = [
  { role: 'system' as const, content: 'system' },
  { role: 'user' as const, content: '{"data":"synthetic"}' },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('GroqCorrectionClient', () => {
  it('sends the fixed safe chat-completions request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe(GROQ_CORRECTION_ENDPOINT);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'openai/gpt-oss-20b', messages, temperature: 0, reasoning_effort: 'low',
        stream: false, store: false, max_completion_tokens: 1024,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'meeting_transcript_correction', strict: true, schema: GROQ_CORRECTION_RESPONSE_SCHEMA },
        },
      });
      expect(body).not.toHaveProperty('tools');
      expect(String(input)).not.toContain('test-key');
      expect(String(init?.body)).not.toContain('test-key');
      return response();
    });
    await expect(client(fetchMock).complete(messages, new AbortController().signal)).resolves.toMatchObject({ correctedText: 'synthetic.' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses a strict schema with required closed objects and runtime-enforced array limits', () => {
    expect(GROQ_CORRECTION_RESPONSE_SCHEMA.required).toEqual(['correctedText', 'changes', 'uncertainParts']);
    expect(GROQ_CORRECTION_RESPONSE_SCHEMA.additionalProperties).toBe(false);
    const changeItem = GROQ_CORRECTION_RESPONSE_SCHEMA.properties.changes.items;
    const uncertainItem = GROQ_CORRECTION_RESPONSE_SCHEMA.properties.uncertainParts.items;
    expect(changeItem).toMatchObject({ required: ['before', 'after', 'reason'], additionalProperties: false });
    expect(uncertainItem).toMatchObject({ required: ['text', 'reason'], additionalProperties: false });
    expect(changeItem.properties.reason.enum).toEqual(['asr_error', 'punctuation', 'grammar', 'spelling', 'duplicate', 'glossary']);
    expect(uncertainItem.properties.reason.enum).toEqual(['number', 'proper_noun', 'technical_term', 'low_context', 'ambiguous']);
    expect(GROQ_CORRECTION_RESPONSE_SCHEMA.properties.changes).not.toHaveProperty('maxItems');
    expect(GROQ_CORRECTION_RESPONSE_SCHEMA.properties.uncertainParts).not.toHaveProperty('maxItems');
  });

  it.each([
    [400, 'invalid_response'],
    [401, 'authentication_failed'],
    [403, 'permission_denied'],
    [404, 'unsupported_model'],
    [408, 'request_timeout'],
    [413, 'response_too_large'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
  ])('maps HTTP %i to %s without exposing the response', async (status, code) => {
    const body = 'private upstream detail';
    const instance = client(vi.fn(async () => new Response(body, { status })));
    try {
      await instance.complete(messages, new AbortController().signal);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain(body);
      expect(String(error)).not.toContain('test-key');
    }
  });

  it.each([
    ['invalid_content_type', () => new Response('plain', { headers: { 'content-type': 'text/plain' } })],
    ['response_too_large', () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1025' } })],
    ['response_too_large', () => new Response(JSON.stringify({ padding: 'x'.repeat(1_100) }), { headers: { 'content-type': 'application/json' } })],
    ['invalid_response', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
    ['invalid_response', () => jsonResponse({})],
    ['invalid_response', () => jsonResponse({ choices: [] })],
    ['invalid_response', () => jsonResponse({ choices: [{}] })],
    ['invalid_response', () => jsonResponse({ choices: [{ finish_reason: 'stop' }] })],
    ['invalid_response', () => jsonResponse({ choices: [{ finish_reason: 'stop', message: {} }] })],
    ['empty_response', () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '  ' } }] })],
    ['refused', () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: 'not processed' } }] })],
    ['invalid_response', () => jsonResponse({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })],
    ['invalid_response', () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '{' } }] })],
    ['invalid_response', () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '[]' } }] })],
  ])('rejects unsafe response as %s', async (code, createResponse) => {
    await expect(client(vi.fn(async () => createResponse())).complete(messages, new AbortController().signal))
      .rejects.toMatchObject({ code });
  });

  it('aborts the real fetch signal on timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = client(fetchMock, { timeoutMs: 50 }).complete(messages, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it('propagates explicit cancellation and never adopts a late response', async () => {
    const controller = new AbortController();
    let resolveFetch: ((value: Response) => void) | undefined;
    const instance = client(vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const pending = instance.complete(messages, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    resolveFetch?.(response());
    await Promise.resolve();
  });

  it('dispose is idempotent, aborts in-flight work, and rejects later calls', async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const instance = client(fetchMock);
    const pending = instance.complete(messages, new AbortController().signal);
    instance.dispose();
    instance.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await expect(instance.complete(messages, new AbortController().signal)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('maps transport failures to a fixed message without retaining raw details', async () => {
    const instance = client(vi.fn(async () => { throw new Error('private transport detail'); }));
    try {
      await instance.complete(messages, new AbortController().signal);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'request_failed' });
      expect(String(error)).not.toContain('private transport detail');
      expect(String(error)).not.toContain('test-key');
    }
  });

  it.each([
    [{ apiKey: '' }, 'api_key_missing'],
    [{ model: 'openai/gpt-oss-120b' }, 'unsupported_model'],
    [{ reasoningEffort: 'medium' as 'low' }, 'invalid_configuration'],
  ])('rejects unsafe client configuration', async (override, code) => {
    await expect(client(vi.fn(), override).complete(messages, new AbortController().signal)).rejects.toMatchObject({ code });
  });
});

function client(fetchMock: typeof fetch, override: Partial<ConstructorParameters<typeof GroqCorrectionClient>[0]> = {}): GroqCorrectionClient {
  return new GroqCorrectionClient({
    apiKey: 'test-key',
    model: 'openai/gpt-oss-20b',
    timeoutMs: 1_000,
    maxResponseBytes: 1_024,
    maxOutputTokens: 1_024,
    reasoningEffort: 'low',
    fetch: fetchMock,
    ...override,
  });
}

function response(output: unknown = { correctedText: 'synthetic.', changes: [], uncertainParts: [] }): Response {
  return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}
