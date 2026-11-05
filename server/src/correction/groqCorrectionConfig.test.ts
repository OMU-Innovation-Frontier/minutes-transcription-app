// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { CorrectionInput } from '../../../shared/correction.js';
import {
  GROQ_CORRECTION_MAX_OUTPUT_TOKENS,
  GROQ_CORRECTION_MAX_RESPONSE_BYTES,
  GROQ_CORRECTION_MODEL,
  loadCorrectionConfig,
} from './config.js';
import { createCorrectionService } from './correctionService.js';

describe('Groq correction config and provider factory', () => {
  it('defaults to disabled deterministic mock settings', () => {
    expect(loadCorrectionConfig({})).toMatchObject({
      enabled: false,
      provider: 'mock',
      timeoutMs: 8_000,
      concurrency: 1,
      maxInputChars: 4_000,
      groqModel: GROQ_CORRECTION_MODEL,
      groqMaxResponseBytes: GROQ_CORRECTION_MAX_RESPONSE_BYTES,
      groqMaxOutputTokens: GROQ_CORRECTION_MAX_OUTPUT_TOKENS,
      groqReasoningEffort: 'low',
    });
  });

  it('loads the explicit Groq server-only configuration', () => {
    const config = loadCorrectionConfig({
      LLM_CORRECTION_ENABLED: 'true',
      LLM_CORRECTION_PROVIDER: 'groq',
      LLM_CORRECTION_TIMEOUT_MS: '1200',
      LLM_CORRECTION_CONCURRENCY: '2',
      LLM_CORRECTION_MAX_INPUT_CHARS: '5000',
      GROQ_CORRECTION_API_KEY: 'test-key',
      GROQ_CORRECTION_MODEL,
      GROQ_CORRECTION_MAX_RESPONSE_BYTES: '32768',
      GROQ_CORRECTION_MAX_OUTPUT_TOKENS: '512',
      GROQ_CORRECTION_REASONING_EFFORT: 'low',
    });
    expect(config).toMatchObject({
      enabled: true, provider: 'groq', timeoutMs: 1200, concurrency: 2, maxInputChars: 5000,
      groqModel: GROQ_CORRECTION_MODEL, groqMaxResponseBytes: 32768, groqMaxOutputTokens: 512,
      groqReasoningEffort: 'low', configurationError: undefined,
    });
    expect(config.groqApiKey).toBe('test-key');
  });

  it.each([
    [{ LLM_CORRECTION_ENABLED: 'yes' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_TIMEOUT_MS: '9' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_TIMEOUT_MS: '120001' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_CONCURRENCY: '0' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_CONCURRENCY: '5' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_MAX_INPUT_CHARS: '99' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_MAX_INPUT_CHARS: '100001' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_PROVIDER: 'groq', GROQ_CORRECTION_MODEL: 'openai/gpt-oss-120b' }, 'unsupported_model'],
    [{ LLM_CORRECTION_PROVIDER: 'groq', GROQ_CORRECTION_REASONING_EFFORT: 'medium' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_PROVIDER: 'groq', GROQ_CORRECTION_MAX_RESPONSE_BYTES: '100' }, 'invalid_configuration'],
    [{ LLM_CORRECTION_PROVIDER: 'groq', GROQ_CORRECTION_MAX_OUTPUT_TOKENS: '0' }, 'invalid_configuration'],
  ])('marks invalid bounded config safely', (env, code) => {
    expect(loadCorrectionConfig(env).configurationError).toBe(code);
  });

  it.each([
    ['1', 1], ['4', 4],
  ])('accepts concurrency boundary %s', (value, expected) => {
    expect(loadCorrectionConfig({ LLM_CORRECTION_CONCURRENCY: value })).toMatchObject({ concurrency: expected, configurationError: undefined });
  });

  it.each([
    ['100', 100], ['100000', 100000],
  ])('accepts max-input boundary %s', (value, expected) => {
    expect(loadCorrectionConfig({ LLM_CORRECTION_MAX_INPUT_CHARS: value })).toMatchObject({ maxInputChars: expected, configurationError: undefined });
  });

  it('creates mock and keeps unknown providers unavailable', () => {
    expect(createCorrectionService(loadCorrectionConfig({ LLM_CORRECTION_ENABLED: 'true' })).status())
      .toMatchObject({ enabled: true, provider: 'mock', externalTransmission: false });
    expect(createCorrectionService(loadCorrectionConfig({ LLM_CORRECTION_ENABLED: 'true', LLM_CORRECTION_PROVIDER: 'unknown' })).status())
      .toMatchObject({ enabled: false, provider: 'unknown', model: 'unavailable', externalTransmission: true });
  });

  it('does not let inactive Groq-only settings disable mock correction', () => {
    const config = loadCorrectionConfig({
      LLM_CORRECTION_ENABLED: 'true',
      LLM_CORRECTION_PROVIDER: 'mock',
      GROQ_CORRECTION_MODEL: 'not-used-by-mock',
      GROQ_CORRECTION_REASONING_EFFORT: 'not-used-by-mock',
    });
    expect(config.configurationError).toBeUndefined();
    expect(createCorrectionService(config).status()).toMatchObject({ enabled: true, provider: 'mock' });
  });

  it.each([
    [{ LLM_CORRECTION_ENABLED: 'false', GROQ_CORRECTION_API_KEY: 'test-key' }, 'external_disabled'],
    [{ LLM_CORRECTION_ENABLED: 'true', GROQ_CORRECTION_API_KEY: '' }, 'api_key_missing'],
    [{ LLM_CORRECTION_ENABLED: 'true', GROQ_CORRECTION_API_KEY: 'test-key', GROQ_CORRECTION_MODEL: 'openai/gpt-oss-120b' }, 'unsupported_model'],
  ])('does not enable Groq unless enabled, keyed, and allowlisted', async (env, expectedReason) => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createCorrectionService(loadCorrectionConfig({ LLM_CORRECTION_PROVIDER: 'groq', ...env }), { fetch: fetchMock });
    expect(service.status()).toMatchObject({ enabled: false, provider: 'groq', externalTransmission: true });
    const result = await service.correct(request('teh plan'));
    expect(result).toMatchObject({ status: 'disabled', correctedText: 'teh plan' });
    expect(fetchMock).not.toHaveBeenCalled();
    const config = loadCorrectionConfig({ LLM_CORRECTION_PROVIDER: 'groq', ...env });
    if (expectedReason === 'unsupported_model') expect(config.configurationError).toBe(expectedReason);
  });

  it('creates Groq only with all three opt-ins and never returns key material from status', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => groqResponse({
      correctedText: 'the plan',
      changes: [{ before: 'teh', after: 'the', reason: 'spelling' }],
      uncertainParts: [],
    }));
    const service = createCorrectionService(groqConfig(), { fetch: fetchMock });
    const status = service.status();
    expect(status).toMatchObject({
      enabled: true, provider: 'groq', model: GROQ_CORRECTION_MODEL, externalTransmission: true,
      timeoutMs: 8_000, concurrency: 1, maxInputChars: 4_000, removeFillers: false,
      policyVersion: 'safe-correction-v1', queueLimit: 100, maxAttempts: 3,
    });
    expect(JSON.stringify(status)).not.toContain('test-key');
    await expect(service.correct(request('teh plan'))).resolves.toMatchObject({
      status: 'completed', rawText: 'teh plan', correctedText: 'the plan', provider: 'groq', model: GROQ_CORRECTION_MODEL,
      requestId: 'request-1', segmentId: 'sentence-1', revision: 2, attemptCount: 1,
      policyVersion: 'safe-correction-v1', sourceSegmentIds: ['raw-1'],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
  ])('falls back to immutable raw text for HTTP %i', async (status, errorCode) => {
    const service = createCorrectionService(groqConfig(), {
      fetch: vi.fn(async () => new Response('private detail', { status })),
    });
    await expect(service.correct(request('teh plan'))).resolves.toMatchObject({
      status: 'failed', rawText: 'teh plan', correctedText: 'teh plan', errorCode,
    });
  });

  it('falls back when Groq returns output that fails the existing validator', async () => {
    const service = createCorrectionService(groqConfig(), {
      fetch: vi.fn(async () => groqResponse({ correctedText: 'different', changes: [], uncertainParts: [] })),
    });
    await expect(service.correct(request('teh plan'))).resolves.toMatchObject({
      status: 'failed', correctedText: 'teh plan', errorCode: 'output_validation_failed',
    });
  });
});

function groqConfig() {
  return loadCorrectionConfig({
    LLM_CORRECTION_ENABLED: 'true',
    LLM_CORRECTION_PROVIDER: 'groq',
    GROQ_CORRECTION_API_KEY: 'test-key',
    GROQ_CORRECTION_MODEL,
  });
}

function request(text: string): {
  requestId: string;
  meetingId: string;
  sessionId: string;
  segmentId: string;
  revision: number;
  attemptCount: number;
  input: CorrectionInput;
} {
  return {
    requestId: 'request-1', meetingId: 'meeting-1', sessionId: 'session-1', segmentId: 'sentence-1', revision: 2, attemptCount: 1,
    input: {
      targetSegmentId: 'sentence-1', targetRawText: text, previousSegments: [], language: 'en', glossary: [],
      correctionPolicyVersion: 'safe-correction-v1', removeFillers: false, sourceSegmentIds: ['raw-1'],
    },
  };
}

function groqResponse(output: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }), {
    headers: { 'content-type': 'application/json' },
  });
}
