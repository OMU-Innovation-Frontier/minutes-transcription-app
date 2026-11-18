export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface SummaryConfig {
  enabled: boolean;
  provider: 'mock' | 'openai' | 'groq';
  groqMaxInputBytes?: number;
  apiKey?: string;
  liveModel?: string;
  finalModel?: string;
  liveReasoningEffort: ReasoningEffort;
  finalReasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  intervalSeconds: number;
  monthlyBudgetUsd?: number;
  meetingBudgetUsd?: number;
  maxRequestsPerMeeting?: number;
  stopOnBudgetExceeded: boolean;
  usageFile?: string;
  pricingJson?: string;
}

export function loadSummaryConfig(env: NodeJS.ProcessEnv = process.env): SummaryConfig {
  const groq = env.SUMMARY_PROVIDER === 'groq';
  return {
    groqMaxInputBytes: readOptionalPositiveInteger(env.GROQ_SUMMARY_MAX_INPUT_BYTES) ?? 12_000,
    enabled: readBoolean(env.SUMMARY_ENABLED, false),
    provider: groq ? 'groq' : env.SUMMARY_PROVIDER === 'openai' ? 'openai' : 'mock',
    apiKey: (groq ? env.GROQ_SUMMARY_API_KEY : env.OPENAI_API_KEY) || undefined,
    liveModel: groq ? (env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-20b') : env.OPENAI_LIVE_SUMMARY_MODEL || undefined,
    finalModel: groq ? (env.GROQ_SUMMARY_MODEL || 'openai/gpt-oss-20b') : env.OPENAI_FINAL_SUMMARY_MODEL || undefined,
    liveReasoningEffort: readEffort(env.OPENAI_LIVE_REASONING_EFFORT, 'low'),
    finalReasoningEffort: readEffort(env.OPENAI_FINAL_REASONING_EFFORT, 'medium'),
    maxOutputTokens: readOptionalPositiveInteger(groq ? env.GROQ_SUMMARY_MAX_OUTPUT_TOKENS : env.OPENAI_MAX_OUTPUT_TOKENS) ?? (groq ? 2048 : 8192),
    timeoutMs: readOptionalPositiveInteger(env.SUMMARY_TIMEOUT_MS) ?? 60_000,
    maxResponseBytes: readOptionalPositiveInteger(env.SUMMARY_MAX_RESPONSE_BYTES) ?? 262_144,
    intervalSeconds: readPositiveNumber(env.SUMMARY_INTERVAL_SECONDS, 10),
    monthlyBudgetUsd: readOptionalNonNegative(env.SUMMARY_MONTHLY_BUDGET_USD),
    meetingBudgetUsd: readOptionalNonNegative(env.SUMMARY_MEETING_BUDGET_USD),
    maxRequestsPerMeeting: readOptionalPositiveInteger(env.SUMMARY_MAX_REQUESTS_PER_MEETING) ?? (groq ? 10 : undefined),
    stopOnBudgetExceeded: readBoolean(env.SUMMARY_STOP_ON_BUDGET_EXCEEDED, true),
    usageFile: env.SUMMARY_USAGE_FILE || 'server/data/api-usage.jsonl',
    pricingJson: (groq ? env.GROQ_SUMMARY_PRICING_JSON : env.OPENAI_PRICING_JSON) || undefined,
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
