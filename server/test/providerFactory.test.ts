// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';
import { LocalWhisperServerProvider } from '../src/providers/local/localWhisperServerProvider';
import { MockServerSpeechToTextProvider } from '../src/providers/mockProvider';
import { createServerSpeechToTextProviderRuntime } from '../src/providers/providerFactory';

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
});
