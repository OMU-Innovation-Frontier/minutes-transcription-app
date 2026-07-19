// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';
import { LocalWhisperServerProvider } from '../src/providers/local/localWhisperServerProvider';
import { MockServerSpeechToTextProvider } from '../src/providers/mockProvider';
import { createServerSpeechToTextProviderRuntime } from '../src/providers/providerFactory';
import { FakeFunAsrTransport } from './support/fakeFunAsrTransport';

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

  it('fails safely without a live transport instead of opening a network connection', async () => {
    const runtime = createServerSpeechToTextProviderRuntime(loadServerConfig({
      STT_PROVIDER: 'fun-asr',
      STT_EXTERNAL_ENABLED: 'true',
      STT_MAX_AUDIO_SECONDS_PER_SESSION: '60',
      STT_MAX_AUDIO_SECONDS_PER_DAY: '600',
      STT_MAX_AUDIO_SECONDS_PER_MONTH: '6000',
      STT_MAX_CONCURRENT_EXTERNAL_SESSIONS: '1',
    }));
    const provider = runtime.create();
    await expect(provider.startSession({
      sessionId: 'offline-only', language: 'ja',
      mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le', sampleRate: 16_000,
    })).rejects.toMatchObject({ code: 'fun_asr_live_transport_unavailable' });
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
