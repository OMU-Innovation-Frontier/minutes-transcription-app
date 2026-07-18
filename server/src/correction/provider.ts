import type { CorrectionInput } from '../../../shared/correction.js';

export interface CorrectionProvider {
  readonly name: string;
  readonly externalTransmission: boolean;
  correct(input: CorrectionInput, signal: AbortSignal): Promise<string>;
}

export class UnavailableCorrectionProvider implements CorrectionProvider {
  readonly externalTransmission = true;

  constructor(readonly name: string) {}

  async correct(): Promise<string> {
    throw new CorrectionProviderError('provider_unavailable', '設定された整文プロバイダーは未実装です。');
  }
}

export class CorrectionProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CorrectionProviderError';
  }
}
