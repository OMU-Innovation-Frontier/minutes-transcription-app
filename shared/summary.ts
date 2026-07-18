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
  requireVersion(object.version);
  if (object.topic !== null && typeof object.topic !== 'string') throw new Error('topicが不正です。');
  validateEvidenceItems(object.keyPoints, allowedEvidenceIds);
  validateEvidenceItems(object.decisions, allowedEvidenceIds);
  validateActionItems(object.actionItems, allowedEvidenceIds);
  validateEvidenceItems(object.openQuestions, allowedEvidenceIds);
  return value as LiveMeetingSummary;
}

export function validateFinalMeetingSummary(value: unknown, allowedEvidenceIds?: ReadonlySet<string>): FinalMeetingSummary {
  const object = requireObject(value, 'final summary');
  requireVersion(object.version);
  if (typeof object.overview !== 'string') throw new Error('overviewが不正です。');
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
  if (!Array.isArray(value)) throw new Error('要約項目が配列ではありません。');
  for (const item of value) {
    const object = requireObject(item, 'summary item');
    if (typeof object.text !== 'string' || !object.text.trim()) throw new Error('要約本文が空です。');
    validateEvidenceIds(object.evidenceSentenceIds, allowed);
  }
}

function validateActionItems(value: unknown, allowed?: ReadonlySet<string>): void {
  if (!Array.isArray(value)) throw new Error('actionItemsが配列ではありません。');
  for (const item of value) {
    const object = requireObject(item, 'action item');
    if (typeof object.task !== 'string' || !object.task.trim()) throw new Error('taskが空です。');
    if (object.assignee !== null && typeof object.assignee !== 'string') throw new Error('assigneeが不正です。');
    if (object.dueDate !== null && typeof object.dueDate !== 'string') throw new Error('dueDateが不正です。');
    validateEvidenceIds(object.evidenceSentenceIds, allowed);
  }
}

function validateEvidenceIds(value: unknown, allowed?: ReadonlySet<string>): void {
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string')) {
    throw new Error('根拠文IDがありません。');
  }
  if (allowed && value.some((id) => !allowed.has(id as string))) throw new Error('未知の根拠文IDが含まれています。');
}
