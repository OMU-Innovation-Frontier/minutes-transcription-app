import { describe, expect, it, vi } from 'vitest';
import { createFallbackCorrection, type CorrectionInput, type CorrectionRequest, type CorrectionServiceStatus, type TranscriptCorrection } from '../../shared/correction';
import { TranscriptStore } from '../transcription/transcriptStore';
import type { CompletedSentence, TranscriptUpdate } from '../transcription/types';
import { CorrectionCoordinator, MemoryCorrectionStorage, type CorrectionHttpClient } from './correctionClient';

const enabledStatus: CorrectionServiceStatus = {
  enabled: true,
  provider: 'mock',
  externalTransmission: false,
  timeoutMs: 100,
  concurrency: 1,
  maxInputChars: 4_000,
  removeFillers: false,
  correctionPolicyVersion: 'safe-correction-v1',
};

function makeStore(texts: string[]): TranscriptStore {
  let id = 0;
  const store = new TranscriptStore({ createId: () => `sentence-${++id}` });
  store.startSession('session-1');
  texts.forEach((text, index) => {
    const update: TranscriptUpdate = {
      sessionId: 'session-1', segmentId: `segment-${index + 1}`, sequence: index, revision: 0,
      text, isFinal: true, language: 'ja-JP', provider: 'test', startTime: index * 100,
      endTime: index * 100 + 50, createdAt: '2026-07-17T00:00:00.000Z',
    };
    store.apply(update);
    store.finalizeSentenceManually();
  });
  return store;
}

function completed(input: CorrectionInput): TranscriptCorrection {
  const last = input.targetRawText.at(-1) ?? '';
  return {
    ...createFallbackCorrection(input.targetRawText, 'pending', input.sourceSegmentIds),
    correctedText: last ? `${input.targetRawText}。` : input.targetRawText,
    status: 'completed',
    changes: last ? [{ before: last, after: `${last}。`, reason: 'punctuation' }] : [],
    provider: 'mock',
  };
}

function client(correct: (input: CorrectionInput, signal: AbortSignal) => Promise<TranscriptCorrection>, status = enabledStatus): CorrectionHttpClient {
  return {
    status: async () => status,
    correct: async (request: CorrectionRequest, signal: AbortSignal) => correct(request.input, signal),
  } as unknown as CorrectionHttpClient;
}

