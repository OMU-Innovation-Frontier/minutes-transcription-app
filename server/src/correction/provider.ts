import type { CorrectionInput } from '../../../shared/correction.js';

export type CorrectionProviderErrorCode =
  | 'external_disabled'
  | 'api_key_missing'
  | 'unsupported_model'
  | 'invalid_configuration'
  | 'request_timeout'
  | 'cancelled'
  | 'rate_limited'
  | 'authentication_failed'
  | 'permission_denied'
  | 'request_failed'
  | 'invalid_content_type'
  | 'response_too_large'
  | 'invalid_response'
  | 'empty_response'
  | 'refused'
  | 'output_validation_failed'
  | 'provider_unavailable';

export interface CorrectionProvider {
  readonly name: string;
  readonly model: string;
  readonly externalTransmission: boolean;
  correct(input: CorrectionInput, signal: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

export class UnavailableCorrectionProvider implements CorrectionProvider {
  constructor(
    readonly name: string,
    private readonly errorCode: CorrectionProviderErrorCode = 'provider_unavailable',
    readonly model = 'unavailable',
    readonly externalTransmission = true,
  ) {}

  async correct(): Promise<string> {
    throw correctionProviderError(this.errorCode);
  }

  async dispose(): Promise<void> {}
}

export class CorrectionProviderError extends Error {
  constructor(public readonly code: CorrectionProviderErrorCode, message: string) {
    super(message);
    this.name = 'CorrectionProviderError';
  }
}

export function correctionProviderError(code: CorrectionProviderErrorCode): CorrectionProviderError {
  const messages: Record<CorrectionProviderErrorCode, string> = {
    external_disabled: '外部LLM整文は無効です。',
    api_key_missing: '外部LLM整文のサーバー設定が不足しています。',
    unsupported_model: '設定された整文モデルには対応していません。',
    invalid_configuration: '外部LLM整文の設定が不正です。',
    request_timeout: '外部LLM整文がタイムアウトしました。',
    cancelled: '外部LLM整文を中止しました。',
    rate_limited: '外部LLM整文の利用上限に達しました。',
    authentication_failed: '外部LLM整文の認証設定を確認できませんでした。',
    permission_denied: '外部LLM整文を利用する権限がありません。',
    request_failed: '外部LLM整文リクエストに失敗しました。',
    invalid_content_type: '外部LLM整文の応答形式を確認できませんでした。',
    response_too_large: '外部LLM整文の応答が上限を超えています。',
    invalid_response: '外部LLM整文の応答を検証できませんでした。',
    empty_response: '外部LLM整文から結果を取得できませんでした。',
    refused: '外部LLM整文はこの入力を処理できませんでした。',
    output_validation_failed: '外部LLM整文の結果を安全に検証できませんでした。',
    provider_unavailable: '設定された整文プロバイダーは利用できません。',
  };
  return new CorrectionProviderError(code, messages[code]);
}
