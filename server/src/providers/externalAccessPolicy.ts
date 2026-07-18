import { ServerProviderError } from './types.js';

export interface ExternalSttAccessSettings {
  externalEnabled: boolean;
  apiKey?: string;
  sessionBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  maxAudioSecondsPerSession?: number;
}

export function assertExternalSttMayStart(settings: ExternalSttAccessSettings): void {
  if (!settings.externalEnabled) {
    throw new ServerProviderError(
      'external_stt_disabled',
      false,
      '外部音声認識は無効です。音声は外部へ送信されていません。',
    );
  }
  if (!settings.apiKey) {
    throw new ServerProviderError(
      'api_key_missing',
      false,
      '外部音声認識用のAPIキーがサーバーに設定されていません。',
    );
  }
  if (settings.sessionBudgetUsd === 0 || settings.monthlyBudgetUsd === 0) {
    throw budgetExceeded();
  }
}

export function assertEstimatedCostWithinBudget(options: {
  sessionBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  estimatedSessionCostUsd?: number;
  estimatedMonthlyCostUsd?: number;
}): void {
  const needsSessionEstimate = options.sessionBudgetUsd !== undefined;
  const needsMonthlyEstimate = options.monthlyBudgetUsd !== undefined;
  if (
    (needsSessionEstimate && options.estimatedSessionCostUsd === undefined)
    || (needsMonthlyEstimate && options.estimatedMonthlyCostUsd === undefined)
  ) {
    throw new ServerProviderError(
      'stt_pricing_not_registered',
      false,
      '価格設定が未登録のため、指定された料金上限を安全に検証できません。',
    );
  }
  if (
    (options.sessionBudgetUsd !== undefined
      && (options.estimatedSessionCostUsd ?? 0) >= options.sessionBudgetUsd)
    || (options.monthlyBudgetUsd !== undefined
      && (options.estimatedMonthlyCostUsd ?? 0) >= options.monthlyBudgetUsd)
  ) {
    throw budgetExceeded();
  }
}

export class SttAudioDurationLimiter {
  private consumedSeconds = 0;

  constructor(private readonly maximumSeconds: number | undefined) {}

  addAudioDuration(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new ServerProviderError(
        'invalid_audio_duration',
        false,
        '音声時間を安全に計測できませんでした。',
      );
    }
    const next = this.consumedSeconds + seconds;
    if (this.maximumSeconds !== undefined && next > this.maximumSeconds) {
      throw new ServerProviderError(
        'stt_audio_limit_reached',
        false,
        'この会議の外部音声認識時間上限に達しました。ローカル録音は継続できます。',
      );
    }
    this.consumedSeconds = next;
    return this.consumedSeconds;
  }

  get totalSeconds(): number {
    return this.consumedSeconds;
  }
}

function budgetExceeded(): ServerProviderError {
  return new ServerProviderError(
    'stt_budget_exceeded',
    false,
    '外部音声認識の料金上限に達しました。ローカル録音は継続できます。',
  );
}