describe('CorrectionCoordinator', () => {
  it('shows raw correction state immediately while work is pending', async () => {
    const store = makeStore(['確認します']);
    let resolve!: (value: TranscriptCorrection) => void;
    const pending = new Promise<TranscriptCorrection>((done) => { resolve = done; });
    const coordinator = new CorrectionCoordinator(client(async () => pending), store, 'session-1');
    coordinator.add(store.snapshot().completedSentences);
    await coordinator.initialize();
    expect(store.snapshot().completedSentences[0]?.correction).toMatchObject({ status: 'pending', rawText: '確認します' });
    resolve(completed(toInput(store.snapshot().completedSentences[0]!)));
    await vi.waitFor(() => expect(store.snapshot().completedSentences[0]?.correction?.status).toBe('completed'));
  });

  it('does not process the same sentence twice', async () => {
    const store = makeStore(['一文目']);
    const correct = vi.fn(async (input: CorrectionInput) => completed(input));
    const coordinator = new CorrectionCoordinator(client(correct), store, 'session-1');
    coordinator.add(store.snapshot().completedSentences);
    coordinator.add(store.snapshot().completedSentences);
    await coordinator.initialize();
    await vi.waitFor(() => expect(store.snapshot().completedSentences[0]?.correction?.status).toBe('completed'));
    coordinator.add(store.snapshot().completedSentences);
    expect(correct).toHaveBeenCalledTimes(1);
  });

  it('uses an independent FIFO and includes at most two preceding sentences', async () => {
    const store = makeStore(['一文目', '二文目', '三文目']);
    const inputs: CorrectionInput[] = [];
    const coordinator = new CorrectionCoordinator(client(async (input) => {
      inputs.push(input);
      return completed(input);
    }), store, 'session-1');
    coordinator.add(store.snapshot().completedSentences);
    await coordinator.initialize();
    await vi.waitFor(() => expect(inputs).toHaveLength(3));
    expect(inputs.map((item) => item.targetSegmentId)).toEqual(['sentence-1', 'sentence-2', 'sentence-3']);
    expect(inputs[2]?.previousSegments.map((item) => item.segmentId)).toEqual(['sentence-1', 'sentence-2']);
  });

  it('does not apply delayed results to another segment when concurrency is greater than one', async () => {
    const store = makeStore(['一文目', '二文目']);
    const resolvers = new Map<string, (value: TranscriptCorrection) => void>();
    const coordinator = new CorrectionCoordinator(client((input) => new Promise((resolve) => {
      resolvers.set(input.targetSegmentId, resolve);
    }), { ...enabledStatus, concurrency: 2 }), store, 'session-1');
    coordinator.add(store.snapshot().completedSentences);
    await coordinator.initialize();
    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    const sentences = store.snapshot().completedSentences;
    resolvers.get('sentence-2')?.(completed(toInput(sentences[1]!)));
    resolvers.get('sentence-1')?.(completed(toInput(sentences[0]!)));
    await vi.waitFor(() => expect(store.snapshot().completedSentences.every((item) => item.correction?.status === 'completed')).toBe(true));
    expect(store.snapshot().completedSentences.map((item) => item.correction?.rawText)).toEqual(['一文目', '二文目']);
  });

  it('discards a response after cancellation', async () => {
    const store = makeStore(['キャンセル対象']);
    let resolve!: (value: TranscriptCorrection) => void;
    const coordinator = new CorrectionCoordinator(client(async () => new Promise((done) => { resolve = done; })), store, 'session-1');
    coordinator.add(store.snapshot().completedSentences);
    await coordinator.initialize();
    const sentence = store.snapshot().completedSentences[0]!;
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    coordinator.dispose();
    resolve(completed(toInput(sentence)));
    await Promise.resolve();
    expect(store.snapshot().completedSentences[0]?.correction?.status).toBe('pending');
  });

  it('continues with the next job after a client timeout', async () => {
    const store = makeStore(['遅い文', '次の文']);
    let calls = 0;
    const coordinator = new CorrectionCoordinator(client(async (input, signal) => {
      calls += 1;
      if (calls === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true }));
      return completed(input);
    }, { ...enabledStatus, timeoutMs: 5 }), store, 'session-1');
    coordinator.add(store.snapshot().completedSentences);
    await coordinator.initialize();
    await vi.waitFor(() => expect(store.snapshot().completedSentences[1]?.correction?.status).toBe('completed'));
    expect(store.snapshot().completedSentences[0]?.correction).toMatchObject({ status: 'failed', correctedText: '遅い文' });
  });

  it('restores a persisted result without another provider call', async () => {
    const store = makeStore(['保存済み']);
    const sentence = store.snapshot().completedSentences[0]!;
    const storage = new MemoryCorrectionStorage();
    await storage.put('session-1', sentence.id, completed(toInput(sentence)));
    const correct = vi.fn(async (input: CorrectionInput) => completed(input));
    const coordinator = new CorrectionCoordinator(client(correct), store, 'session-1', {}, { storage });
    coordinator.add(store.snapshot().completedSentences);
    await coordinator.initialize();
    await vi.waitFor(() => expect(store.snapshot().completedSentences[0]?.correction?.status).toBe('completed'));
    expect(correct).not.toHaveBeenCalled();
    expect(store.snapshot().completedSentences[0]?.correction?.rawText).toBe('保存済み');
  });

  it('does not call correction when the feature is disabled', async () => {
    const store = makeStore(['無効時']);
    const correct = vi.fn(async (input: CorrectionInput) => completed(input));
    const coordinator = new CorrectionCoordinator(client(correct, { ...enabledStatus, enabled: false }), store, 'session-1');
    coordinator.add(store.snapshot().completedSentences);
    await coordinator.initialize();
    expect(correct).not.toHaveBeenCalled();
    expect(store.snapshot().completedSentences[0]?.correction?.status).toBe('disabled');
  });
});

function toInput(sentence: CompletedSentence): CorrectionInput {
  return {
    targetSegmentId: sentence.id,
    targetRawText: sentence.rawText,
    previousSegments: [],
    language: sentence.language,
    glossary: [],
    correctionPolicyVersion: 'safe-correction-v1',
    removeFillers: false,
    sourceSegmentIds: [...sentence.rawSegmentIds],
  };
}
