export type SttProviderId = 'local' | 'mock';

export class ServerConfigError extends Error {
  constructor(public readonly code: 'stt_provider_unsupported', message: string) {
    super(message);
    this.name = 'ServerConfigError';
  }
}

export interface ServerConfig {
  host: string;
  port: number;
  websocketPath: string;
  allowedOrigins: ReadonlySet<string>;
  maxSessions: number;
  connectionTimeoutMs: number;
  audioIdleTimeoutMs: number;
  sessionResumeTtlMs: number;
  provider: SttProviderId;
  externalEnabled: boolean;
  apiKey?: string;
  region?: string;
  model?: string;
  endpoint?: string;
  languageJa?: string;
  languageEn?: string;
  hotwordsEnabled: boolean;
  requestTimeoutMs: number;
  maxSessionSeconds?: number;
  sessionBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  maxAudioSecondsPerSession?: number;
  localSttEnabled: boolean;
  localSttModel: string;
  localSttThreads: number;
  localSttMaxUtteranceMs: number;
  localSttSilenceMs: number;
  localSttMinimumUtteranceMs: number;
  localSttPreSpeechBufferMs: number;
  localSttMaxQueueSize: number;
  localSttProcessTimeoutMs: number;
  localSttMaxSessions: number;
  localSttVadRmsThreshold: number;
  localSttNoiseFloorMultiplier: number;
  localSttDebugMetrics: boolean;
  localSttDebugAudio: boolean;
  localSttDebugAudioDirectory: string;
  localSttDebugAudioMaxFiles: number;
  localSttDebugAudioMaxBytes: number;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.STT_HOST || '127.0.0.1',
    port: readInteger(env.STT_PORT, 8787, 0, 65_535),
    websocketPath: normalizePath(env.STT_WEBSOCKET_PATH || '/transcription'),
    allowedOrigins: new Set(
      (env.STT_ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    maxSessions: readInteger(env.STT_MAX_SESSIONS, 20, 1, 1_000),
    connectionTimeoutMs: readInteger(env.STT_CONNECTION_TIMEOUT_MS, 15_000, 1_000, 120_000),
    audioIdleTimeoutMs: readInteger(env.STT_AUDIO_IDLE_TIMEOUT_MS, 30_000, 1_000, 600_000),
    sessionResumeTtlMs: readInteger(env.STT_SESSION_RESUME_TTL_MS, 120_000, 1_000, 3_600_000),
    provider: readSttProvider(env.STT_PROVIDER),
    externalEnabled: readBoolean(env.STT_EXTERNAL_ENABLED, false),
    apiKey: env.STT_API_KEY || undefined,
    region: readOptionalString(env.STT_REGION),
    model: readOptionalString(env.STT_MODEL),
    endpoint: readOptionalString(env.STT_ENDPOINT),
    languageJa: readOptionalString(env.STT_LANGUAGE_JA),
    languageEn: readOptionalString(env.STT_LANGUAGE_EN),
    hotwordsEnabled: readBoolean(env.STT_HOTWORDS_ENABLED, false),
    requestTimeoutMs: readInteger(env.STT_REQUEST_TIMEOUT_MS, 15_000, 1_000, 120_000),
    maxSessionSeconds: readOptionalNumber(env.STT_MAX_SESSION_SECONDS, 1, 86_400),
    sessionBudgetUsd: readOptionalNumber(env.STT_SESSION_BUDGET_USD, 0, Number.MAX_SAFE_INTEGER),
    monthlyBudgetUsd: readOptionalNumber(env.STT_MONTHLY_BUDGET_USD, 0, Number.MAX_SAFE_INTEGER),
    maxAudioSecondsPerSession: readOptionalNumber(
      env.STT_MAX_AUDIO_SECONDS_PER_SESSION,
      1,
      86_400,
    ),
    localSttEnabled: readBoolean(env.LOCAL_STT_ENABLED, false),
    localSttModel: env.LOCAL_STT_MODEL?.trim() || 'small-q5_1',
    localSttThreads: readInteger(env.LOCAL_STT_THREADS, 4, 1, 32),
    localSttMaxUtteranceMs: readInteger(env.LOCAL_STT_MAX_UTTERANCE_MS, 20_000, 1_000, 120_000),
    localSttSilenceMs: readInteger(env.LOCAL_STT_SILENCE_MS, 1_300, 200, 10_000),
    localSttMinimumUtteranceMs: readInteger(env.LOCAL_STT_MIN_UTTERANCE_MS, 300, 100, 10_000),
    localSttPreSpeechBufferMs: readInteger(
      env.LOCAL_STT_PRE_SPEECH_MS ?? env.LOCAL_STT_PRE_SPEECH_BUFFER_MS,
      300,
      20,
      5_000,
    ),
    localSttMaxQueueSize: readInteger(env.LOCAL_STT_MAX_QUEUE_SIZE, 10, 1, 100),
    localSttProcessTimeoutMs: readInteger(env.LOCAL_STT_PROCESS_TIMEOUT_MS, 120_000, 1_000, 900_000),
    localSttMaxSessions: readInteger(env.LOCAL_STT_MAX_SESSIONS, 1, 1, 10),
    localSttVadRmsThreshold: readOptionalNumber(env.LOCAL_STT_VAD_RMS_THRESHOLD, 0.0001, 0.5) ?? 0.012,
    localSttNoiseFloorMultiplier: readOptionalNumber(env.LOCAL_STT_NOISE_FLOOR_MULTIPLIER, 1, 20) ?? 3,
    localSttDebugMetrics: readBoolean(env.LOCAL_STT_DEBUG_METRICS, false),
    localSttDebugAudio: readBoolean(env.LOCAL_STT_DEBUG_AUDIO, false),
    localSttDebugAudioDirectory: env.LOCAL_STT_DEBUG_AUDIO_DIR?.trim()
      || 'server/data/local-stt/debug/realtime-audio',
    localSttDebugAudioMaxFiles: readInteger(env.LOCAL_STT_DEBUG_AUDIO_MAX_FILES, 20, 1, 10_000),
    localSttDebugAudioMaxBytes: readInteger(
      env.LOCAL_STT_DEBUG_AUDIO_MAX_BYTES,
      500_000_000,
      1_000_000,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function readSttProvider(value: string | undefined): SttProviderId {
  const configured = value?.trim().toLowerCase();
  if (!configured || configured === 'local' || configured === 'local-whisper') return 'local';
  if (configured === 'mock') return 'mock';
  throw new ServerConfigError(
    'stt_provider_unsupported',
    `Unsupported STT_PROVIDER value: ${configured}. Allowed values are local and mock.`,
  );
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function normalizePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return fallback;
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalNumber(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return undefined;
  return parsed;
}
