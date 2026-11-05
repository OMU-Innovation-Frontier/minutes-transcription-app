import { CORRECTION_POLICY_VERSION, parseGlossary, type GlossaryEntry } from '../../../shared/correction.js';
import type { CorrectionProviderErrorCode } from './provider.js';

export const GROQ_CORRECTION_MODEL = 'openai/gpt-oss-20b';
export const GROQ_CORRECTION_MAX_RESPONSE_BYTES = 65_536;
export const GROQ_CORRECTION_MAX_OUTPUT_TOKENS = 1_024;
export const GROQ_CORRECTION_REASONING_EFFORT = 'low';

export interface CorrectionConfig {
  enabled: boolean;
  provider: string;
  timeoutMs: number;
  concurrency: number;
  maxInputChars: number;
  maxOutputRatio: number;
  removeFillers: boolean;
  correctionPolicyVersion: string;
  glossary: GlossaryEntry[];
  groqApiKey?: string;
  groqModel: string;
  groqMaxResponseBytes: number;
  groqMaxOutputTokens: number;
  groqReasoningEffort: 'low';
  configurationError?: CorrectionProviderErrorCode;
}

export function loadCorrectionConfig(env: NodeJS.ProcessEnv = process.env): CorrectionConfig {
  const provider = env.LLM_CORRECTION_PROVIDER?.trim() || 'mock';
  const enabled = readBoolean(env.LLM_CORRECTION_ENABLED, false);
  const timeoutMs = readInteger(env.LLM_CORRECTION_TIMEOUT_MS, 8_000, 10, 120_000);
  const concurrency = readInteger(env.LLM_CORRECTION_CONCURRENCY, 1, 1, 4);
  const maxInputChars = readInteger(env.LLM_CORRECTION_MAX_INPUT_CHARS, 4_000, 100, 100_000);
  const maxOutputRatio = readNumber(env.LLM_CORRECTION_MAX_OUTPUT_RATIO, 1.6, 1, 3);
  const removeFillers = readBoolean(env.LLM_CORRECTION_REMOVE_FILLERS, false);
  const maxResponseBytes = readInteger(
    env.GROQ_CORRECTION_MAX_RESPONSE_BYTES,
    GROQ_CORRECTION_MAX_RESPONSE_BYTES,
    1_024,
    1_048_576,
  );
  const maxOutputTokens = readInteger(
    env.GROQ_CORRECTION_MAX_OUTPUT_TOKENS,
    GROQ_CORRECTION_MAX_OUTPUT_TOKENS,
    1,
    65_536,
  );
  const model = env.GROQ_CORRECTION_MODEL?.trim() || GROQ_CORRECTION_MODEL;
  const reasoningEffort = env.GROQ_CORRECTION_REASONING_EFFORT?.trim() || GROQ_CORRECTION_REASONING_EFFORT;
  const commonConfigurationValid = [
    enabled.valid,
    timeoutMs.valid,
    concurrency.valid,
    maxInputChars.valid,
    maxOutputRatio.valid,
    removeFillers.valid,
  ].every(Boolean);
  const groqConfigurationValid = [
    maxResponseBytes.valid,
    maxOutputTokens.valid,
    reasoningEffort === GROQ_CORRECTION_REASONING_EFFORT,
  ].every(Boolean);
  const configurationError = firstConfigurationError(
    provider,
    commonConfigurationValid,
    groqConfigurationValid,
    model,
  );
  return {
    enabled: enabled.value,
    provider,
    timeoutMs: timeoutMs.value,
    concurrency: concurrency.value,
    maxInputChars: maxInputChars.value,
    maxOutputRatio: maxOutputRatio.value,
    removeFillers: removeFillers.value,
    correctionPolicyVersion: env.LLM_CORRECTION_POLICY_VERSION?.trim() || CORRECTION_POLICY_VERSION,
    glossary: parseGlossaryJson(env.LLM_CORRECTION_GLOSSARY_JSON),
    groqApiKey: env.GROQ_CORRECTION_API_KEY?.trim() || undefined,
    groqModel: model,
    groqMaxResponseBytes: maxResponseBytes.value,
    groqMaxOutputTokens: maxOutputTokens.value,
    groqReasoningEffort: GROQ_CORRECTION_REASONING_EFFORT,
    configurationError,
  };
}

function parseGlossaryJson(value: string | undefined): GlossaryEntry[] {
  if (!value?.trim()) return [];
  try {
    return parseGlossary(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

interface ParsedConfigValue<T> {
  value: T;
  valid: boolean;
}

function readBoolean(value: string | undefined, fallback: boolean): ParsedConfigValue<boolean> {
  if (value === undefined || value.trim() === '') return { value: fallback, valid: true };
  if (value.toLocaleLowerCase() === 'true') return { value: true, valid: true };
  if (value.toLocaleLowerCase() === 'false') return { value: false, valid: true };
  return { value: fallback, valid: false };
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): ParsedConfigValue<number> {
  if (value === undefined || value.trim() === '') return { value: fallback, valid: true };
  const parsed = Number(value);
  const valid = Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
  return { value: valid ? parsed : fallback, valid };
}

function readNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): ParsedConfigValue<number> {
  if (value === undefined || value.trim() === '') return { value: fallback, valid: true };
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum;
  return { value: valid ? parsed : fallback, valid };
}

function firstConfigurationError(
  provider: string,
  commonConfigurationValid: boolean,
  groqConfigurationValid: boolean,
  model: string,
): CorrectionProviderErrorCode | undefined {
  if (!commonConfigurationValid) return 'invalid_configuration';
  if (provider !== 'groq') return undefined;
  if (model !== GROQ_CORRECTION_MODEL) return 'unsupported_model';
  return groqConfigurationValid ? undefined : 'invalid_configuration';
}
