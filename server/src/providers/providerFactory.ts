import { resolve } from 'node:path';
import type { ServerProviderRequest } from '../../../shared/protocol.js';
import type { ServerConfig } from '../config.js';
import { FunAsrProvider } from './funAsr/funAsrProvider.js';
import type { FunAsrTransportFactory } from './funAsr/funAsrTransport.js';
import { FunAsrUsageGuard } from './funAsr/funAsrUsageGuard.js';
import { LocalWhisperRuntime } from './local/localWhisperRuntime.js';
import { LocalWhisperServerProvider } from './local/localWhisperServerProvider.js';
import { LocalRealtimeMetricsRecorder } from './local/localRealtimeMetrics.js';
import { RealtimeDebugAudioStore } from './local/realtimeDebugAudio.js';
import { MockServerSpeechToTextProvider } from './mockProvider.js';
import type { SttProvider } from './types.js';

export interface ServerProviderRuntime {
  create(requestedProvider?: ServerProviderRequest): SttProvider;
  close(): Promise<void>;
}

export interface ServerProviderRuntimeDependencies {
  createFunAsrTransport?: FunAsrTransportFactory;
  now?: () => number;
  randomUUID?: () => string;
}

export function createServerSpeechToTextProviderRuntime(
  config: ServerConfig,
  dependencies: ServerProviderRuntimeDependencies = {},
): ServerProviderRuntime {
  const localRoot = resolve(process.cwd(), 'server/data/local-stt');
  const metricsRecorder = new LocalRealtimeMetricsRecorder(config.localSttDebugMetrics, localRoot);
  const debugAudioStore = new RealtimeDebugAudioStore({
    enabled: config.localSttDebugAudio,
    localRoot,
    directory: resolve(process.cwd(), config.localSttDebugAudioDirectory),
    maxFiles: config.localSttDebugAudioMaxFiles,
    maxBytes: config.localSttDebugAudioMaxBytes,
    onWarning: (code) => console.warn(`[local-whisper] ${code}`),
  });
  const localRuntime = new LocalWhisperRuntime({
    enabled: config.localSttEnabled,
    modelId: config.localSttModel,
    root: localRoot,
    threads: config.localSttThreads,
    maxQueueSize: config.localSttMaxQueueSize,
    maxSessions: config.localSttMaxSessions,
    processTimeoutMs: config.localSttProcessTimeoutMs,
    debugAudioStore,
  });
  const funAsrUsageGuard = createFunAsrUsageGuard(config, dependencies.now);
  return {
    create(requestedProvider) {
      const provider = requestedProvider === 'local-whisper' ? 'local' : config.provider;
      if (provider === 'local') {
        return new LocalWhisperServerProvider(localRuntime, {
          onMetric: (metric) => metricsRecorder.record(metric),
          vad: {
            silenceDurationMs: config.localSttSilenceMs,
            maxUtteranceDurationMs: config.localSttMaxUtteranceMs,
            minimumUtteranceDurationMs: config.localSttMinimumUtteranceMs,
            preSpeechBufferMs: config.localSttPreSpeechBufferMs,
            rmsThreshold: config.localSttVadRmsThreshold,
            noiseFloorMultiplier: config.localSttNoiseFloorMultiplier,
          },
        });
      }
      if (provider === 'fun-asr') {
        return new FunAsrProvider({
          externalEnabled: config.externalEnabled,
          transportFactory: dependencies.createFunAsrTransport,
          usageGuard: funAsrUsageGuard,
          model: config.model,
          startTimeoutMs: config.requestTimeoutMs,
          sendTimeoutMs: config.requestTimeoutMs,
          finishTimeoutMs: config.requestTimeoutMs,
          now: dependencies.now,
          randomUUID: dependencies.randomUUID,
        });
      }
      return new MockServerSpeechToTextProvider();
    },
    close: async () => {
      await localRuntime.close();
      await metricsRecorder.close();
    },
  };
}

function createFunAsrUsageGuard(
  config: ServerConfig,
  now: (() => number) | undefined,
): FunAsrUsageGuard | undefined {
  if (
    config.maxAudioSecondsPerSession === undefined
    || config.maxAudioSecondsPerDay === undefined
    || config.maxAudioSecondsPerMonth === undefined
    || config.maxConcurrentExternalSessions === undefined
  ) {
    return undefined;
  }
  return new FunAsrUsageGuard({
    maxAudioSecondsPerSession: config.maxAudioSecondsPerSession,
    maxAudioSecondsPerDay: config.maxAudioSecondsPerDay,
    maxAudioSecondsPerMonth: config.maxAudioSecondsPerMonth,
    maxConcurrentSessions: config.maxConcurrentExternalSessions,
  }, now);
}
