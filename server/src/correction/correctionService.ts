import {
  createFallbackCorrection,
  parseCorrectionRequest,
  validateCorrectionOutput,
  type CorrectionRequest,
  type CorrectionServiceStatus,
  type TranscriptCorrection,
} from '../../../shared/correction.js';
import type { CorrectionConfig } from './config.js';
import { MockCorrectionProvider } from './mockCorrectionProvider.js';
import { CorrectionProviderError, UnavailableCorrectionProvider, type CorrectionProvider } from './provider.js';

export class CorrectionService {
  constructor(
    private readonly config: CorrectionConfig,
    private readonly provider: CorrectionProvider,
    private readonly now: () => number = Date.now,
  ) {}

  status(): CorrectionServiceStatus {
    return {
      enabled: this.config.enabled,
      provider: this.provider.name,
      externalTransmission: this.provider.externalTransmission,
      timeoutMs: this.config.timeoutMs,
      concurrency: this.config.concurrency,
      maxInputChars: this.config.maxInputChars,
      removeFillers: this.config.removeFillers,
      correctionPolicyVersion: this.config.correctionPolicyVersion,
    };
  }

  async correct(value: unknown): Promise<TranscriptCorrection> {
    const request = parseCorrectionRequest(value, this.config.maxInputChars);
    const startedAt = this.now();
    if (!request.input.targetRawText.trim()) {
      return createFallbackCorrection('', 'skipped', request.input.sourceSegmentIds, {
        provider: this.provider.name,
        errorCode: 'empty_text',
      });
    }
    if (!this.config.enabled) {
      return createFallbackCorrection(request.input.targetRawText, 'disabled', request.input.sourceSegmentIds, {
        provider: this.provider.name,
      });
    }
    if (request.input.correctionPolicyVersion !== this.config.correctionPolicyVersion) {
      return this.failure(request, startedAt, 'policy_version_mismatch');
    }
    const input = {
      ...request.input,
      glossary: this.config.glossary.length > 0 ? this.config.glossary : request.input.glossary,
      removeFillers: this.config.removeFillers,
    };
    try {
      const output = await withTimeout(
        (signal) => this.provider.correct(input, signal),
        this.config.timeoutMs,
      );
      const validated = validateCorrectionOutput(output, input, {
        removeFillers: this.config.removeFillers,
        maxOutputRatio: this.config.maxOutputRatio,
      });
      return {
        rawText: request.input.targetRawText,
        correctedText: validated.correctedText,
        status: 'completed',
        changes: validated.changes,
        uncertainParts: validated.uncertainParts,
        provider: this.provider.name,
        processingTimeMs: Math.max(0, this.now() - startedAt),
        sourceSegmentIds: [...request.input.sourceSegmentIds],
      };
    } catch (error) {
      return this.failure(request, startedAt, errorCode(error));
    }
  }

  private failure(request: CorrectionRequest, startedAt: number, code: string): TranscriptCorrection {
    return createFallbackCorrection(request.input.targetRawText, 'failed', request.input.sourceSegmentIds, {
      provider: this.provider.name,
      processingTimeMs: Math.max(0, this.now() - startedAt),
      errorCode: code,
    });
  }
}

export function createCorrectionService(config: CorrectionConfig): CorrectionService {
  const provider: CorrectionProvider = config.provider === 'mock'
    ? new MockCorrectionProvider()
    : new UnavailableCorrectionProvider(config.provider);
  return new CorrectionService(config, provider);
}

export class CorrectionServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'CorrectionServiceError';
  }
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CorrectionProviderError('timeout', '整文処理がタイムアウトしました。'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof CorrectionProviderError) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'validation_failed';
}
