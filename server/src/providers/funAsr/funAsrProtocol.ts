import type { WireLanguage } from '../../../../shared/protocol.js';

export const FUN_ASR_REALTIME_MODEL = 'fun-asr-realtime';
export const FUN_ASR_SAMPLE_RATE = 16_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCABULARY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TEXT_LENGTH = 100_000;
const MAX_WORDS = 10_000;
const MAX_SENTENCE_ID = 1_000_000;
const MAX_EVENT_TIMESTAMP_MS = 86_400_000;
const MAX_USAGE_DURATION_SECONDS = 86_400;

export interface FunAsrRunTaskOptions {
  taskId: string;
  model?: string;
  language: WireLanguage;
  sampleRate?: number;
  vocabularyId?: string;
  semanticPunctuationEnabled?: boolean;
  maxSentenceSilenceMs?: number;
  multiThresholdModeEnabled?: boolean;
  heartbeat?: boolean;
}

export interface FunAsrRunTaskEvent {
  header: {
    action: 'run-task';
    task_id: string;
    streaming: 'duplex';
  };
  payload: {
    task_group: 'audio';
    task: 'asr';
    function: 'recognition';
    model: typeof FUN_ASR_REALTIME_MODEL;
    input: Record<string, never>;
    parameters: {
      format: 'pcm';
      sample_rate: typeof FUN_ASR_SAMPLE_RATE;
      language_hints: [WireLanguage];
      semantic_punctuation_enabled: boolean;
      max_sentence_silence: number;
      multi_threshold_mode_enabled: boolean;
      heartbeat: boolean;
      vocabulary_id?: string;
    };
  };
}

export interface FunAsrFinishTaskEvent {
  header: {
    action: 'finish-task';
    task_id: string;
    streaming: 'duplex';
  };
  payload: { input: Record<string, never> };
}

export interface FunAsrWord {
  beginTimeMs: number;
  endTimeMs: number;
  text: string;
  punctuation: string;
}

export type FunAsrServerEvent =
  | { type: 'task-started'; taskId: string }
  | {
      type: 'result-generated';
      taskId: string;
      sentenceId: number;
      sentenceEnd: boolean;
      text: string;
      heartbeat: boolean;
      beginTimeMs: number;
      endTimeMs: number;
      words: FunAsrWord[];
      usageDurationSeconds?: number;
    }
  | { type: 'task-finished'; taskId: string; usageDurationSeconds?: number }
  | { type: 'task-failed'; taskId: string; errorCode?: string };

export class FunAsrProtocolError extends Error {
  constructor() {
    super('Fun-ASR protocol event was invalid.');
    this.name = 'FunAsrProtocolError';
  }
}

export function createFunAsrRunTask(options: FunAsrRunTaskOptions): FunAsrRunTaskEvent {
  assertTaskId(options.taskId);
  if ((options.model ?? FUN_ASR_REALTIME_MODEL) !== FUN_ASR_REALTIME_MODEL) throw new FunAsrProtocolError();
  if (options.language !== 'ja' && options.language !== 'en') throw new FunAsrProtocolError();
  if ((options.sampleRate ?? FUN_ASR_SAMPLE_RATE) !== FUN_ASR_SAMPLE_RATE) throw new FunAsrProtocolError();
  if (options.vocabularyId !== undefined && !VOCABULARY_ID_PATTERN.test(options.vocabularyId)) {
    throw new FunAsrProtocolError();
  }
  const maxSentenceSilenceMs = options.maxSentenceSilenceMs ?? 1_300;
  if (!Number.isSafeInteger(maxSentenceSilenceMs) || maxSentenceSilenceMs < 200 || maxSentenceSilenceMs > 6_000) {
    throw new FunAsrProtocolError();
  }

  const parameters: FunAsrRunTaskEvent['payload']['parameters'] = {
    format: 'pcm',
    sample_rate: FUN_ASR_SAMPLE_RATE,
    language_hints: [options.language],
    semantic_punctuation_enabled: options.semanticPunctuationEnabled ?? false,
    max_sentence_silence: maxSentenceSilenceMs,
    multi_threshold_mode_enabled: options.multiThresholdModeEnabled ?? false,
    heartbeat: options.heartbeat ?? false,
  };
  if (options.vocabularyId !== undefined) parameters.vocabulary_id = options.vocabularyId;

  return {
    header: { action: 'run-task', task_id: options.taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: FUN_ASR_REALTIME_MODEL,
      input: {},
      parameters,
    },
  };
}

