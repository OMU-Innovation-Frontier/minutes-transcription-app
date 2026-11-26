import { isGroqWhisperModel } from '../../../../shared/protocol.js';
import type { ServerConfig } from '../../config.js';
import { GroqWhisperClient, groqError } from './groqWhisperClient.js';
import { GroqWhisperRuntime } from './groqWhisperRuntime.js';
import { GroqWhisperServerProvider } from './groqWhisperServerProvider.js';
import { GroqWhisperUsageGuard } from './groqWhisperUsageGuard.js';

export function createGroqWhisperProviderRuntime(config: ServerConfig, dependencies: { fetch?: typeof fetch; now?: () => number } = {}) {
  let runtime: GroqWhisperRuntime | undefined;
  const getGroqRuntime = (): GroqWhisperRuntime => {
    runtime ??= new GroqWhisperRuntime(
      new GroqWhisperClient({ apiKey: config.groqApiKey, externalEnabled: config.externalEnabled,
        timeoutMs: config.groqRequestTimeoutMs, fetch: dependencies.fetch }),
      new GroqWhisperUsageGuard({ maxSessionSeconds: config.groqMaxAudioSecondsPerSession,
        maxHourSeconds: config.groqMaxAudioSecondsPerHour, maxDaySeconds: config.groqMaxAudioSecondsPerDay }, dependencies.now),
      { maxConcurrency: config.groqMaxConcurrency, maxQueueSize: config.groqMaxQueueSize,
        maxSessions: config.maxSessions, now: dependencies.now },
    );
    return runtime;
  };
  return {
    create() {
      if (!isGroqWhisperModel(config.groqModel)) throw groqError('groq_model_unsupported', false);
      return new GroqWhisperServerProvider(getGroqRuntime(), {
        model: config.groqModel,
        stopTimeoutMs: config.groqStopTimeoutMs,
        now: dependencies.now,
        vad: {
          silenceDurationMs: config.groqVadSilenceMs,
          maxUtteranceDurationMs: config.groqVadMaxUtteranceMs,
          minimumUtteranceDurationMs: config.groqVadMinimumUtteranceMs,
          preSpeechBufferMs: config.groqVadPreSpeechMs,
          rmsThreshold: config.groqVadRmsThreshold,
          noiseFloorMultiplier: config.groqVadNoiseFloorMultiplier,
        },
      });
    },
    async close(): Promise<void> { await runtime?.close(); },
  };
}
