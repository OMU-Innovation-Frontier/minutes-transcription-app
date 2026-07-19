import { resolve } from 'node:path';
import type { ServerProviderRequest } from '../../../shared/protocol.js';
import type { ServerConfig } from '../config.js';
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

export function createServerSpeechToTextProviderRuntime(config: ServerConfig): ServerProviderRuntime {
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
      return new MockServerSpeechToTextProvider();
    },
    close: async () => {
      await localRuntime.close();
      await metricsRecorder.close();
    },
  };
}
