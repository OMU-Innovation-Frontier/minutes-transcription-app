import { GROQ_CORRECTION_MODEL } from './config.js';
import { CorrectionProviderError, correctionProviderError } from './provider.js';

export const GROQ_CORRECTION_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqCorrectionMessage {
  role: 'system' | 'user';
  content: string;
}

export interface GroqCorrectionClientOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
  reasoningEffort: 'low';
  fetch?: typeof fetch;
}

export const GROQ_CORRECTION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    correctedText: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          before: { type: 'string' },
          after: { type: 'string' },
          reason: {
            type: 'string',
            enum: ['asr_error', 'punctuation', 'grammar', 'spelling', 'duplicate', 'glossary'],
          },
        },
        required: ['before', 'after', 'reason'],
        additionalProperties: false,
      },
    },
    uncertainParts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          reason: {
            type: 'string',
            enum: ['number', 'proper_noun', 'technical_term', 'low_context', 'ambiguous'],
          },
        },
        required: ['text', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['correctedText', 'changes', 'uncertainParts'],
  additionalProperties: false,
});

export class GroqCorrectionClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly controllers = new Set<AbortController>();
  private disposed = false;
  private generation = 0;

  constructor(private readonly options: GroqCorrectionClientOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async complete(messages: readonly GroqCorrectionMessage[], signal: AbortSignal): Promise<unknown> {
    this.assertConfigured();
    if (signal.aborted) throw correctionProviderError('cancelled');
    const generation = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const cancel = (): void => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    try {
      const response = await abortableFetch(
        this.fetchImplementation,
        GROQ_CORRECTION_ENDPOINT,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.options.model,
            messages,
            temperature: 0,
            reasoning_effort: this.options.reasoningEffort,
            stream: false,
            store: false,
            max_completion_tokens: this.options.maxOutputTokens,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'meeting_transcript_correction',
                strict: true,
                schema: GROQ_CORRECTION_RESPONSE_SCHEMA,
              },
            },
          }),
          signal: controller.signal,
        },
        controller.signal,
      );
      if (this.disposed || generation !== this.generation || signal.aborted) {
        throw correctionProviderError('cancelled');
      }
      return await this.parseResponse(response);
    } catch (error) {
      if (error instanceof CorrectionProviderError) throw error;
      if (this.disposed || signal.aborted) throw correctionProviderError('cancelled');
      if (timedOut || controller.signal.aborted) throw correctionProviderError('request_timeout');
      throw correctionProviderError('request_failed');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      this.controllers.delete(controller);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private assertConfigured(): void {
    if (this.disposed) throw correctionProviderError('provider_unavailable');
    if (!this.options.apiKey.trim()) throw correctionProviderError('api_key_missing');
    if (this.options.model !== GROQ_CORRECTION_MODEL) throw correctionProviderError('unsupported_model');
    if (
      !Number.isSafeInteger(this.options.timeoutMs)
      || this.options.timeoutMs < 10
      || !Number.isSafeInteger(this.options.maxResponseBytes)
      || this.options.maxResponseBytes < 1_024
      || !Number.isSafeInteger(this.options.maxOutputTokens)
      || this.options.maxOutputTokens < 1
      || this.options.reasoningEffort !== 'low'
    ) {
      throw correctionProviderError('invalid_configuration');
    }
  }

  private async parseResponse(response: Response): Promise<unknown> {
    if (!response.ok) throw mapHttpError(response.status);
    const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
    if (!contentType.includes('application/json')) throw correctionProviderError('invalid_content_type');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.options.maxResponseBytes) {
      throw correctionProviderError('response_too_large');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.options.maxResponseBytes) throw correctionProviderError('response_too_large');
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw correctionProviderError('invalid_response');
    }
    if (!isRecord(envelope) || !Array.isArray(envelope.choices) || envelope.choices.length === 0) {
      throw correctionProviderError('invalid_response');
    }
    const choice = envelope.choices[0];
    if (!isRecord(choice) || choice.finish_reason !== 'stop' || !isRecord(choice.message)) {
      throw correctionProviderError('invalid_response');
    }
    if (choice.message.refusal !== undefined && choice.message.refusal !== null) {
      throw correctionProviderError('refused');
    }
    const content = choice.message.content;
    if (typeof content !== 'string') throw correctionProviderError('invalid_response');
    if (!content.trim()) throw correctionProviderError('empty_response');
    if (new TextEncoder().encode(content).byteLength > this.options.maxResponseBytes) {
      throw correctionProviderError('response_too_large');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw correctionProviderError('invalid_response');
    }
    if (!isRecord(parsed)) throw correctionProviderError('invalid_response');
    return parsed;
  }
}

async function abortableFetch(
  fetchImplementation: typeof fetch,
  input: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    const aborted = (): void => reject(abortError());
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => fetchImplementation(input, init))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted))
      .catch(() => undefined);
  });
}

function mapHttpError(status: number): CorrectionProviderError {
  if (status === 400) return correctionProviderError('invalid_response');
  if (status === 401) return correctionProviderError('authentication_failed');
  if (status === 403) return correctionProviderError('permission_denied');
  if (status === 404) return correctionProviderError('unsupported_model');
  if (status === 408) return correctionProviderError('request_timeout');
  if (status === 413) return correctionProviderError('response_too_large');
  if (status === 429) return correctionProviderError('rate_limited');
  if (status >= 500) return correctionProviderError('provider_unavailable');
  return correctionProviderError('request_failed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}
