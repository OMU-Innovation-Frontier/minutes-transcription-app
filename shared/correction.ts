export const CORRECTION_POLICY_VERSION = 'safe-correction-v1';
export const CORRECTION_QUEUE_LIMIT = 100;
export const CORRECTION_MAX_ATTEMPTS = 3;

export type CorrectionStatus =
  | 'disabled'
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'fallback'
  // Legacy values remain readable so IndexedDB version 1 records can be migrated safely.
  | 'pending'
  | 'completed';
export type CorrectionFailureReason =
  | 'timeout'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'input_too_long'
  | 'output_validation_failed'
  | 'protected_token_mismatch'
  | 'queue_full'
  | 'cancelled'
  | 'stale_result'
  | 'interrupted'
  | 'storage_failed'
  | 'max_attempts_reached'
  | 'unknown_safe_failure';
export type CorrectionChangeReason = 'asr_error' | 'punctuation' | 'grammar' | 'spelling' | 'duplicate' | 'glossary';
export type CorrectionUncertainReason = 'number' | 'proper_noun' | 'technical_term' | 'low_context' | 'ambiguous';
export type CorrectionLanguage = 'ja' | 'en';

export interface CorrectionChange {
  before: string;
  after: string;
  reason: CorrectionChangeReason;
}

export interface CorrectionUncertainPart {
  text: string;
  reason: CorrectionUncertainReason;
}

export interface TranscriptCorrection {
  rawText: string;
  correctedText: string;
  status: CorrectionStatus;
  changes: CorrectionChange[];
  uncertainParts: CorrectionUncertainPart[];
  provider?: string;
  model?: string;
  processingTimeMs?: number;
  sourceSegmentIds: string[];
  errorCode?: string;
  requestId?: string;
  segmentId?: string;
  revision?: number;
  attemptCount?: number;
  policyVersion?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GlossaryEntry {
  canonical: string;
  aliases?: string[];
  language?: CorrectionLanguage | 'any';
  caseSensitive?: boolean;
}

export interface CorrectionContextSegment {
  segmentId: string;
  rawText: string;
}

export interface CorrectionInput {
  targetSegmentId: string;
  targetRawText: string;
  previousSegments: CorrectionContextSegment[];
  language: CorrectionLanguage;
  glossary: GlossaryEntry[];
  correctionPolicyVersion: string;
  removeFillers: boolean;
  sourceSegmentIds: string[];
}

export interface CorrectionRequest {
  requestId: string;
  meetingId: string;
  sessionId: string;
  segmentId: string;
  revision: number;
  attemptCount: number;
  input: CorrectionInput;
}

export interface CorrectionProviderOutput {
  correctedText: string;
  changes: CorrectionChange[];
  uncertainParts: CorrectionUncertainPart[];
}

export interface CorrectionServiceStatus {
  enabled: boolean;
  provider: string;
  model: string;
  externalTransmission: boolean;
  timeoutMs: number;
  concurrency: number;
  maxInputChars: number;
  removeFillers: boolean;
  correctionPolicyVersion: string;
  queueLimit: number;
  maxAttempts: number;
}

export interface CorrectionValidationOptions {
  removeFillers: boolean;
  maxOutputRatio?: number;
}

const CHANGE_REASONS = new Set<CorrectionChangeReason>([
  'asr_error', 'punctuation', 'grammar', 'spelling', 'duplicate', 'glossary',
]);
const UNCERTAIN_REASONS = new Set<CorrectionUncertainReason>([
  'number', 'proper_noun', 'technical_term', 'low_context', 'ambiguous',
]);
const JA_FILLERS = ['えっと', 'えーと', 'あの', 'まあ'];
const EN_FILLERS = ['um', 'uh', 'erm'];

export class CorrectionValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CorrectionValidationError';
  }
}

export function createFallbackCorrection(
  rawText: string,
  status: Exclude<CorrectionStatus, 'completed'>,
  sourceSegmentIds: readonly string[],
  details: {
    provider?: string;
    model?: string;
    processingTimeMs?: number;
    errorCode?: string;
    requestId?: string;
    segmentId?: string;
    revision?: number;
    attemptCount?: number;
    policyVersion?: string;
    createdAt?: string;
    updatedAt?: string;
  } = {},
): TranscriptCorrection {
  return {
    rawText,
    correctedText: rawText,
    status,
    changes: [],
    uncertainParts: [],
    provider: details.provider,
    model: details.model,
    processingTimeMs: details.processingTimeMs,
    sourceSegmentIds: [...sourceSegmentIds],
    errorCode: details.errorCode,
    requestId: details.requestId,
    segmentId: details.segmentId,
    revision: details.revision,
    attemptCount: details.attemptCount,
    policyVersion: details.policyVersion,
    createdAt: details.createdAt,
    updatedAt: details.updatedAt,
  };
}

