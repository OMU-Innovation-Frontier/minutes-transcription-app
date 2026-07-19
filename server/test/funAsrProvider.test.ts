// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FunAsrProvider } from '../src/providers/funAsr/funAsrProvider';
import { FunAsrUsageGuard } from '../src/providers/funAsr/funAsrUsageGuard';
import type { ServerProviderError, SttTranscriptResult } from '../src/providers/types';
import { FakeFunAsrTransport } from './support/fakeFunAsrTransport';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = 'session-one';

describe('FunAsrProvider Phase 0', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for task-started before completing startSession', async () => {
    const { provider, transport } = setup();
    let settled = false;
    const started = provider.startSession(sessionConfig()).then(() => { settled = true; });
    await waitForControl(transport);
    expect(settled).toBe(false);
    expect(transport.controls[0]).toMatchObject({ header: { action: 'run-task', task_id: TASK_ID } });
    transport.emitMessage(serverEvent('task-started'));
    await started;
    expect(settled).toBe(true);
    await provider.cancelSession(SESSION_ID);
  });

  it('sends copied binary PCM chunks in sequence after reserving usage', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    await start(provider, transport);
    const audio = new Uint8Array([1, 2, 3, 4]);
    await provider.sendAudio(audioChunk(0, audio));
    audio[0] = 99;
    expect(transport.audioChunks).toEqual([new Uint8Array([1, 2, 3, 4])]);
    expect(guard.getSessionFrames(SESSION_ID)).toBe(2);
    await expect(provider.sendAudio(audioChunk(2, new Uint8Array([1, 2])))).rejects.toMatchObject({ code: 'fun_asr_audio_sequence_invalid' });
    await provider.cancelSession(SESSION_ID);
  });

  it('accepts empty PCM without transport send and rejects malformed PCM before sending', async () => {
    const { provider, transport } = setup();
    await start(provider, transport);
    await provider.sendAudio(audioChunk(0, new Uint8Array(), 0));
    expect(transport.audioChunks).toHaveLength(0);
    await expect(provider.sendAudio(audioChunk(1, new Uint8Array([1]), 0))).rejects.toMatchObject({ code: 'fun_asr_pcm_invalid' });
    expect(transport.audioChunks).toHaveLength(0);
    await provider.cancelSession(SESSION_ID);
  });

  it('updates one partial segment with monotonic revisions and emits one final', async () => {
    const { provider, transport } = setup();
    const transcripts: SttTranscriptResult[] = [];
    provider.onTranscript((result) => transcripts.push(result));
    await start(provider, transport);
    transport.emitMessage(resultEvent(1, false, 'テスト'));
    transport.emitMessage(resultEvent(1, false, 'テスト音声'));
    transport.emitMessage(resultEvent(1, true, 'テスト音声です'));
    transport.emitMessage(resultEvent(1, true, '重複'));
    transport.emitMessage(resultEvent(1, false, '遅延'));
    expect(transcripts.map(({ segmentId, revision, isFinal, text }) => ({ segmentId, revision, isFinal, text }))).toEqual([
      { segmentId: `fun-asr:${TASK_ID}:1`, revision: 0, isFinal: false, text: 'テスト' },
      { segmentId: `fun-asr:${TASK_ID}:1`, revision: 1, isFinal: false, text: 'テスト音声' },
      { segmentId: `fun-asr:${TASK_ID}:1`, revision: 2, isFinal: true, text: 'テスト音声です' },
    ]);
    await provider.cancelSession(SESSION_ID);
  });

  it('emits out-of-order finals in sentence_id order', async () => {
    const { provider, transport } = setup();
    const finals: SttTranscriptResult[] = [];
    provider.onTranscript((result) => { if (result.isFinal) finals.push(result); });
    await start(provider, transport);
    transport.emitMessage(resultEvent(2, true, '二番'));
    expect(finals).toHaveLength(0);
    transport.emitMessage(resultEvent(1, true, '一番'));
    expect(finals.map((result) => result.text)).toEqual(['一番', '二番']);
    await provider.cancelSession(SESSION_ID);
  });

  it('lets an empty final advance ordering without emitting it', async () => {
    const { provider, transport } = setup();
    const finals: string[] = [];
    provider.onTranscript((result) => { if (result.isFinal) finals.push(result.text); });
    await start(provider, transport);
    transport.emitMessage(resultEvent(2, true, '二番'));
    transport.emitMessage(resultEvent(1, true, '   '));
    expect(finals).toEqual(['二番']);
    await provider.cancelSession(SESSION_ID);
  });

  it('ignores heartbeat transcripts and records usage.duration', async () => {
    const { provider, transport } = setup();
    const transcripts: SttTranscriptResult[] = [];
    provider.onTranscript((result) => transcripts.push(result));
    await start(provider, transport);
    transport.emitMessage(resultEvent(0, false, '', { heartbeat: true, usage: 7 }));
    expect(transcripts).toHaveLength(0);
    expect(provider.usageDurationSeconds).toBe(7);
    transport.emitMessage(resultEvent(0, false, '', { heartbeat: true, usage: 3 }));
    expect(provider.usageDurationSeconds).toBe(7);
    await provider.cancelSession(SESSION_ID);
  });

  it('maps task-failed and protocol failures without exposing external messages', async () => {
    const { provider, transport } = setup();
    const errors: ServerProviderError[] = [];
    provider.onError((error) => errors.push(error));
    await start(provider, transport);
    transport.emitMessage({
      header: { event: 'task-failed', task_id: TASK_ID, error_code: 'ExternalCode', error_message: 'external detail must stay private' },
      payload: {},
    });
    expect(errors[0]).toMatchObject({ code: 'fun_asr_task_failed', retryable: false });
    expect(errors[0]?.message).not.toContain('external detail');
    await provider.dispose();
  });

  it('ignores empty partials and maps relative timestamps onto the session timeline', async () => {
    const { provider, transport } = setup();
    const transcripts: SttTranscriptResult[] = [];
    provider.onTranscript((result) => transcripts.push(result));
    await start(provider, transport);
    transport.emitMessage(resultEvent(1, false, '   '));
    transport.emitMessage(resultEvent(1, false, 'sample'));
    transport.emitMessage(resultEvent(1, true, 'sample final'));
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toMatchObject({ revision: 0, isFinal: false });
    expect(transcripts[1]).toMatchObject({
      revision: 1,
      isFinal: true,
      startTime: 1_700_000_001_000,
      endTime: 1_700_000_001_500,
      segments: [{ startTimeMs: 0, endTimeMs: 400 }],
    });
    await provider.cancelSession(SESSION_ID);
  });

  it('releases the concurrent slot when connect fails', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    transport.failConnect = true;
    await expect(provider.startSession(sessionConfig())).rejects.toMatchObject({ code: 'fun_asr_transport_closed' });
    expect(guard.activeSessionCount).toBe(0);
    expect(transport.closeCount).toBe(1);
    expect(transport.listenerCount).toBe(0);
  });

  it('stops idempotently with one finish-task and releases resources', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    await start(provider, transport);
    const first = provider.stopSession(SESSION_ID);
    const second = provider.stopSession(SESSION_ID);
    await waitForControls(transport, 2);
    expect(transport.controls.filter((value) => controlAction(value) === 'finish-task')).toHaveLength(1);
    transport.emitMessage(serverEvent('task-finished', { usage: { duration: 2 } }));
    await Promise.all([first, second]);
    expect(transport.closeCount).toBe(1);
    expect(transport.listenerCount).toBe(0);
    expect(guard.activeSessionCount).toBe(0);
  });

  it('cancels without finish-task and ignores delayed finals', async () => {
    const { provider, transport } = setup();
    const transcripts: SttTranscriptResult[] = [];
    provider.onTranscript((result) => transcripts.push(result));
    await start(provider, transport);
    await Promise.all([provider.cancelSession(SESSION_ID), provider.cancelSession(SESSION_ID)]);
    transport.emitMessage(resultEvent(1, true, '遅延結果'));
    expect(transport.controls.filter((value) => controlAction(value) === 'finish-task')).toHaveLength(0);
    expect(transcripts).toHaveLength(0);
    expect(transport.closeCount).toBe(1);
  });

  it('handles stop and cancel racing without double cleanup', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    const transcripts: SttTranscriptResult[] = [];
    provider.onTranscript((result) => transcripts.push(result));
    await start(provider, transport);
    const stopping = provider.stopSession(SESSION_ID);
    await waitForControls(transport, 2);
    const cancelling = provider.cancelSession(SESSION_ID);
    await Promise.all([stopping, cancelling]);
    transport.emitMessage(resultEvent(1, true, 'late'));
    expect(transcripts).toHaveLength(0);
    expect(transport.closeCount).toBe(1);
    expect(guard.activeSessionCount).toBe(0);
  });

  it('handles stop and dispose racing without double cleanup', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    await start(provider, transport);
    const stopping = provider.stopSession(SESSION_ID);
    await waitForControls(transport, 2);
    await Promise.all([stopping, provider.dispose()]);
    expect(transport.closeCount).toBe(1);
    expect(transport.listenerCount).toBe(0);
    expect(guard.activeSessionCount).toBe(0);
  });

  it('does not retry audio after an uncertain send failure and keeps its usage reservation', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    await start(provider, transport);
    transport.failAudio = true;
    await expect(provider.sendAudio(audioChunk(0, new Uint8Array([1, 2])))).rejects.toMatchObject({ code: 'fun_asr_transport_closed' });
    expect(transport.audioChunks).toHaveLength(1);
    expect(guard.getDailyFrames()).toBe(1);
    await provider.cancelSession(SESSION_ID);
  });

  it('reports an unexpected close without reconnecting', async () => {
    const { provider, transport } = setup();
    const errors: ServerProviderError[] = [];
    provider.onError((error) => errors.push(error));
    await start(provider, transport);
    transport.emitClose();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('fun_asr_transport_closed');
    expect(transport.connectCount).toBe(1);
    await provider.dispose();
  });

  it('handles repeated transport close and error callbacks only once', async () => {
    const { provider, transport } = setup();
    const errors: ServerProviderError[] = [];
    provider.onError((error) => errors.push(error));
    await start(provider, transport);
    transport.emitClose();
    transport.emitClose();
    transport.emitError();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect(transport.closeCount).toBe(1);
    expect(transport.connectCount).toBe(1);
  });

  it('rejects stop safely when task-failed arrives while stopping', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    await start(provider, transport);
    const stopping = provider.stopSession(SESSION_ID);
    await waitForControls(transport, 2);
    transport.emitMessage({
      header: { event: 'task-failed', task_id: TASK_ID, error_code: 'External', error_message: 'private' },
      payload: {},
    });
    await expect(stopping).rejects.toMatchObject({ code: 'fun_asr_task_failed' });
    expect(transport.closeCount).toBe(1);
    expect(guard.activeSessionCount).toBe(0);
  });

  it('lets stop clean up idempotently after an earlier task failure', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    await start(provider, transport);
    transport.emitMessage({ header: { event: 'task-failed', task_id: TASK_ID }, payload: {} });
    await provider.stopSession(SESSION_ID);
    expect(transport.closeCount).toBe(1);
    expect(guard.activeSessionCount).toBe(0);
  });

  it('times out start and finish waits and closes resources', async () => {
    vi.useFakeTimers();
    const startSetup = setup({ startTimeoutMs: 10 });
    startSetup.transport.hangConnect = true;
    const starting = startSetup.provider.startSession(sessionConfig());
    const startRejection = expect(starting).rejects.toMatchObject({ code: 'fun_asr_start_timeout' });
    await vi.advanceTimersByTimeAsync(11);
    await startRejection;
    expect(startSetup.transport.closeCount).toBe(1);
    expect(startSetup.guard.activeSessionCount).toBe(0);
    expect(startSetup.transport.listenerCount).toBe(0);
    startSetup.transport.emitMessage(serverEvent('task-started'));

    const finishSetup = setup({ finishTimeoutMs: 10 });
    const active = finishSetup.provider.startSession(sessionConfig());
    await vi.advanceTimersByTimeAsync(0);
    finishSetup.transport.emitMessage(serverEvent('task-started'));
    await active;
    finishSetup.transport.hangFinishControl = true;
    const stopping = finishSetup.provider.stopSession(SESSION_ID);
    const finishRejection = expect(stopping).rejects.toMatchObject({ code: 'fun_asr_finish_timeout' });
    await vi.advanceTimersByTimeAsync(11);
    await finishRejection;
    expect(finishSetup.transport.closeCount).toBe(1);
  });

  it('times out an uncertain audio send without retrying it', async () => {
    vi.useFakeTimers();
    const guard = usageGuard();
    const { provider, transport } = setup({ guard, sendTimeoutMs: 10 });
    const active = provider.startSession(sessionConfig());
    await vi.advanceTimersByTimeAsync(0);
    transport.emitMessage(serverEvent('task-started'));
    await active;
    transport.hangAudio = true;
    const sending = provider.sendAudio(audioChunk(0, new Uint8Array([1, 2])));
    const rejection = expect(sending).rejects.toMatchObject({ code: 'fun_asr_transport_closed' });
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    expect(transport.audioChunks).toHaveLength(1);
    expect(transport.closeCount).toBe(1);
    expect(guard.getDailyFrames()).toBe(1);
    expect(guard.activeSessionCount).toBe(0);
  });

  it('cancels a pending audio send and clears its timeout', async () => {
    vi.useFakeTimers();
    const guard = usageGuard();
    const { provider, transport } = setup({ guard, sendTimeoutMs: 10_000 });
    const active = provider.startSession(sessionConfig());
    await vi.advanceTimersByTimeAsync(0);
    transport.emitMessage(serverEvent('task-started'));
    await active;
    transport.hangAudio = true;
    const sending = provider.sendAudio(audioChunk(0, new Uint8Array([1, 2])));
    const rejection = expect(sending).rejects.toMatchObject({ code: 'fun_asr_transport_closed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.audioChunks).toHaveLength(1);
    await provider.cancelSession(SESSION_ID);
    await rejection;
    expect(transport.closeCount).toBe(1);
    expect(guard.activeSessionCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes buffered finals in numeric order and reports a gap at task-finished', async () => {
    const { provider, transport } = setup();
    const finals: number[] = [];
    const errors: ServerProviderError[] = [];
    provider.onTranscript((result) => {
      if (result.isFinal) finals.push(Number(result.segmentId.split(':').at(-1)));
    });
    provider.onError((error) => errors.push(error));
    await start(provider, transport);
    transport.emitMessage(resultEvent(3, true, 'third'));
    transport.emitMessage(resultEvent(2, true, 'second'));
    const stopping = provider.stopSession(SESSION_ID);
    await waitForControls(transport, 2);
    transport.emitMessage(serverEvent('task-finished'));
    await stopping;
    expect(finals).toEqual([2, 3]);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'fun_asr_final_sequence_gap' }));
  });

  it('fails safely when the out-of-order final buffer reaches its bound', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    const errors: ServerProviderError[] = [];
    provider.onError((error) => errors.push(error));
    await start(provider, transport);
    for (let sentenceId = 2; sentenceId <= 258; sentenceId += 1) {
      transport.emitMessage(resultEvent(sentenceId, true, `item-${sentenceId}`));
    }
    for (let attempt = 0; attempt < 20 && guard.activeSessionCount > 0; attempt += 1) await Promise.resolve();
    expect(errors).toContainEqual(expect.objectContaining({ code: 'fun_asr_final_buffer_limit' }));
    expect(transport.closeCount).toBe(1);
    expect(guard.activeSessionCount).toBe(0);
  });

  it('dispose releases listeners, transport, guard, and pending transcript state', async () => {
    const guard = usageGuard();
    const { provider, transport } = setup({ guard });
    await start(provider, transport);
    transport.emitMessage(resultEvent(2, true, '保留'));
    await provider.dispose();
    expect(transport.listenerCount).toBe(0);
    expect(transport.closeCount).toBe(1);
    expect(guard.activeSessionCount).toBe(0);
  });
});

