import { resolve } from 'node:path';
import type { ServerProviderRequest } from '../../../shared/protocol.js';
import type { ServerConfig } from '../config.js';
import {
  assertFunAsrApiKey,
  assertFunAsrModel,
  assertFunAsrWorkspaceId,
  resolveFunAsrSingaporeEndpoint,
} from './funAsr/funAsrEndpoint.js';
import { FunAsrProvider } from './funAsr/funAsrProvider.js';
import type { FunAsrTransportFactory } from './funAsr/funAsrTransport.js';
import { FunAsrUsageGuard } from './funAsr/funAsrUsageGuard.js';
import {
  FunAsrWebSocketTransport,
  type FunAsrWebSocketFactory,
} from './funAsr/funAsrWebSocketTransport.js';
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
  createFunAsrWebSocket?: FunAsrWebSocketFactory;
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
  const funAsrTransportFactory = dependencies.createFunAsrTransport
    ?? createLiveFunAsrTransportFactory(config, dependencies.createFunAsrWebSocket);
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
          transportFactory: funAsrTransportFactory,
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

function createLiveFunAsrTransportFactory(
  config: ServerConfig,
  createWebSocket: FunAsrWebSocketFactory | undefined,
): FunAsrTransportFactory {
  return () => {
    assertFunAsrApiKey(config.apiKey);
    assertFunAsrModel(config.model);
    assertFunAsrWorkspaceId(config.workspaceId);
    const endpoint = resolveFunAsrSingaporeEndpoint(
      config.region,
      config.workspaceId,
      config.endpoint,
    );
    return new FunAsrWebSocketTransport({
      endpoint,
      workspaceId: config.workspaceId,
      apiKey: config.apiKey,
      handshakeTimeoutMs: config.requestTimeoutMs,
      closeTimeoutMs: Math.min(config.requestTimeoutMs, 30_000),
      createWebSocket,
    });
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