export function parseCorrectionRequest(value: unknown, maxInputChars: number): CorrectionRequest {
  // Accept the pre-pipeline request shape for local compatibility, while
  // normalizing it to the strict internal request metadata.
  if (isRecord(value) && isRecord(value.input)) {
    const input = value.input;
    if (typeof value.sessionId === 'string' && !('requestId' in value)) value.requestId = `legacy-${value.sessionId}`;
    if (typeof value.sessionId === 'string' && !('meetingId' in value)) value.meetingId = value.sessionId;
    if (!('segmentId' in value) && typeof input.targetSegmentId === 'string') value.segmentId = input.targetSegmentId;
    if (!('revision' in value)) value.revision = 0;
    if (!('attemptCount' in value)) value.attemptCount = 1;
  }
  if (
    !isRecord(value)
    || !isSafeIdentifier(value.requestId)
    || !isSafeIdentifier(value.meetingId)
    || !isSafeIdentifier(value.sessionId)
    || !isSafeIdentifier(value.segmentId)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !Number.isSafeInteger(value.attemptCount)
    || (value.attemptCount as number) < 1
    || (value.attemptCount as number) > CORRECTION_MAX_ATTEMPTS
    || !isRecord(value.input)
  ) {
    throw new CorrectionValidationError('invalid_request', '整文リクエストが不正です。');
  }
  const input = value.input;
  if (
    typeof input.targetSegmentId !== 'string'
    || typeof input.targetRawText !== 'string'
    || (input.language !== 'ja' && input.language !== 'en')
    || typeof input.correctionPolicyVersion !== 'string'
    || typeof input.removeFillers !== 'boolean'
    || !Array.isArray(input.previousSegments)
    || !Array.isArray(input.glossary)
    || !Array.isArray(input.sourceSegmentIds)
  ) {
    throw new CorrectionValidationError('invalid_request', '整文入力が不正です。');
  }
  if (input.targetSegmentId !== value.segmentId) {
    throw new CorrectionValidationError('invalid_request', '整文対象のsegment IDが一致しません。');
  }
  if (input.previousSegments.length > 2) {
    throw new CorrectionValidationError('too_many_context_segments', '参考文脈は最大2件です。');
  }
  const previousSegments = input.previousSegments.map((segment) => {
    if (!isRecord(segment) || typeof segment.segmentId !== 'string' || typeof segment.rawText !== 'string') {
      throw new CorrectionValidationError('invalid_context', '参考文脈が不正です。');
    }
    return { segmentId: segment.segmentId, rawText: segment.rawText };
  });
  const glossary = parseGlossary(input.glossary);
  const sourceSegmentIds = input.sourceSegmentIds.map((id) => {
    if (typeof id !== 'string' || !id) throw new CorrectionValidationError('invalid_source_ids', '原文segment IDが不正です。');
    return id;
  });
  const characterCount = input.targetRawText.length
    + previousSegments.reduce((sum, segment) => sum + segment.rawText.length, 0)
    + glossary.reduce((sum, entry) => sum + entry.canonical.length + (entry.aliases ?? []).join('').length, 0);
  if (characterCount > maxInputChars) throw new CorrectionValidationError('input_too_large', '整文入力が上限を超えています。');
  return {
    requestId: value.requestId,
    meetingId: value.meetingId,
    sessionId: value.sessionId,
    segmentId: value.segmentId,
    revision: value.revision as number,
    attemptCount: value.attemptCount as number,
    input: {
      targetSegmentId: input.targetSegmentId,
      targetRawText: input.targetRawText,
      previousSegments,
      language: input.language,
      glossary,
      correctionPolicyVersion: input.correctionPolicyVersion,
      removeFillers: input.removeFillers,
      sourceSegmentIds,
    },
  };
}

export function parseGlossary(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new CorrectionValidationError('invalid_glossary', '用語集が不正です。');
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.canonical !== 'string' || !entry.canonical.trim()) {
      throw new CorrectionValidationError('invalid_glossary', '用語集のcanonicalが不正です。');
    }
    const language = entry.language ?? 'any';
    if (language !== 'ja' && language !== 'en' && language !== 'any') {
      throw new CorrectionValidationError('invalid_glossary', '用語集のlanguageが不正です。');
    }
    const aliases = entry.aliases === undefined ? undefined : parseStringArray(entry.aliases, 'invalid_glossary');
    if (aliases?.some((alias) => !alias.trim())) throw new CorrectionValidationError('invalid_glossary', '空のaliasは使用できません。');
    if (entry.caseSensitive !== undefined && typeof entry.caseSensitive !== 'boolean') {
      throw new CorrectionValidationError('invalid_glossary', '用語集のcaseSensitiveが不正です。');
    }
    return { canonical: entry.canonical, aliases, language, caseSensitive: entry.caseSensitive };
  });
}

