// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '../src/config';
import { LocalWhisperServerProvider } from '../src/providers/local/localWhisperServerProvider';
import { MockServerSpeechToTextProvider } from '../src/providers/mockProvider';
import { createServerSpeechToTextProviderRuntime } from '../src/providers/providerFactory';
import { FakeFunAsrTransport } from './support/fakeFunAsrTransport';
import { FakeFunAsrWebSocketFactory } from './support/fakeFunAsrWebSocket';

const TEST_API_KEY = 'test-key-not-real';
const TEST_WORKSPACE_ID = 'workspace-test';

describe('server STT provider factory', () => {
  it('uses Local Whisper for the default provider through the common boundary', async () => {
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({}));
    try {
      const provider = runtime.create();
      expect(provider).toBeInstanceOf(LocalWhisperServerProvider);
      expect(provider.id).toBe('local-whisper');
      await provider.dispose();
    } finally {
      await runtime.close();
    }
  });

  it('keeps mock explicit and allows the browser to request Local Whisper', async () => {
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({ STT_PROVIDER: 'mock' }));
    try {
      expect(runtime.create()).toBeInstanceOf(MockServerSpeechToTextProvider);
      expect(runtime.create('local-whisper')).toBeInstanceOf(LocalWhisperServerProvider);
    } finally {
      await runtime.close();
    }
  });

  it('normalizes surrounding Workspace ID whitespace only at the server config boundary', () => {
    expect(loadServerConfig({ STT_WORKSPACE_ID: `  ${TEST_WORKSPACE_ID}  ` }).workspaceId)
      .toBe(TEST_WORKSPACE_ID);
  });

  it('creates the offline Fun-ASR provider only through an injected transport boundary', async () => {
    const transport = new FakeFunAsrTransport();
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({
      STT_PROVIDER: 'fun-asr',
      STT_EXTERNAL_ENABLED: 'true',
      STT_MAX_AUDIO_SECONDS_PER_SESSION: '60',
      STT_MAX_AUDIO_SECONDS_PER_DAY: '600',
      STT_MAX_AUDIO_SECONDS_PER_MONTH: '6000',
      STT_MAX_CONCURRENT_EXTERNAL_SESSIONS: '1',
    }), { createFunAsrTransport: () => transport });
    try {
      expect(runtime.create().id).toBe('fun-asr');
      expect(transport.connectCount).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it('does not create a transport when external STT is disabled', async () => {
    let transportCreated = false;
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({
      STT_PROVIDER: 'fun-asr',
      STT_EXTERNAL_ENABLED: 'false',
      STT_MAX_AUDIO_SECONDS_PER_SESSION: '60',
      STT_MAX_AUDIO_SECONDS_PER_DAY: '600',
      STT_MAX_AUDIO_SECONDS_PER_MONTH: '6000',
      STT_MAX_CONCURRENT_EXTERNAL_SESSIONS: '1',
    }), { createFunAsrTransport: () => {
      transportCreated = true;
      return new FakeFunAsrTransport();
    } });
    const provider = runtime.create();
    await expect(provider.startSession({
      sessionId: 'disabled', language: 'ja',
      mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le', sampleRate: 16_000,
    })).rejects.toMatchObject({ code: 'external_stt_disabled' });
    expect(transportCreated).toBe(false);
    await runtime.close();
  });

  it('fails safely without a server API key before opening a network connection', async () => {
    const websocketFactory = new FakeFunAsrWebSocketFactory();
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({
      STT_PROVIDER: 'fun-asr',
      STT_EXTERNAL_ENABLED: 'true',
      STT_REGION: 'singapore',
      STT_MODEL: 'fun-asr-realtime',
      STT_WORKSPACE_ID: TEST_WORKSPACE_ID,
      STT_MAX_AUDIO_SECONDS_PER_SESSION: '60',
      STT_MAX_AUDIO_SECONDS_PER_DAY: '600',
      STT_MAX_AUDIO_SECONDS_PER_MONTH: '6000',
      STT_MAX_CONCURRENT_EXTERNAL_SESSIONS: '1',
    }), { createFunAsrWebSocket: websocketFactory.create });
    const provider = runtime.create();
    await expect(provider.startSession({
      sessionId: 'offline-only', language: 'ja',
      mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le', sampleRate: 16_000,
    })).rejects.toMatchObject({ code: 'fun_asr_api_key_missing' });
    expect(websocketFactory.calls).toHaveLength(0);
    await runtime.close();
  });

  it.each(['test key invalid', 'test\nkey-invalid', 'x'.repeat(4_097)])(
    'rejects an invalid server API key before constructing WebSocket',
    async (apiKey) => {
      const websocketFactory = new FakeFunAsrWebSocketFactory();
      const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({
        ...liveFunAsrEnv(), STT_API_KEY: apiKey,
      }), { createFunAsrWebSocket: websocketFactory.create });
      const provider = runtime.create();
      await expect(provider.startSession(funAsrSessionConfig('invalid-key'))).rejects.toMatchObject({
        code: 'fun_asr_api_key_missing',
      });
      expect(websocketFactory.calls).toHaveLength(0);
      await runtime.close();
    },
  );

  it.each([
    [{ STT_REGION: undefined }, 'fun_asr_region_unsupported'],
    [{ STT_REGION: 'cn-beijing' }, 'fun_asr_region_unsupported'],
    [{ STT_MODEL: undefined }, 'fun_asr_model_unsupported'],
    [{ STT_MODEL: 'unknown-model' }, 'fun_asr_model_unsupported'],
    [{ STT_WORKSPACE_ID: undefined }, 'fun_asr_workspace_missing'],
    [{ STT_WORKSPACE_ID: 'workspace.test' }, 'fun_asr_workspace_invalid'],
    [{ STT_WORKSPACE_ID: 'workspace/test' }, 'fun_asr_workspace_invalid'],
    [{ STT_WORKSPACE_ID: 'workspace@test' }, 'fun_asr_workspace_invalid'],
    [{ STT_WORKSPACE_ID: 'workspace\ntest' }, 'fun_asr_workspace_invalid'],
    [{ STT_WORKSPACE_ID: 'x'.repeat(64) }, 'fun_asr_workspace_invalid'],
    [{ STT_ENDPOINT: 'wss://example.invalid/api-ws/v1/inference' }, 'fun_asr_transport_configuration_invalid'],
  ])('rejects invalid live configuration before constructing WebSocket: %s', async (overrides, code) => {
    const websocketFactory = new FakeFunAsrWebSocketFactory();
    const env = liveFunAsrEnv();
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig(env), {
      createFunAsrWebSocket: websocketFactory.create,
    });
    const provider = runtime.create();
    await expect(provider.startSession(funAsrSessionConfig('invalid-live-config'))).rejects.toMatchObject({ code });
    expect(websocketFactory.calls).toHaveLength(0);
    await runtime.close();
  });

  it('constructs and connects the live transport only when startSession is called', async () => {
    const websocketFactory = new FakeFunAsrWebSocketFactory();
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig(liveFunAsrEnv()), {
      createFunAsrWebSocket: websocketFactory.create,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    });
    const provider = runtime.create();
    expect(websocketFactory.calls).toHaveLength(0);
    const starting = provider.startSession(funAsrSessionConfig('live-factory'));
    expect(websocketFactory.calls).toHaveLength(1);
    websocketFactory.latest.emitOpen();
    await waitFor(() => websocketFactory.latest.sentFrames.length === 1);
    websocketFactory.latest.emitMessage(Buffer.from(JSON.stringify({
      header: { event: 'task-started', task_id: '11111111-1111-4111-8111-111111111111' },
      payload: {},
    })));
    await expect(starting).resolves.toBeUndefined();
    await provider.cancelSession?.('live-factory');
    expect(websocketFactory.calls).toHaveLength(1);
    await runtime.close();
  });

  it('never exposes configured server credentials through a safe startup error or console', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({
      ...liveFunAsrEnv(), STT_REGION: 'unsupported-region',
    }));
    const provider = runtime.create();
    let thrown: unknown;
    try {
      await provider.startSession(funAsrSessionConfig('secret-safe-error'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'fun_asr_region_unsupported' });
    expect(String(thrown)).not.toContain(TEST_API_KEY);
    expect(String(thrown)).not.toContain(TEST_WORKSPACE_ID);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TEST_WORKSPACE_ID);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TEST_WORKSPACE_ID);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    await runtime.close();
  });

  it('requires every audio usage limit before creating a transport', async () => {
    let transportCreated = false;
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({
      STT_PROVIDER: 'fun-asr', STT_EXTERNAL_ENABLED: 'true',
    }), { createFunAsrTransport: () => {
      transportCreated = true;
      return new FakeFunAsrTransport();
    } });
    const provider = runtime.create();
    await expect(provider.startSession({
      sessionId: 'limits-required', language: 'ja',
      mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le', sampleRate: 16_000,
    })).rejects.toMatchObject({ code: 'fun_asr_usage_limits_required' });
    expect(transportCreated).toBe(false);
    await runtime.close();
  });

  it('shares the external concurrency guard across providers from one runtime', async () => {
    const transport = new FakeFunAsrTransport();
    let transportCreateCount = 0;
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({
      STT_PROVIDER: 'fun-asr',
      STT_EXTERNAL_ENABLED: 'true',
      STT_MAX_AUDIO_SECONDS_PER_SESSION: '60',
      STT_MAX_AUDIO_SECONDS_PER_DAY: '600',
      STT_MAX_AUDIO_SECONDS_PER_MONTH: '6000',
      STT_MAX_CONCURRENT_EXTERNAL_SESSIONS: '1',
    }), {
      createFunAsrTransport: () => {
        transportCreateCount += 1;
        return transport;
      },
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    });
    const first = runtime.create();
    const second = runtime.create();
    try {
      const starting = first.startSession(funAsrSessionConfig('first'));
      for (let attempt = 0; attempt < 20 && transport.controls.length === 0; attempt += 1) await Promise.resolve();
      transport.emitMessage({
        header: { event: 'task-started', task_id: '11111111-1111-4111-8111-111111111111' },
        payload: {},
      });
      await starting;
      await expect(second.startSession(funAsrSessionConfig('second'))).rejects.toMatchObject({
        code: 'fun_asr_usage_limit_exceeded',
      });
      expect(transportCreateCount).toBe(1);
      await first.cancelSession('first');
    } finally {
      await Promise.allSettled([first.dispose(), second.dispose()]);
      await runtime.close();
    }
  });
});

function funAsrSessionConfig(sessionId: string) {
  return {
    sessionId,
    language: 'ja' as const,
    mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le',
    sampleRate: 16_000,
  };
}

function liveFunAsrEnv(): NodeJS.ProcessEnv {
  return {
    STT_PROVIDER: 'fun-asr',
    STT_EXTERNAL_ENABLED: 'true',
    STT_API_KEY: TEST_API_KEY,
    STT_WORKSPACE_ID: TEST_WORKSPACE_ID,
    STT_REGION: 'singapore',
    STT_MODEL: 'fun-asr-realtime',
    STT_MAX_AUDIO_SECONDS_PER_SESSION: '60',
    STT_MAX_AUDIO_SECONDS_PER_DAY: '600',
    STT_MAX_AUDIO_SECONDS_PER_MONTH: '6000',
    STT_MAX_CONCURRENT_EXTERNAL_SESSIONS: '1',
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached');
}
