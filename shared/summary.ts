export interface SummarySentence {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
}

export interface LiveMeetingSummary {
  version: number;
  topic: string | null;
  keyPoints: Array<{ text: string; evidenceSentenceIds: string[] }>;
  decisions: Array<{ text: string; evidenceSentenceIds: string[] }>;
  actionItems: Array<{
    task: string;
    assignee: string | null;
    dueDate: string | null;
    evidenceSentenceIds: string[];
  }>;
  openQuestions: Array<{ text: string; evidenceSentenceIds: string[] }>;
}

export interface FinalMeetingSummary {
  version: number;
  overview: string;
  agenda: Array<{ text: string; evidenceSentenceIds: string[] }>;
  keyPoints: Array<{ text: string; evidenceSentenceIds: string[] }>;
  decisions: Array<{ text: string; evidenceSentenceIds: string[] }>;
  unresolvedItems: Array<{ text: string; evidenceSentenceIds: string[] }>;
  actionItems: Array<{
    task: string;
    assignee: string | null;
    dueDate: string | null;
    evidenceSentenceIds: string[];
  }>;
  nextChecks: Array<{ text: string; evidenceSentenceIds: string[] }>;
}

export interface IncrementalSummaryInput {
  meetingId: string;
  previousSummary: LiveMeetingSummary | null;
  newSentences: SummarySentence[];
}

export interface FinalSummaryInput {
  meetingId: string;
  liveSummary: LiveMeetingSummary | null;
  sentences: SummarySentence[];
}

export interface ApiUsageRecord {
  meetingId: string;
  purpose: 'live_summary' | 'final_summary';
  provider: 'openai';
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  createdAt: string;
}

export interface MeetingUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  requestCount: number;
  pricingConfigured: boolean;
}

export interface SummaryProvider {
  updateSummary(input: IncrementalSummaryInput): Promise<LiveMeetingSummary>;
  createFinalSummary(input: FinalSummaryInput): Promise<FinalMeetingSummary>;
}

export const LIVE_SUMMARY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'integer', minimum: 1 },
    topic: { type: ['string', 'null'] },
    keyPoints: { type: 'array', items: evidenceItemSchema() },
    decisions: { type: 'array', items: evidenceItemSchema() },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          assignee: { type: ['string', 'null'] },
          dueDate: { type: ['string', 'null'] },
          evidenceSentenceIds: idArraySchema(),
        },
        required: ['task', 'assignee', 'dueDate', 'evidenceSentenceIds'],
        additionalProperties: false,
      },
    },
    openQuestions: { type: 'array', items: evidenceItemSchema() },
  },
  required: ['version', 'topic', 'keyPoints', 'decisions', 'actionItems', 'openQuestions'],
  additionalProperties: false,
} as const;

export const FINAL_SUMMARY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'integer', minimum: 1 },
    overview: { type: 'string' },
    agenda: { type: 'array', items: evidenceItemSchema() },
    keyPoints: { type: 'array', items: evidenceItemSchema() },
    decisions: { type: 'array', items: evidenceItemSchema() },
    unresolvedItems: { type: 'array', items: evidenceItemSchema() },
    actionItems: LIVE_SUMMARY_JSON_SCHEMA.properties.actionItems,
    nextChecks: { type: 'array', items: evidenceItemSchema() },
  },
  required: ['version', 'overview', 'agenda', 'keyPoints', 'decisions', 'unresolvedItems', 'actionItems', 'nextChecks'],
  additionalProperties: false,
} as const;

export function validateLiveMeetingSummary(value: unknown, allowedEvidenceIds?: ReadonlySet<string>): LiveMeetingSummary {
  const object = requireObject(value, 'live summary');
  requireKeys(object, ['version', 'topic', 'keyPoints', 'decisions', 'actionItems', 'openQuestions']);
  requireVersion(object.version);
  if (object.topic !== null) requireText(object.topic, true);
  validateEvidenceItems(object.keyPoints, allowedEvidenceIds);
  validateEvidenceItems(object.decisions, allowedEvidenceIds);
  validateActionItems(object.actionItems, allowedEvidenceIds);
  validateEvidenceItems(object.openQuestions, allowedEvidenceIds);
  return value as LiveMeetingSummary;
}

export function validateFinalMeetingSummary(value: unknown, allowedEvidenceIds?: ReadonlySet<string>): FinalMeetingSummary {
  const object = requireObject(value, 'final summary');
  requireKeys(object, ['version', 'overview', 'agenda', 'keyPoints', 'decisions', 'unresolvedItems', 'actionItems', 'nextChecks']);
  requireVersion(object.version);
  requireText(object.overview, true);
  validateEvidenceItems(object.agenda, allowedEvidenceIds);
  validateEvidenceItems(object.keyPoints, allowedEvidenceIds);
  validateEvidenceItems(object.decisions, allowedEvidenceIds);
  validateEvidenceItems(object.unresolvedItems, allowedEvidenceIds);
  validateActionItems(object.actionItems, allowedEvidenceIds);
  validateEvidenceItems(object.nextChecks, allowedEvidenceIds);
  return value as FinalMeetingSummary;
}

function evidenceItemSchema() {
  return {
    type: 'object',
    properties: { text: { type: 'string' }, evidenceSentenceIds: idArraySchema() },
    required: ['text', 'evidenceSentenceIds'],
    additionalProperties: false,
  } as const;
}

function idArraySchema() {
  return { type: 'array', minItems: 1, items: { type: 'string' } } as const;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}はオブジェクトである必要があります。`);
  return value as Record<string, unknown>;
}

function requireVersion(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('versionが不正です。');
}

function validateEvidenceItems(value: unknown, allowed?: ReadonlySet<string>): void {
  if (!Array.isArray(value) || value.length > 100) throw new Error('要約項目が配列ではないか上限を超えています。');
  for (const item of value) {
    const object = requireObject(item, 'summary item');
    requireKeys(object, ['text', 'evidenceSentenceIds']);
    requireText(object.text);
    validateEvidenceIds(object.evidenceSentenceIds, allowed);
  }
}

function validateActionItems(value: unknown, allowed?: ReadonlySet<string>): void {
  if (!Array.isArray(value) || value.length > 100) throw new Error('actionItemsが配列ではないか上限を超えています。');
  for (const item of value) {
    const object = requireObject(item, 'action item');
    requireKeys(object, ['task', 'assignee', 'dueDate', 'evidenceSentenceIds']);
    requireText(object.task);
    if (object.assignee !== null) requireText(object.assignee);
    if (object.dueDate !== null) requireText(object.dueDate);
    validateEvidenceIds(object.evidenceSentenceIds, allowed);
  }
}

function validateEvidenceIds(value: unknown, allowed?: ReadonlySet<string>): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2000 || value.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256)) {
    throw new Error('根拠文IDがありません。');
  }
  if (allowed && value.some((id) => !allowed.has(id as string))) throw new Error('未知の根拠文IDが含まれています。');
}

function requireKeys(object: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) throw new Error('要約のフィールドが不正です。');
}

function requireText(value: unknown, allowEmpty = false): void {
  if (typeof value !== 'string' || value.length > 20_000 || (!allowEmpty && !value.trim())) throw new Error('要約本文が不正です。');
}
