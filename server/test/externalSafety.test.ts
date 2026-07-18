// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config';
import {
  assertEstimatedCostWithinBudget,
  assertExternalSttMayStart,
  SttAudioDurationLimiter,
} from '../src/providers/externalAccessPolicy';
import { prepareHotwords } from '../src/providers/hotwords';

describe('external STT safety policy', () => {
  it('keeps external API access disabled by default', () => {
    const config = loadServerConfig({});
    expect(config.provider).toBe('mock');
    expect(config.externalEnabled).toBe(false);
    expect(config.localSttEnabled).toBe(false);
    expect(() => assertExternalSttMayStart(config)).toThrowError(
      expect.objectContaining({ code: 'external_stt_disabled' }),
    );
  });

  it('fails safely when explicitly enabled without an API key', () => {
    expect(() => assertExternalSttMayStart({ externalEnabled: true })).toThrowError(
      expect.objectContaining({ code: 'api_key_missing' }),
    );
  });

  it('accepts the current pre-speech setting and keeps the legacy name as a fallback', () => {
    expect(loadServerConfig({}).localSttPreSpeechBufferMs).toBe(300);
    expect(loadServerConfig({ LOCAL_STT_PRE_SPEECH_MS: '500' }).localSttPreSpeechBufferMs).toBe(500);
    expect(loadServerConfig({ LOCAL_STT_PRE_SPEECH_BUFFER_MS: '450' }).localSttPreSpeechBufferMs).toBe(450);
    expect(loadServerConfig({
      LOCAL_STT_PRE_SPEECH_MS: '500', LOCAL_STT_PRE_SPEECH_BUFFER_MS: '450',
    }).localSttPreSpeechBufferMs).toBe(500);
  });

  it('uses 1300 ms silence and keeps debug audio disabled unless explicitly enabled', () => {
    const defaults = loadServerConfig({});
    expect(defaults.localSttSilenceMs).toBe(1_300);
    expect(defaults.localSttDebugAudio).toBe(false);
    expect(defaults.localSttDebugAudioMaxFiles).toBe(20);
    expect(defaults.localSttDebugAudioMaxBytes).toBe(500_000_000);
    expect(loadServerConfig({ LOCAL_STT_SILENCE_MS: '1600' }).localSttSilenceMs).toBe(1_600);
    expect(loadServerConfig({ LOCAL_STT_DEBUG_AUDIO: 'true' }).localSttDebugAudio).toBe(true);
  });

  it('does not estimate a configured monetary budget without registered pricing', () => {
    expect(() => assertEstimatedCostWithinBudget({ sessionBudgetUsd: 1 })).toThrowError(
      expect.objectContaining({ code: 'stt_pricing_not_registered' }),
    );
  });

  it('stops external STT at the explicit audio-duration limit', () => {
    const limiter = new SttAudioDurationLimiter(10);
    expect(limiter.addAudioDuration(6)).toBe(6);
    expect(() => limiter.addAudioDuration(5)).toThrowError(
      expect.objectContaining({ code: 'stt_audio_limit_reached' }),
    );
    expect(limiter.totalSeconds).toBe(6);
  });
});

describe('hotword preparation', () => {
  const capabilities = {
    supported: true,
    supportsWeights: true,
    maxEntries: 2,
    maxTextLength: 10,
    minimumWeight: 0,
    maximumWeight: 2,
  } as const;

  it('filters disabled and other-language entries', () => {
    expect(prepareHotwords([
      { text: '東京大学', language: 'ja', enabled: true, weight: 1 },
      { text: 'private-name', language: 'en', enabled: true },
      { text: '無効', language: 'ja', enabled: false },
    ], 'ja', capabilities)).toEqual(['東京大学']);
  });

  it('ignores entries safely when the provider has no hotword support', () => {
    expect(prepareHotwords([
      { text: 'secret-name', language: 'ja', enabled: true },
    ], 'ja', { ...capabilities, supported: false })).toEqual([]);
  });

  it('rejects provider limits without exposing the hotword text', () => {
    const secret = '非公開固有名詞';
    try {
      prepareHotwords([{ text: secret, language: 'ja', enabled: true }], 'ja', {
        ...capabilities,
        maxTextLength: 2,
      });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_hotwords' });
      expect(String(error)).not.toContain(secret);
    }
  });
});
