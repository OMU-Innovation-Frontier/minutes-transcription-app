// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertFunAsrApiKey,
  assertFunAsrSingaporeEndpoint,
  assertFunAsrWorkspaceId,
  resolveFunAsrSingaporeEndpoint,
} from '../src/providers/funAsr/funAsrEndpoint';
import { FunAsrWebSocketTransport } from '../src/providers/funAsr/funAsrWebSocketTransport';
import {
  FakeFunAsrWebSocketFactory,
} from './support/fakeFunAsrWebSocket';

const TEST_API_KEY = 'test-key-not-real';
const TEST_WORKSPACE_ID = 'workspace-test';
const TEST_ENDPOINT =
  'wss://workspace-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference';

afterEach(() => {
  vi.useRealTimers();
});

describe('Fun-ASR Singapore endpoint policy', () => {
  it('builds only the workspace-dedicated Singapore URL with the fixed path and no query', () => {
    const endpoint = resolveFunAsrSingaporeEndpoint('singapore', TEST_WORKSPACE_ID, undefined);
    expect(endpoint).toBe(TEST_ENDPOINT);
    const parsed = new URL(endpoint);
    expect(parsed.pathname).toBe('/api-ws/v1/inference');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
    expect(endpoint).not.toContain(TEST_API_KEY);
    expect(() => resolveFunAsrSingaporeEndpoint('cn-beijing', TEST_WORKSPACE_ID, undefined)).toThrowError(
      expect.objectContaining({ code: 'fun_asr_region_unsupported' }),
    );
    expect(() => resolveFunAsrSingaporeEndpoint(
      'singapore', TEST_WORKSPACE_ID, 'wss://example.invalid/api-ws/v1/inference',
    ))
      .toThrowError(expect.objectContaining({ code: 'fun_asr_transport_configuration_invalid' }));
  });

  it('rejects missing and hostname-escaping workspace IDs', () => {
    for (const workspaceId of [undefined, '']) {
      expect(() => assertFunAsrWorkspaceId(workspaceId)).toThrowError(
        expect.objectContaining({ code: 'fun_asr_workspace_missing' }),
      );
    }
    for (const workspaceId of [
      'workspace.test', 'workspace/test', 'workspace\\test', 'workspace@test',
      'workspace:test', 'workspace?test', 'workspace#test', 'workspace\ntest',
      `workspace${String.fromCharCode(0x80)}test`,
      ' workspace-test', 'workspace-test ', 'x'.repeat(64),
    ]) {
      expect(() => assertFunAsrWorkspaceId(workspaceId)).toThrowError(
        expect.objectContaining({ code: 'fun_asr_workspace_invalid' }),
      );
    }
    expect(() => assertFunAsrWorkspaceId(TEST_WORKSPACE_ID)).not.toThrow();
  });

  it('rejects legacy, China, arbitrary, non-WSS, credential-bearing, query, and fragment URLs', () => {
    const rejected = [
      'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference',
      'ws://workspace-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference',
      'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
      'wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference',
      'wss://example.invalid/api-ws/v1/inference',
      'wss://user:password@workspace-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference',
      'wss://workspace-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference?key=value',
      'wss://workspace-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference#fragment',
      'not-a-url',
    ];
    for (const endpoint of rejected) {
      expect(() => assertFunAsrSingaporeEndpoint(endpoint, TEST_WORKSPACE_ID)).toThrowError(
        expect.objectContaining({ code: 'fun_asr_transport_configuration_invalid' }),
      );
    }
  });

  it('rejects missing, whitespace-bearing, and excessively long credentials safely', () => {
    for (const apiKey of [undefined, '', 'test key invalid', 'test\nkey-invalid', 'x'.repeat(4_097)]) {
      expect(() => assertFunAsrApiKey(apiKey)).toThrowError(
        expect.objectContaining({ code: 'fun_asr_api_key_missing' }),
      );
    }
    expect(() => assertFunAsrApiKey('short')).not.toThrow();
  });
});

