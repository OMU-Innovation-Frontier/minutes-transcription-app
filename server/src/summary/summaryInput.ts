import { validateLiveMeetingSummary, type FinalSummaryInput, type IncrementalSummaryInput } from '../../../shared/summary.js';

// Whitelist request data before it reaches an external provider. Do not send arbitrary request fields.
export function validateSummaryInput(value: unknown, final: true): FinalSummaryInput;
export function validateSummaryInput(value: unknown, final: false): IncrementalSummaryInput;
export function validateSummaryInput(value: unknown, final: boolean): FinalSummaryInput | IncrementalSummaryInput {
  const object = record(value);
  const sentenceKey = final ? 'sentences' : 'newSentences';
  const summaryKey = final ? 'liveSummary' : 'previousSummary';
  exactKeys(object, ['meetingId', sentenceKey, summaryKey]);
  if (typeof object.meetingId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/u.test(object.meetingId)) throw new Error('invalid meeting');
  const items = object[sentenceKey];
  if (!Array.isArray(items) || items.length === 0 || items.length > 2000) throw new Error('invalid sentences');
  let chars = 0;
  const ids = new Set<string>();
  const sentences = items.map((item) => {
    const sentence = record(item);
    exactKeys(sentence, ['id', 'text', 'startTime', 'endTime']);
    if (typeof sentence.id !== 'string' || !sentence.id.trim() || sentence.id.length > 256 || ids.has(sentence.id)
      || typeof sentence.text !== 'string' || !sentence.text.trim() || sentence.text.length > 20_000
      || typeof sentence.startTime !== 'number' || !Number.isFinite(sentence.startTime) || sentence.startTime < 0
      || typeof sentence.endTime !== 'number' || !Number.isFinite(sentence.endTime) || sentence.endTime < sentence.startTime) throw new Error('invalid sentence');
    ids.add(sentence.id);
    chars += sentence.text.length;
    if (chars > 150_000) throw new Error('input too large');
    return { id: sentence.id, text: sentence.text, startTime: sentence.startTime, endTime: sentence.endTime };
  });
  const summary = object[summaryKey] === null ? null : validateLiveMeetingSummary(object[summaryKey], final ? ids : undefined);
  return final
    ? { meetingId: object.meetingId, sentences, liveSummary: summary }
    : { meetingId: object.meetingId, newSentences: sentences, previousSummary: summary };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error('invalid fields');
}
