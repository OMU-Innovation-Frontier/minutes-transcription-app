import { CORRECTION_POLICY_VERSION, parseGlossary, type GlossaryEntry } from '../../../shared/correction.js';

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
}

export function loadCorrectionConfig(env: NodeJS.ProcessEnv = process.env): CorrectionConfig {
  return {
    enabled: readBoolean(env.LLM_CORRECTION_ENABLED, false),
    provider: env.LLM_CORRECTION_PROVIDER?.trim() || 'mock',
    timeoutMs: readInteger(env.LLM_CORRECTION_TIMEOUT_MS, 8_000, 10, 120_000),
    concurrency: readInteger(env.LLM_CORRECTION_CONCURRENCY, 1, 1, 4),
    maxInputChars: readInteger(env.LLM_CORRECTION_MAX_INPUT_CHARS, 4_000, 100, 100_000),
    maxOutputRatio: readNumber(env.LLM_CORRECTION_MAX_OUTPUT_RATIO, 1.6, 1, 3),
    removeFillers: readBoolean(env.LLM_CORRECTION_REMOVE_FILLERS, false),
    correctionPolicyVersion: env.LLM_CORRECTION_POLICY_VERSION?.trim() || CORRECTION_POLICY_VERSION,
    glossary: parseGlossaryJson(env.LLM_CORRECTION_GLOSSARY_JSON),
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

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.toLocaleLowerCase() === 'true') return true;
  if (value.toLocaleLowerCase() === 'false') return false;
  return fallback;
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function readNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