export function validateCorrectionOutput(
  value: unknown,
  input: CorrectionInput,
  options: CorrectionValidationOptions,
): CorrectionProviderOutput {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  if (!isRecord(parsed) || typeof parsed.correctedText !== 'string' || !Array.isArray(parsed.changes) || !Array.isArray(parsed.uncertainParts)) {
    throw new CorrectionValidationError('invalid_output_shape', '整文出力の形式が不正です。');
  }
  if (parsed.changes.length > 100 || parsed.uncertainParts.length > 20) {
    throw new CorrectionValidationError('output_too_large', '整文出力の配列が大きすぎます。');
  }
  const changes = parsed.changes.map(parseChange);
  const uncertainParts = parsed.uncertainParts.map(parseUncertainPart);
  const rawText = input.targetRawText;
  if (!parsed.correctedText.trim() || containsUnsafeControl(parsed.correctedText)) {
    throw new CorrectionValidationError('invalid_corrected_text', '整文結果の文字列が不正です。');
  }
  const maximumLength = Math.max(rawText.length + 20, Math.ceil(rawText.length * (options.maxOutputRatio ?? 1.6)));
  if (parsed.correctedText.length > maximumLength) {
    throw new CorrectionValidationError('output_too_long', '整文結果が原文に対して長すぎます。');
  }

  let reconstructed = rawText;
  for (const change of changes) {
    if (change.reason === 'glossary' && !isAllowedGlossaryChange(change, input.glossary, input.language)) {
      throw new CorrectionValidationError('unapproved_glossary_change', '用語集にない変更を拒否しました。');
    }
    const index = reconstructed.indexOf(change.before);
    if (index < 0) throw new CorrectionValidationError('inconsistent_change', '変更対象が原文または直前の修正版に存在しません。');
    reconstructed = `${reconstructed.slice(0, index)}${change.after}${reconstructed.slice(index + change.before.length)}`;
  }
  if (reconstructed !== parsed.correctedText) {
    throw new CorrectionValidationError('inconsistent_output', 'changesから整文結果を再構成できません。');
  }
  if (!options.removeFillers) validateFillersPreserved(rawText, parsed.correctedText, input.language);
  validateProtectedTokens(rawText, parsed.correctedText, changes, input.glossary, input.language);
  validateConservativeEdit(rawText, parsed.correctedText);
  for (const part of uncertainParts) {
    if (!rawText.includes(part.text) && !parsed.correctedText.includes(part.text)) {
      throw new CorrectionValidationError('invalid_uncertain_part', '不確実箇所が対象文に存在しません。');
    }
  }
  return { correctedText: parsed.correctedText, changes, uncertainParts };
}

export function extractProtectedTokens(text: string): string[] {
  const patterns = [
    /https?:\/\/[^\s<>"'）)]+/giu,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
    /(?:[$¥￥€£]\s?\d[\d,.]*|\d[\d,.]*\s?(?:円|ドル|USD|JPY|EUR|GBP))/gu,
    /\d+(?:\.\d+)?\s?(?:%|％)/gu,
    /(?:\d{4}[/.\-年]\d{1,2}[/.\-月]\d{1,2}日?|\d{1,2}月\d{1,2}日)/gu,
    /(?:\b\d{1,2}:\d{2}(?::\d{2})?\b|\d{1,2}時(?:\d{1,2}分)?)/gu,
    /\b[A-Za-z0-9_-]+\.(?:[A-Za-z0-9]{1,8})\b/gu,
    /\b(?=[A-Za-z0-9._/-]*[A-Za-z])(?=[A-Za-z0-9._/-]*(?:\d|[A-Z]{2}|[-_/]))[A-Za-z0-9][A-Za-z0-9._/-]*\b/g,
    /[-+]?\d+(?:,\d{3})*(?:\.\d+)?/gu,
  ];
  const occupied: Array<{ start: number; end: number }> = [];
  const tokens: Array<{ start: number; text: string }> = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const token = match[0];
      if (start === undefined || !token) continue;
      const end = start + token.length;
      if (occupied.some((range) => start < range.end && end > range.start)) continue;
      occupied.push({ start, end });
      tokens.push({ start, text: token });
    }
  }
  return tokens.sort((left, right) => left.start - right.start).map(({ text: token }) => token);
}

