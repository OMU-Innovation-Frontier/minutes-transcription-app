export interface AccessConfig {
  enabled: boolean;
  passphrase: string;
  origin: string;
  secure: boolean;
  staticDirectory: string;
  quotaFile: string;
  quotaBackend?: 'file' | 'supabase';
  supabaseUrl?: string;
  supabaseSecret?: string;
  sessionMs: number;
  recordingMs: number;
  maxSessions: number;
  maxConnections: number;
  maxHttpConcurrent: number;
  dailyStarts: number;
  dailySummary: number;
  dailyCorrection: number;
  dailyAudioSeconds: number;
}

export function loadAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const enabled = env.APP_ACCESS_ENABLED === 'true';
  const rawOrigin = env.APP_PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || 'http://127.0.0.1:8787';
  const origin = new URL(rawOrigin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const secure = origin.protocol === 'https:';
  const backend = env.APP_QUOTA_BACKEND || 'file';
  const remoteValid = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(env.APP_QUOTA_SUPABASE_URL || '')
    && /^sb_secret_[A-Za-z0-9_-]+$/.test(env.APP_QUOTA_SUPABASE_SECRET_KEY || '');
  if (enabled && ((!secure && !(local && env.APP_ALLOW_LOCAL_HTTP === 'true' && origin.protocol === 'http:'))
    || origin.origin !== rawOrigin || origin.username || origin.password
    || !env.APP_ACCESS_PASSPHRASE || env.APP_ACCESS_PASSPHRASE.length < 20
    || env.APP_ACCESS_PASSPHRASE.length > 256
    || !['file', 'supabase'].includes(backend)
    || (backend === 'file' && (!env.APP_QUOTA_FILE || Boolean(env.RENDER_EXTERNAL_URL)))
    || (backend === 'supabase' && !remoteValid))) {
    throw new Error('限定公開の設定が不正です。公開URL、合言葉、制限記録の保存先を確認してください。');
  }
  return {
    enabled, passphrase: env.APP_ACCESS_PASSPHRASE || '', origin: origin.origin, secure,
    quotaBackend: backend === 'supabase' ? 'supabase' : 'file',
    supabaseUrl: env.APP_QUOTA_SUPABASE_URL, supabaseSecret: env.APP_QUOTA_SUPABASE_SECRET_KEY,
    staticDirectory: env.APP_STATIC_DIR || 'dist', quotaFile: env.APP_QUOTA_FILE || 'server/data/access/quota.json',
    sessionMs: number(env.APP_ACCESS_SESSION_SECONDS, 28_800, 60, 86_400) * 1000,
    recordingMs: number(env.APP_MAX_RECORDING_SECONDS, 7200, 60, 14_400) * 1000,
    maxSessions: number(env.APP_MAX_LOGIN_SESSIONS, 32, 1, 100),
    maxConnections: number(env.APP_MAX_RECORDINGS, 1, 1, 3),
    maxHttpConcurrent: number(env.APP_MAX_AI_CONCURRENT, 2, 1, 4),
    dailyStarts: number(env.APP_DAILY_RECORDING_STARTS, 10, 1, 100),
    dailySummary: number(env.APP_DAILY_SUMMARY_REQUESTS, 30, 1, 1000),
    dailyCorrection: number(env.APP_DAILY_CORRECTION_REQUESTS, 2000, 1, 10_000),
    dailyAudioSeconds: number(env.APP_DAILY_AUDIO_SECONDS, 14_400, 1, 86_400),
  };
}

function number(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error('限定公開の制限値が不正です。');
  return parsed;
}