describe('FunAsrWebSocketTransport', () => {
  it('does not construct a WebSocket before connect and constructs it exactly once', async () => {
    const { transport, factory } = createTransport();
    expect(factory.calls).toHaveLength(0);
    const first = transport.connect();
    const second = transport.connect();
    expect(factory.calls).toHaveLength(1);
    expect(second).toBe(first);
    factory.latest.emitOpen();
    await expect(first).resolves.toBeUndefined();
    await expect(transport.connect()).resolves.toBeUndefined();
    expect(factory.calls).toHaveLength(1);
  });

  it('uses server-only header authentication and hardened ws options', async () => {
    const { transport, factory } = createTransport();
    const connecting = transport.connect();
    const call = factory.calls[0];
    expect(call?.url).toBe(TEST_ENDPOINT);
    expect(call?.url).not.toContain(TEST_API_KEY);
    expect(call?.options).toMatchObject({
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      handshakeTimeout: 2_000,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 1_048_576,
      rejectUnauthorized: true,
    });
    expect(call?.options.agent).toBeUndefined();
    factory.latest.emitOpen();
    await connecting;
  });

  it('waits for open and rejects constructor, error, unexpected response, and handshake timeout safely', async () => {
    const constructorFailure = createTransport();
    constructorFailure.factory.throwOnCreate = true;
    await expect(constructorFailure.transport.connect()).rejects.toMatchObject({
      code: 'fun_asr_transport_connect_failed',
    });

    const errorFailure = createTransport();
    const errored = errorFailure.transport.connect();
    errorFailure.factory.latest.emitError();
    await expect(errored).rejects.toMatchObject({ code: 'fun_asr_transport_connect_failed' });
    await errorFailure.transport.close();

    const responseFailure = createTransport();
    const unexpected = responseFailure.transport.connect();
    responseFailure.factory.latest.emitUnexpectedResponse();
    await expect(unexpected).rejects.toMatchObject({ code: 'fun_asr_transport_connect_failed' });
    await responseFailure.transport.close();

    vi.useFakeTimers();
    const timeoutFailure = createTransport({ handshakeTimeoutMs: 1_000, closeTimeoutMs: 100 });
    const timedOut = timeoutFailure.transport.connect();
    timeoutFailure.factory.latest.autoClose = false;
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({
      code: 'fun_asr_transport_connect_failed',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await timeoutAssertion;
    await vi.advanceTimersByTimeAsync(100);
    expect(timeoutFailure.factory.latest.terminateCount).toBe(1);
  });

  it('sends control as bounded text JSON without credentials', async () => {
    const { transport, factory } = await createConnectedTransport();
    await transport.sendControl({ header: { action: 'finish-task' }, payload: { input: {} } });
    const frame = factory.latest.sentFrames[0];
    expect(frame).toMatchObject({ binary: false, compress: false });
    expect(typeof frame?.data).toBe('string');
    expect(String(frame?.data)).not.toContain(TEST_API_KEY);
    await expect(transport.sendControl(undefined)).rejects.toMatchObject({
      code: 'fun_asr_transport_invalid_message',
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(transport.sendControl(cyclic)).rejects.toMatchObject({
      code: 'fun_asr_transport_invalid_message',
    });
    await expect(transport.sendControl({ Authorization: TEST_API_KEY })).rejects.toMatchObject({
      code: 'fun_asr_transport_invalid_message',
    });
    await expect(transport.sendControl({ workspace: TEST_WORKSPACE_ID })).rejects.toMatchObject({
      code: 'fun_asr_transport_invalid_message',
    });
    await expect(transport.sendControl({ token: `prefix-${TEST_API_KEY}` })).rejects.toMatchObject({
      code: 'fun_asr_transport_invalid_message',
    });
    await expect(transport.sendControl({ endpoint: `wss://${TEST_WORKSPACE_ID}.example.invalid` }))
      .rejects.toMatchObject({ code: 'fun_asr_transport_invalid_message' });
    await expect(transport.sendControl({ [`field-${TEST_WORKSPACE_ID}`]: true }))
      .rejects.toMatchObject({ code: 'fun_asr_transport_invalid_message' });
  });

  it('sends copied PCM bytes as binary without Base64 conversion or automatic resend', async () => {
    const { transport, factory } = await createConnectedTransport();
    const audio = new Uint8Array([1, 2, 3, 4]);
    await transport.sendAudio(audio);
    audio.fill(9);
    expect(factory.latest.sentFrames).toEqual([{
      data: new Uint8Array([1, 2, 3, 4]), binary: true, compress: false,
    }]);
    await transport.sendAudio(new Uint8Array());
    expect(factory.latest.sentFrames).toHaveLength(1);
    await expect(transport.sendAudio(new Uint8Array([1]))).rejects.toMatchObject({
      code: 'fun_asr_transport_invalid_message',
    });
    factory.latest.sendError = true;
    await expect(transport.sendAudio(new Uint8Array([5, 6]))).rejects.toMatchObject({
      code: 'fun_asr_transport_send_failed',
    });
    expect(factory.latest.sentFrames).toHaveLength(2);
  });

  it('rejects send backpressure, oversized messages, closed sends, and synchronous send failures', async () => {
    const connected = await createConnectedTransport({ maxBufferedBytes: 1_000_000 });
    connected.factory.latest.bufferedAmount = 999_999;
    await expect(connected.transport.sendAudio(new Uint8Array([1, 2]))).rejects.toMatchObject({
      code: 'fun_asr_transport_backpressure',
    });
    connected.factory.latest.bufferedAmount = 0;
    await expect(connected.transport.sendAudio(new Uint8Array(1_000_002))).rejects.toMatchObject({
      code: 'fun_asr_transport_message_too_large',
    });
    connected.factory.latest.sendThrows = true;
    await expect(connected.transport.sendAudio(new Uint8Array([1, 2]))).rejects.toMatchObject({
      code: 'fun_asr_transport_send_failed',
    });
    connected.factory.latest.emitClose();
    await expect(connected.transport.sendAudio(new Uint8Array([1, 2]))).rejects.toMatchObject({
      code: 'fun_asr_transport_closed',
    });
  });

  it('parses bounded text JSON as unknown and rejects invalid, oversized, and binary server frames', async () => {
    const valid = await createConnectedTransport();
    const messages: unknown[] = [];
    valid.transport.onMessage((message) => messages.push(message));
    valid.factory.latest.emitMessage(Buffer.from('{"header":{"event":"task-started"}}'));
    expect(messages).toEqual([{ header: { event: 'task-started' } }]);

    for (const emitInvalid of [
      (factory: FakeFunAsrWebSocketFactory) => factory.latest.emitMessage(Buffer.from('{invalid')),
      (factory: FakeFunAsrWebSocketFactory) => factory.latest.emitMessage(Buffer.alloc(1_048_577)),
      (factory: FakeFunAsrWebSocketFactory) => factory.latest.emitMessage(Buffer.from('{}'), true),
    ]) {
      const invalid = await createConnectedTransport();
      const errors: unknown[] = [];
      invalid.transport.onError((error) => errors.push(error));
      emitInvalid(invalid.factory);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: expect.stringMatching(/^fun_asr_transport_(invalid_message|message_too_large|protocol_failed)$/),
      });
    }
  });

  it('notifies an error and close at most once without reconnecting', async () => {
    const { transport, factory } = await createConnectedTransport();
    const errors: unknown[] = [];
    let closes = 0;
    transport.onError((error) => errors.push(error));
    transport.onClose(() => { closes += 1; });
    factory.latest.emitError();
    factory.latest.emitError();
    factory.latest.emitClose();
    factory.latest.emitClose();
    expect(errors).toHaveLength(1);
    expect(closes).toBe(1);
    expect(factory.calls).toHaveLength(1);
  });

  it('closes idempotently, removes listeners, and terminates only after close timeout', async () => {
    vi.useFakeTimers();
    const { transport, factory } = await createConnectedTransport({ closeTimeoutMs: 100 });
    factory.latest.autoClose = false;
    const first = transport.close();
    const second = transport.close();
    expect(second).toBe(first);
    expect(factory.latest.closeCalls).toHaveLength(1);
    expect(factory.latest.terminateCount).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBeUndefined();
    expect(factory.latest.terminateCount).toBe(1);
    expect(factory.latest.listenerCount('open')).toBe(0);
    expect(factory.latest.listenerCount('message')).toBe(0);
    expect(factory.latest.listenerCount('error')).toBe(1);
    expect(factory.latest.listenerCount('close')).toBe(0);
    expect(() => factory.latest.emitError()).not.toThrow();
    await expect(transport.connect()).rejects.toMatchObject({ code: 'fun_asr_transport_connect_failed' });
  });

  it('clears close state immediately when the socket acknowledges a normal close', async () => {
    vi.useFakeTimers();
    const { transport, factory } = await createConnectedTransport({ closeTimeoutMs: 100 });
    await expect(transport.close()).resolves.toBeUndefined();
    expect(factory.latest.terminateCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createTransport(overrides: Partial<ConstructorParameters<typeof FunAsrWebSocketTransport>[0]> = {}) {
  const factory = new FakeFunAsrWebSocketFactory();
  const transport = new FunAsrWebSocketTransport({
    endpoint: TEST_ENDPOINT,
    workspaceId: TEST_WORKSPACE_ID,
    apiKey: TEST_API_KEY,
    handshakeTimeoutMs: 2_000,
    closeTimeoutMs: 100,
    createWebSocket: factory.create,
    ...overrides,
  });
  return { transport, factory };
}

async function createConnectedTransport(
  overrides: Partial<ConstructorParameters<typeof FunAsrWebSocketTransport>[0]> = {},
) {
  const created = createTransport(overrides);
  const connecting = created.transport.connect();
  created.factory.latest.emitOpen();
  await connecting;
  return created;
}
