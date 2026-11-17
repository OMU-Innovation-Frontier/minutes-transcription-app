import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface AccountConnectionConfig {
  projectUrl: string;
  publishableKey: string;
  appOrigin: string;
}

/** Opt-in connection only. Creating a client does not migrate local meetings. */
export function createAccountClient(config: AccountConnectionConfig): SupabaseClient {
  const project = new URL(config.projectUrl);
  const origin = new URL(config.appOrigin);
  if (project.protocol !== 'https:' || project.username || project.password
    || !/^[a-z0-9-]+\.supabase\.co$/.test(project.hostname)
    || project.port || project.search || project.hash || project.pathname !== '/') {
    throw new Error('アカウント接続先の設定が不正です。');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) {
    throw new Error('公開用の接続キーを設定してください。');
  }
  if ((origin.protocol !== 'https:'
    && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('アプリの接続先の設定が不正です。');
  }
  return createClient(project.origin, config.publishableKey, {
    auth: {
      flowType: 'pkce',
      // The integration must explicitly handle the callback and its failure state.
      detectSessionInUrl: false,
      persistSession: true,
      storageKey: 'minutes-account-session',
    },
  });
}

export async function beginGoogleSignIn(client: SupabaseClient, config: AccountConnectionConfig): Promise<string> {
  const callback = new URL('/', config.appOrigin);
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: callback.href, skipBrowserRedirect: true },
  });
  if (error || !data.url) throw new Error('Googleログインを開始できませんでした。');
  const destination = new URL(data.url);
  const expected = new URL(config.projectUrl);
  if (destination.origin !== expected.origin || destination.pathname !== '/auth/v1/authorize') {
    throw new Error('Googleログインを開始できませんでした。');
  }
  return destination.href;
}

/** Account identity is not proof of circle membership or meeting access. */
export async function verifyAccount(client: SupabaseClient): Promise<{ id: string } | null> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id };
}
