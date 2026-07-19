// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createFunAsrFinishTask,
  createFunAsrRunTask,
  FUN_ASR_REALTIME_MODEL,
  FunAsrProtocolError,
  parseFunAsrServerEvent,
} from '../src/providers/funAsr/funAsrProtocol';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

describe('Fun-ASR protocol', () => {
  it.each(['ja', 'en'] as const)('builds a 16 kHz PCM duplex run-task for %s', (language) => {
    const event = createFunAsrRunTask({ taskId: TASK_ID, language });
    expect(event).toEqual({
      header: { action: 'run-task', task_id: TASK_ID, streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'asr', function: 'recognition', model: FUN_ASR_REALTIME_MODEL,
        input: {},
        parameters: {
          format: 'pcm', sample_rate: 16_000, language_hints: [language],
          semantic_punctuation_enabled: false, max_sentence_silence: 1_300,
          multi_threshold_mode_enabled: false, heartbeat: false,
        },
      },
    });
  });

  it('accepts only the stable model, 16 kHz, and constrained options', () => {
    expect(() => createFunAsrRunTask({ taskId: TASK_ID, language: 'ja', model: 'old-model' })).toThrow(FunAsrProtocolError);
    expect(() => createFunAsrRunTask({ taskId: TASK_ID, language: 'ja', sampleRate: 24_000 })).toThrow(FunAsrProtocolError);
    expect(() => createFunAsrRunTask({ taskId: TASK_ID, language: 'ja', vocabularyId: 'unsafe value' })).toThrow(FunAsrProtocolError);
    expect(() => createFunAsrRunTask({ taskId: TASK_ID, language: 'ja', maxSentenceSilenceMs: 199 })).toThrow(FunAsrProtocolError);
  });

  it('builds finish-task with the same task ID', () => {
    expect(createFunAsrFinishTask(TASK_ID)).toEqual({
      header: { action: 'finish-task', task_id: TASK_ID, streaming: 'duplex' }, payload: { input: {} },
    });
  });

  it('parses result-generated fields and usage without retaining error messages', () => {
    const event = parseFunAsrServerEvent(resultEvent({ sentenceId: 1, sentenceEnd: true, text: '人工音声', usage: 3 }));
    expect(event).toMatchObject({
      type: 'result-generated', taskId: TASK_ID, sentenceId: 1, sentenceEnd: true,
      text: '人工音声', heartbeat: false, beginTimeMs: 100, endTimeMs: 400,
      usageDurationSeconds: 3,
    });
    expect(event.type === 'result-generated' && event.words).toEqual([
      { beginTimeMs: 100, endTimeMs: 300, text: '人工', punctuation: '' },
    ]);
    expect(parseFunAsrServerEvent({
      header: { event: 'task-failed', task_id: TASK_ID, error_code: 'AnyExternalCode', error_message: 'must not escape' },
      payload: {},
    })).toEqual({ type: 'task-failed', taskId: TASK_ID, errorCode: 'AnyExternalCode' });
  });

  it('recognizes heartbeat and rejects malformed or unknown events', () => {
    const heartbeat = resultEvent({ sentenceId: 0, sentenceEnd: false, text: '', heartbeat: true });
    expect(parseFunAsrServerEvent(heartbeat)).toMatchObject({ type: 'result-generated', heartbeat: true, sentenceId: 0 });
    expect(() => parseFunAsrServerEvent({ header: { event: 'unknown', task_id: TASK_ID }, payload: {} })).toThrow(FunAsrProtocolError);
    expect(() => parseFunAsrServerEvent(resultEvent({ sentenceId: -1, sentenceEnd: false, text: '' }))).toThrow(FunAsrProtocolError);
    expect(() => parseFunAsrServerEvent(null)).toThrow(FunAsrProtocolError);
  });

  it.each([undefined, '3', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_401])(
    'rejects invalid usage.duration values (%s)',
    (usage) => {
      const event = resultEvent({ sentenceId: 1, sentenceEnd: true, text: 'sample', usage });
      if (usage === undefined) {
        expect(parseFunAsrServerEvent(event)).toMatchObject({ type: 'result-generated' });
      } else {
        expect(() => parseFunAsrServerEvent(event)).toThrow(FunAsrProtocolError);
      }
    },
  );

  it('rejects unsafe sentence and timestamp values', () => {
    expect(() => parseFunAsrServerEvent(resultEvent({
      sentenceId: 1_000_001, sentenceEnd: true, text: 'sample',
    }))).toThrow(FunAsrProtocolError);
    expect(() => parseFunAsrServerEvent(resultEvent({
      sentenceId: 1, sentenceEnd: true, text: 'sample', beginTime: -1,
    }))).toThrow(FunAsrProtocolError);
    expect(() => parseFunAsrServerEvent(resultEvent({
      sentenceId: 1, sentenceEnd: true, text: 'sample', beginTime: 500, endTime: 400,
    }))).toThrow(FunAsrProtocolError);
    expect(() => parseFunAsrServerEvent(resultEvent({
      sentenceId: 1, sentenceEnd: true, text: 'sample', endTime: Number.POSITIVE_INFINITY,
    }))).toThrow(FunAsrProtocolError);
  });
});

export function resultEvent(options: {
  sentenceId: unknown;
  sentenceEnd: boolean;
  text: string;
  heartbeat?: boolean;
  usage?: unknown;
  taskId?: string;
  beginTime?: unknown;
  endTime?: unknown;
}): unknown {
  return {
    header: { event: 'result-generated', task_id: options.taskId ?? TASK_ID },
    payload: {
      output: { sentence: {
        sentence_id: options.sentenceId, sentence_end: options.sentenceEnd, text: options.text,
        heartbeat: options.heartbeat ?? false,
        begin_time: options.beginTime ?? 100,
        end_time: options.endTime ?? 400,
        words: [{ begin_time: 100, end_time: 300, text: '人工', punctuation: '' }],
      } },
      ...(options.usage === undefined ? { usage: null } : { usage: { duration: options.usage } }),
    },
  };
}
