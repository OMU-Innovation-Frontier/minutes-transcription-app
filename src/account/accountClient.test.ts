import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountClient } from './accountClient';
import { createClient } from '@supabase/supabase-js';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));

const valid = {
  projectUrl: 'https://synthetic-project.supabase.co',
  publishableKey: 'sb_publishable_synthetic_example',
  appOrigin: 'http://localhost:5173',
};

afterEach(() => vi.unstubAllGlobals());

describe('opt-in account client configuration', () => {
  it.each([
    { projectUrl: 'http://synthetic-project.supabase.co' },
    { projectUrl: 'https://supabase.co.attacker.test' },
    { projectUrl: 'https://synthetic-project.supabase.co/other' },
    { projectUrl: 'https://synthetic-project.supabase.co?token=example' },
    { publishableKey: 'sb_secret_synthetic_example' },
    { publishableKey: '' },
    { appOrigin: 'http://remote.test' },
    { appOrigin: 'https://app.test/redirect' },
    { appOrigin: 'https://user:pass@app.test' },
  ])('rejects unsafe configuration before network access: %j', (override) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(() => createAccountClient({ ...valid, ...override })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses PKCE with explicit callback handling and separate session storage', () => {
    createAccountClient(valid);
    expect(createClient).toHaveBeenCalledWith(valid.projectUrl, valid.publishableKey, {
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, storageKey: 'minutes-account-session' },
    });
  });
});
