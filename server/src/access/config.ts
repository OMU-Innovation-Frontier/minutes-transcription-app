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
  const originSetting = env.APP_PUBLIC_ORIGIN ? 'APP_PUBLIC_ORIGIN' : 'RENDER_EXTERNAL_URL / APP_PUBLIC_ORIGIN';
  let origin: URL;
  try { origin = new URL(rawOrigin); }
  catch { throw invalidSetting(originSetting, 'HTTPSの公開URLを指定してください。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const secure = origin.protocol === 'https:';
  const backend = env.APP_QUOTA_BACKEND || 'file';
  if (enabled) {
    if ((!secure && !(local && env.APP_ALLOW_LOCAL_HTTP === 'true' && origin.protocol === 'http:'))
      || origin.origin !== rawOrigin || origin.username || origin.password) {
      throw invalidSetting(originSetting, 'HTTPSの公開URLを指定し、末尾のスラッシュ・パス・空白を除いてください。');
    }
    if (!env.APP_ACCESS_PASSPHRASE || env.APP_ACCESS_PASSPHRASE.length < 20 || env.APP_ACCESS_PASSPHRASE.length > 256) {
      throw invalidSetting('APP_ACCESS_PASSPHRASE', '20〜256文字の合言葉を指定してください。');
    }
    if (!['file', 'supabase'].includes(backend) || (backend === 'file' && Boolean(env.RENDER_EXTERNAL_URL))) {
      throw invalidSetting('APP_QUOTA_BACKEND', 'Renderではsupabaseを指定してください。');
    }
    if (backend === 'file' && !env.APP_QUOTA_FILE) throw invalidSetting('APP_QUOTA_FILE', '永続保存する記録ファイルのパスを指定してください。');
    if (backend === 'supabase') {
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(env.APP_QUOTA_SUPABASE_URL || '')) {
        throw invalidSetting('APP_QUOTA_SUPABASE_URL', 'Project URLを指定し、末尾のスラッシュ・パス・空白を除いてください。');
      }
      if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(env.APP_QUOTA_SUPABASE_SECRET_KEY || '')) {
        throw invalidSetting('APP_QUOTA_SUPABASE_SECRET_KEY', 'sb_secret_で始まるSecret keyを指定し、前後の空白・改行を除いてください。');
      }
    }
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

// Only fixed setting names and guidance belong here. Never attach rejected values or URL parse errors.
function invalidSetting(name: string, guidance: string): Error {
  return new Error(`限定公開の設定が不正です: ${name}。${guidance}（設定値はログに表示していません。）`);
}

function number(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error('限定公開の制限値が不正です。');
  return parsed;
}