function setup(options: {
  guard?: FunAsrUsageGuard;
  startTimeoutMs?: number;
  sendTimeoutMs?: number;
  finishTimeoutMs?: number;
} = {}): { provider: FunAsrProvider; transport: FakeFunAsrTransport; guard: FunAsrUsageGuard } {
  const transport = new FakeFunAsrTransport();
  const guard = options.guard ?? usageGuard();
  const provider = new FunAsrProvider({
    externalEnabled: true,
    transportFactory: () => transport,
    usageGuard: guard,
    randomUUID: () => TASK_ID,
    now: () => 1_700_000_000_000,
    startTimeoutMs: options.startTimeoutMs ?? 1_000,
    sendTimeoutMs: options.sendTimeoutMs ?? 1_000,
    finishTimeoutMs: options.finishTimeoutMs ?? 1_000,
  });
  return { provider, transport, guard };
}

function usageGuard(): FunAsrUsageGuard {
  return new FunAsrUsageGuard({
    maxAudioSecondsPerSession: 60,
    maxAudioSecondsPerDay: 600,
    maxAudioSecondsPerMonth: 6_000,
    maxConcurrentSessions: 2,
  }, () => Date.parse('2026-07-19T00:00:00Z'));
}

function sessionConfig() {
  return { sessionId: SESSION_ID, language: 'ja' as const, mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le', sampleRate: 16_000 };
}

function audioChunk(sequence: number, audio: Uint8Array, frameCount = audio.byteLength / 2) {
  return {
    sessionId: SESSION_ID, sequence, audio,
    metadata: { capturedAt: 1, sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le' as const, frameCount },
  };
}

async function start(provider: FunAsrProvider, transport: FakeFunAsrTransport): Promise<void> {
  const pending = provider.startSession(sessionConfig());
  await waitForControl(transport);
  transport.emitMessage(serverEvent('task-started'));
  await pending;
}

async function waitForControl(transport: FakeFunAsrTransport): Promise<void> {
  return waitForControls(transport, 1);
}

async function waitForControls(transport: FakeFunAsrTransport, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && transport.controls.length < count; attempt += 1) await Promise.resolve();
  expect(transport.controls.length).toBeGreaterThanOrEqual(count);
}

function controlAction(value: unknown): unknown {
  return (value as { header?: { action?: unknown } }).header?.action;
}

function serverEvent(event: 'task-started' | 'task-finished', extra: Record<string, unknown> = {}): unknown {
  return { header: { event, task_id: TASK_ID }, payload: extra };
}

function resultEvent(
  sentenceId: number,
  sentenceEnd: boolean,
  text: string,
  options: { heartbeat?: boolean; usage?: number } = {},
): unknown {
  return {
    header: { event: 'result-generated', task_id: TASK_ID },
    payload: {
      output: { sentence: {
        sentence_id: sentenceId, sentence_end: sentenceEnd, text,
        heartbeat: options.heartbeat ?? false, begin_time: sentenceId * 1_000, end_time: sentenceId * 1_000 + 500,
        words: [{ begin_time: sentenceId * 1_000, end_time: sentenceId * 1_000 + 400, text, punctuation: '' }],
      } },
      ...(options.usage === undefined ? { usage: null } : { usage: { duration: options.usage } }),
    },
  };
}
