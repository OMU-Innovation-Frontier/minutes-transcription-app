// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadAccessConfig } from '../src/access/config';

function valid(): NodeJS.ProcessEnv {
  return {
    APP_ACCESS_ENABLED: 'true', RENDER_EXTERNAL_URL: 'https://example.onrender.com',
    APP_ACCESS_PASSPHRASE: randomBytes(24).toString('hex'), APP_QUOTA_BACKEND: 'supabase',
    APP_QUOTA_SUPABASE_URL: 'https://example.supabase.co',
    APP_QUOTA_SUPABASE_SECRET_KEY: ['sb', 'secret', randomBytes(24).toString('hex')].join('_'),
  };
}
function message(env: NodeJS.ProcessEnv): string {
  try { loadAccessConfig(env); } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toBeUndefined();
    return error.stack || error.message;
  }
  throw new Error('Expected invalid settings to be rejected');
}

describe('safe startup configuration diagnostics', () => {
  it.each([
    ['APP_PUBLIC_ORIGIN', 'https://example.test/path'],
    ['APP_PUBLIC_ORIGIN', 'not a URL'],
    ['RENDER_EXTERNAL_URL', 'https://example.onrender.com/'],
    ['APP_ACCESS_PASSPHRASE', 'short'],
    ['APP_QUOTA_BACKEND', 'file'],
    ['APP_QUOTA_BACKEND', 'unknown'],
    ['APP_QUOTA_SUPABASE_URL', 'https://example.supabase.co/'],
    ['APP_QUOTA_SUPABASE_SECRET_KEY', 'unsupported key format'],
  ])('names the rejected setting %s without logging its value', (name, value) => {
    const env = { ...valid(), [name]: value };
    const error = message(env);
    expect(error).toContain(name);
    expect(error).not.toContain(env.APP_ACCESS_PASSPHRASE);
    expect(error).not.toContain(env.APP_QUOTA_SUPABASE_SECRET_KEY);
    if (name !== 'APP_QUOTA_BACKEND') expect(error).not.toContain(value);
  });
  it('does not attach rejected URL input, credentials or query data to a parser error', () => {
    const privateMarker = randomBytes(24).toString('hex');
    const error = message({ ...valid(), APP_PUBLIC_ORIGIN: 'invalid://' + privateMarker + '/?password=' + privateMarker });
    expect(error).toContain('APP_PUBLIC_ORIGIN'); expect(error).not.toContain(privateMarker);
  });
  it('distinguishes the local file configuration without relaxing its requirement', () => {
    const env = { ...valid(), APP_QUOTA_BACKEND: 'file', APP_QUOTA_FILE: '' };
    delete env.RENDER_EXTERNAL_URL; env.APP_PUBLIC_ORIGIN = 'https://example.test';
    expect(message(env)).toContain('APP_QUOTA_FILE');
  });
  it('preserves valid remote configuration and opaque secret values exactly', () => {
    const env = valid();
    const result = loadAccessConfig(env);
    expect(result.supabaseSecret).toBe(env.APP_QUOTA_SUPABASE_SECRET_KEY);
    expect(result.passphrase).toBe(env.APP_ACCESS_PASSPHRASE);
    expect(result.origin).toBe(env.RENDER_EXTERNAL_URL);
  });
});
