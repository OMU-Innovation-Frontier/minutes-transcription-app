import {
  extractProtectedTokens,
  uncertainReasonForToken,
  type CorrectionChange,
  type CorrectionInput,
  type CorrectionProviderOutput,
  type GlossaryEntry,
} from '../../../shared/correction.js';
import type { CorrectionProvider } from './provider.js';

export type MockCorrectionScenario =
  | 'normal'
  | 'invalid-json'
  | 'timeout'
  | 'number-change'
  | 'long-output'
  | 'delayed';

export interface MockCorrectionProviderOptions {
  scenario?: MockCorrectionScenario;
  delayMs?: number;
}

export class MockCorrectionProvider implements CorrectionProvider {
  readonly name = 'mock';
  readonly model = 'deterministic-mock-v1';
  readonly externalTransmission = false;

  constructor(private readonly options: MockCorrectionProviderOptions = {}) {}

  async correct(input: CorrectionInput, signal: AbortSignal): Promise<string> {
    const scenario = this.options.scenario ?? 'normal';
    if (scenario === 'timeout') await abortableDelay(this.options.delayMs ?? 60_000, signal);
    if (scenario === 'delayed') await abortableDelay(this.options.delayMs ?? 50, signal);
    if (signal.aborted) throw abortError();
    if (scenario === 'invalid-json') return '{invalid';
    if (scenario === 'number-change') {
      return JSON.stringify({ correctedText: input.targetRawText.replace(/\d/u, '9'), changes: [], uncertainParts: [] });
    }
    if (scenario === 'long-output') {
      return JSON.stringify({ correctedText: input.targetRawText.repeat(20), changes: [], uncertainParts: [] });
    }
    return JSON.stringify(createDeterministicOutput(input));
  }

  async dispose(): Promise<void> {}
}

function createDeterministicOutput(input: CorrectionInput): CorrectionProviderOutput {
  let correctedText = input.targetRawText;
  const changes: CorrectionChange[] = [];
  const spellingPairs: Array<[string, string]> = input.language === 'ja'
    ? [['こんにちわ', 'こんにちは']]
    : [['teh', 'the']];
  for (const [before, after] of spellingPairs) {
    if (!correctedText.includes(before)) continue;
    correctedText = correctedText.replace(before, after);
    changes.push({ before, after, reason: 'spelling' });
  }
  for (const entry of input.glossary) correctedText = applyGlossary(correctedText, entry, input.language, changes);
  const trimmed = correctedText.trimEnd();
  if (trimmed && !/[。！？.!?]$/u.test(trimmed)) {
    const last = trimmed.at(-1);
    if (last) {
      const after = `${last}${input.language === 'ja' ? '。' : '.'}`;
      correctedText = `${trimmed.slice(0, -1)}${after}${correctedText.slice(trimmed.length)}`;
      changes.push({ before: last, after, reason: 'punctuation' });
    }
  }
  return {
    correctedText,
    changes,
    uncertainParts: extractProtectedTokens(input.targetRawText).map((text) => ({
      text,
      reason: uncertainReasonForToken(text),
    })),
  };
}

function applyGlossary(
  text: string,
  entry: GlossaryEntry,
  language: CorrectionInput['language'],
  changes: CorrectionChange[],
): string {
  if (entry.language && entry.language !== 'any' && entry.language !== language) return text;
  for (const alias of entry.aliases ?? []) {
    const index = entry.caseSensitive
      ? text.indexOf(alias)
      : text.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase());
    if (index < 0) continue;
    const before = text.slice(index, index + alias.length);
    changes.push({ before, after: entry.canonical, reason: 'glossary' });
    return `${text.slice(0, index)}${entry.canonical}${text.slice(index + alias.length)}`;
  }
  return text;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('Mock correction was aborted.');
  error.name = 'AbortError';
  return error;
}
