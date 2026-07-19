import type { CorrectionInput } from '../../../shared/correction.js';

export interface CorrectionProvider {
  readonly name: string;
  readonly model: string;
  readonly externalTransmission: boolean;
  correct(input: CorrectionInput, signal: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

export class UnavailableCorrectionProvider implements CorrectionProvider {
  readonly model = 'unavailable';
  readonly externalTransmission = true;

  constructor(readonly name: string) {}

  async correct(): Promise<string> {
    throw new CorrectionProviderError('provider_unavailable', '設定された整文プロバイダーは未実装です。');
  }

  async dispose(): Promise<void> {}
}

export class CorrectionProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CorrectionProviderError';
  }
}
