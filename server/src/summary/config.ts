export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface SummaryConfig {
  enabled: boolean;
  provider: 'mock' | 'openai';
  apiKey?: string;
  liveModel?: string;
  finalModel?: string;
  liveReasoningEffort: ReasoningEffort;
  finalReasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  intervalSeconds: number;
  monthlyBudgetUsd?: number;
  meetingBudgetUsd?: number;
  maxRequestsPerMeeting?: number;
  stopOnBudgetExceeded: boolean;
  usageFile?: string;
  pricingJson?: string;
}

export function loadSummaryConfig(env: NodeJS.ProcessEnv = process.env): SummaryConfig {
  return {
    enabled: readBoolean(env.SUMMARY_ENABLED, false),
    provider: env.SUMMARY_PROVIDER === 'openai' ? 'openai' : 'mock',
    apiKey: env.OPENAI_API_KEY || undefined,
    liveModel: env.OPENAI_LIVE_SUMMARY_MODEL || undefined,
    finalModel: env.OPENAI_FINAL_SUMMARY_MODEL || undefined,
    liveReasoningEffort: readEffort(env.OPENAI_LIVE_REASONING_EFFORT, 'low'),
    finalReasoningEffort: readEffort(env.OPENAI_FINAL_REASONING_EFFORT, 'medium'),
    maxOutputTokens: readOptionalPositiveInteger(env.OPENAI_MAX_OUTPUT_TOKENS),
    intervalSeconds: readPositiveNumber(env.SUMMARY_INTERVAL_SECONDS, 10),
    monthlyBudgetUsd: readOptionalNonNegative(env.SUMMARY_MONTHLY_BUDGET_USD),
    meetingBudgetUsd: readOptionalNonNegative(env.SUMMARY_MEETING_BUDGET_USD),
    maxRequestsPerMeeting: readOptionalPositiveInteger(env.SUMMARY_MAX_REQUESTS_PER_MEETING),
    stopOnBudgetExceeded: readBoolean(env.SUMMARY_STOP_ON_BUDGET_EXCEEDED, true),
    usageFile: env.SUMMARY_USAGE_FILE || 'server/data/api-usage.jsonl',
    pricingJson: env.OPENAI_PRICING_JSON || undefined,
  };
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

function readEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  return value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : fallback;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function readOptionalNonNegative(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