export function createFunAsrFinishTask(taskId: string): FunAsrFinishTaskEvent {
  assertTaskId(taskId);
  return {
    header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: {} },
  };
}

export function parseFunAsrServerEvent(value: unknown): FunAsrServerEvent {
  const root = asRecord(value);
  const header = asRecord(root.header);
  const event = readString(header.event, 100);
  const taskId = readString(header.task_id, 100);
  assertTaskId(taskId);
  const payload = asRecord(root.payload);

  if (event === 'task-started') return { type: event, taskId };
  if (event === 'task-finished') {
    return { type: event, taskId, ...readOptionalUsage(payload.usage) };
  }
  if (event === 'task-failed') {
    const errorCode = header.error_code === undefined ? undefined : readString(header.error_code, 200);
    if (header.error_message !== undefined) readString(header.error_message, 10_000);
    return errorCode === undefined ? { type: event, taskId } : { type: event, taskId, errorCode };
  }
  if (event !== 'result-generated') throw new FunAsrProtocolError();

  const output = asRecord(payload.output);
  const sentence = asRecord(output.sentence);
  const sentenceId = readSafeInteger(sentence.sentence_id, 0, MAX_SENTENCE_ID);
  const heartbeat = readBoolean(sentence.heartbeat);
  const sentenceEnd = readBoolean(sentence.sentence_end);
  if ((heartbeat && sentenceId !== 0) || (!heartbeat && sentenceId < 1)) throw new FunAsrProtocolError();
  const beginTimeMs = readSafeInteger(sentence.begin_time, 0, MAX_EVENT_TIMESTAMP_MS);
  const endTimeMs = readSafeInteger(sentence.end_time, beginTimeMs, MAX_EVENT_TIMESTAMP_MS);
  const text = readString(sentence.text, MAX_TEXT_LENGTH);
  const rawWords = sentence.words === undefined ? [] : sentence.words;
  if (!Array.isArray(rawWords) || rawWords.length > MAX_WORDS) throw new FunAsrProtocolError();
  const words = rawWords.map((word) => parseWord(word, beginTimeMs, endTimeMs));
  return {
    type: event,
    taskId,
    sentenceId,
    sentenceEnd,
    text,
    heartbeat,
    beginTimeMs,
    endTimeMs,
    words,
    ...readOptionalUsage(payload.usage),
  };
}

function parseWord(value: unknown, sentenceBeginMs: number, sentenceEndMs: number): FunAsrWord {
  const word = asRecord(value);
  const beginTimeMs = readSafeInteger(word.begin_time, sentenceBeginMs, sentenceEndMs);
  const endTimeMs = readSafeInteger(word.end_time, beginTimeMs, sentenceEndMs);
  if (endTimeMs > sentenceEndMs) throw new FunAsrProtocolError();
  return {
    beginTimeMs,
    endTimeMs,
    text: readString(word.text, 10_000),
    punctuation: readString(word.punctuation ?? '', 100),
  };
}

function readOptionalUsage(value: unknown): { usageDurationSeconds?: number } {
  if (value === undefined || value === null) return {};
  const usage = asRecord(value);
  const duration = readSafeInteger(usage.duration, 0, MAX_USAGE_DURATION_SECONDS);
  return { usageDurationSeconds: duration };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FunAsrProtocolError();
  return value as Record<string, unknown>;
}

function readString(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string' || value.length > maximumLength) throw new FunAsrProtocolError();
  return value;
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new FunAsrProtocolError();
  return value;
}

function readSafeInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new FunAsrProtocolError();
  }
  return value as number;
}

function assertTaskId(taskId: string): void {
  if (!UUID_PATTERN.test(taskId)) throw new FunAsrProtocolError();
}