export function uncertainReasonForToken(token: string): CorrectionUncertainReason {
  if (/\d/u.test(token)) return 'number';
  if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/u.test(token)) return 'proper_noun';
  return 'technical_term';
}

function parseChange(value: unknown): CorrectionChange {
  if (!isRecord(value) || typeof value.before !== 'string' || !value.before || typeof value.after !== 'string' || !CHANGE_REASONS.has(value.reason as CorrectionChangeReason)) {
    throw new CorrectionValidationError('invalid_change', 'changesの項目が不正です。');
  }
  if (value.after.length > value.before.length * 2 + 16) {
    throw new CorrectionValidationError('change_too_large', '1件の変更が大きすぎます。');
  }
  return { before: value.before, after: value.after, reason: value.reason as CorrectionChangeReason };
}

function parseUncertainPart(value: unknown): CorrectionUncertainPart {
  if (!isRecord(value) || typeof value.text !== 'string' || !value.text || !UNCERTAIN_REASONS.has(value.reason as CorrectionUncertainReason)) {
    throw new CorrectionValidationError('invalid_uncertain_part', 'uncertainPartsの項目が不正です。');
  }
  if (value.text.length > 200 || containsUnsafeControl(value.text)) {
    throw new CorrectionValidationError('invalid_uncertain_part', 'uncertainPartsの文字列が不正です。');
  }
  return { text: value.text, reason: value.reason as CorrectionUncertainReason };
}

function validateProtectedTokens(
  rawText: string,
  correctedText: string,
  changes: readonly CorrectionChange[],
  glossary: readonly GlossaryEntry[],
  language: CorrectionLanguage,
): void {
  const approved = new Map<string, string>();
  for (const change of changes) {
    if (change.reason === 'glossary' && isAllowedGlossaryChange(change, glossary, language)) approved.set(change.before, change.after);
  }
  const expected = extractProtectedTokens(rawText).map((token) => approved.get(token) ?? token);
  const actual = extractProtectedTokens(correctedText);
  if (!sameMultiset(expected, actual)) {
    throw new CorrectionValidationError('protected_token_changed', '数字または保護対象トークンの変更を拒否しました。');
  }
}

function validateFillersPreserved(rawText: string, correctedText: string, language: CorrectionLanguage): void {
  for (const filler of language === 'ja' ? JA_FILLERS : EN_FILLERS) {
    if (countOccurrences(correctedText, filler, language === 'en') < countOccurrences(rawText, filler, language === 'en')) {
      throw new CorrectionValidationError('filler_removal_disabled', 'フィラー除去は無効です。');
    }
  }
}

function validateConservativeEdit(rawText: string, correctedText: string): void {
  const raw = normalizeForEditDistance(rawText);
  const corrected = normalizeForEditDistance(correctedText);
  const distance = levenshtein(raw, corrected);
  const allowed = Math.max(4, Math.floor(Math.max(raw.length, corrected.length) * 0.4));
  if (distance > allowed) throw new CorrectionValidationError('edit_too_large', '原文からの変更量が大きすぎます。');
}

function isAllowedGlossaryChange(
  change: Pick<CorrectionChange, 'before' | 'after'>,
  glossary: readonly GlossaryEntry[],
  language: CorrectionLanguage,
): boolean {
  return glossary.some((entry) => {
    if (entry.language && entry.language !== 'any' && entry.language !== language) return false;
    const equals = entry.caseSensitive ? (left: string, right: string) => left === right : (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase();
    return equals(change.after, entry.canonical) && (entry.aliases ?? []).some((alias) => equals(change.before, alias));
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CorrectionValidationError('invalid_json', '整文出力をJSONとして解析できません。');
  }
}

function parseStringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string')) {
    throw new CorrectionValidationError(code, '文字列配列が不正です。');
  }
  return value as string[];
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) {
    const count = counts.get(value) ?? 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

function countOccurrences(text: string, value: string, wordBoundary: boolean): number {
  if (!wordBoundary) return text.split(value).length - 1;
  return [...text.matchAll(new RegExp(`\\b${escapeRegExp(value)}\\b`, 'giu'))].length;
}

function normalizeForEditDistance(value: string): string {
  return value.normalize('NFKC').replace(/[\s、。,.!?！？「」『』（）()[\]"']/gu, '').toLocaleLowerCase();
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? left.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && value.trim() === value
    && !containsUnsafeControl(value);
}

function containsUnsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
