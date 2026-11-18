// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadAccessConfig, type AccessConfig } from '../src/access/config';
import { AccessQuotaStore } from '../src/access/quotaStore';
import { LimitedAccess } from '../src/access/limitedAccess';

const folders: string[] = [];
const gates: LimitedAccess[] = [];
const passphrase = 'synthetic-passphrase-for-tests-only';
async function config(): Promise<AccessConfig> {
  const folder = await mkdtemp(join(tmpdir(), 'minutes-access-test-')); folders.push(folder);
  return loadAccessConfig({ APP_ACCESS_ENABLED: 'true', APP_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', APP_ALLOW_LOCAL_HTTP: 'true', APP_ACCESS_PASSPHRASE: passphrase, APP_QUOTA_FILE: join(folder, 'quota.json') });
}
afterEach(async () => {
  await Promise.all(gates.splice(0).map(gate => gate.close()));
  for (const folder of folders.splice(0)) {
    if (!resolve(folder).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test folder');
    await rm(folder, { recursive: true });
  }
});

describe('limited access configuration', () => {
  it('is disabled for existing local development', () => { expect(loadAccessConfig({}).enabled).toBe(false); });
  it.each([
    { APP_PUBLIC_ORIGIN: 'http://remote.test' }, { APP_PUBLIC_ORIGIN: 'https://user:pass@remote.test' },
    { APP_PUBLIC_ORIGIN: 'https://remote.test/path' }, { APP_ACCESS_PASSPHRASE: 'short' },
    { APP_QUOTA_FILE: '' }, { APP_MAX_RECORDINGS: '0' }, { APP_DAILY_SUMMARY_REQUESTS: 'NaN' },
  ])('rejects unsafe public settings', async overrides => {
    const value = await config();
    expect(() => loadAccessConfig({ APP_ACCESS_ENABLED: 'true', APP_PUBLIC_ORIGIN: 'https://remote.test', APP_ACCESS_PASSPHRASE: passphrase, APP_QUOTA_FILE: value.quotaFile, ...overrides })).toThrow();
  });
});

describe('durable reservations', () => {
  it('serializes simultaneous requests and retains limits across restart', async () => {
    const settings = { ...await config(), dailySummary: 2 };
    const first = new AccessQuotaStore(settings); await first.initialize();
    const results = await Promise.allSettled([first.reserve('summary'), first.reserve('summary'), first.reserve('summary')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    const restarted = new AccessQuotaStore(settings); await restarted.initialize();
    await expect(restarted.reserve('summary')).rejects.toMatchObject({ code: 'access_daily_limit' });
    expect(JSON.parse(await readFile(settings.quotaFile, 'utf8')).summary).toBe(2);
  });
  it('fails closed for missing or corrupt established quota records', async () => {
    const settings = await config();
    const store = new AccessQuotaStore(settings); await store.initialize(); await store.reserve('correction');
    await unlink(settings.quotaFile);
    await expect(new AccessQuotaStore(settings).initialize()).rejects.toThrow();
    await writeFile(settings.quotaFile, '{broken');
    await expect(new AccessQuotaStore(settings).initialize()).rejects.toThrow();
    await expect(store.reserve('summary')).rejects.toThrow();
  });
  it('resets on a new UTC day but never grants another reset after a clock rollback', async () => {
    let now = Date.UTC(2026, 10, 19);
    const settings = { ...await config(), dailyStarts: 1 };
    const store = new AccessQuotaStore(settings, () => now); await store.initialize(); await store.reserve('starts');
    now += 86_400_000; await store.reserve('starts');
    now -= 86_400_000;
    await expect(store.reserve('starts')).rejects.toMatchObject({ code: 'access_daily_limit' });
  });
  it('charges audio by actual PCM bytes and keeps failed reservations out of the ledger', async () => {
    const settings = { ...await config(), dailyAudioSeconds: 1 };
    const store = new AccessQuotaStore(settings); await store.initialize();
    await store.reserve('audioBytes', 32_000);
    await expect(store.reserve('audioBytes', 1)).rejects.toMatchObject({ code: 'access_daily_limit' });
    expect(JSON.parse(await readFile(settings.quotaFile, 'utf8')).audioBytes).toBe(32_000);
  });
});

async function enter(gate: LimitedAccess) {
  const request = { headers: { origin: gate.config.origin }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
  const setHeader = vi.fn();
  await gate.login(request, { setHeader } as unknown as ServerResponse, passphrase);
  const cookie = String(setHeader.mock.calls[0]![1]).split(';')[0]!;
  const session = gate.authenticate({ headers: { cookie } } as IncomingMessage)!;
  return { cookie, session, request };
}

describe('opaque sessions and bounded operations', () => {
  it('uses secure HttpOnly cookies with no passphrase and rejects duplicate or forged cookies', async () => {
    const gate = new LimitedAccess({ ...await config(), origin: 'https://remote.test', secure: true }); gates.push(gate);
    const { cookie, session } = await enter(gate);
    expect(cookie).not.toContain(passphrase);
    expect(gate.cookie('synthetic', 1)).toContain('HttpOnly; SameSite=Strict');
    expect(gate.cookie('synthetic', 1)).toContain('; Secure');
    expect(gate.cookieName).toBe('__Host-minutes_access');
    expect(gate.authenticate({ headers: { cookie: cookie + '; ' + cookie } } as IncomingMessage)).toBeNull();
    expect(gate.authenticate({ headers: { cookie: gate.cookieName + '=forged' } } as IncomingMessage)).toBeNull();
    gate.logout(session);
    expect(gate.authenticate({ headers: { cookie } } as IncomingMessage)).toBeNull();
  });
  it('expires sessions and rate-limits failed logins without trusting forwarded client IPs', async () => {
    let now = Date.now();
    const gate = new LimitedAccess({ ...await config(), sessionMs: 1000 }, () => now); gates.push(gate);
    const { cookie, request } = await enter(gate);
    const revoked = vi.fn(); gate.onRevoke = revoked;
    now += 1001;
    expect(gate.authenticate({ headers: { cookie } } as IncomingMessage)).toBeNull();
    expect(revoked).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) await expect(gate.login(request, { setHeader: vi.fn() } as unknown as ServerResponse, 'wrong')).rejects.toMatchObject({ status: 401 });
    request.headers['x-forwarded-for'] = '203.0.113.9';
    await expect(gate.login(request, { setHeader: vi.fn() } as unknown as ServerResponse, passphrase)).rejects.toMatchObject({ status: 429 });
  });
  it('reserves global HTTP concurrency before awaiting disk IO and releases exactly once', async () => {
    const gate = new LimitedAccess({ ...await config(), maxHttpConcurrent: 1 }); gates.push(gate); await gate.quotas.initialize();
    const { session } = await enter(gate);
    const first = gate.beginHttp(session, 'summary');
    await expect(gate.beginHttp(session, 'correction')).rejects.toMatchObject({ code: 'access_busy' });
    const release = await first; release(); release();
    const next = await gate.beginHttp(session, 'correction'); next();
    expect(JSON.parse(await readFile(gate.config.quotaFile, 'utf8'))).toMatchObject({ summary: 1, correction: 1 });
  });
  it('keeps recording deadlines and audio limits across reconnects, and isolates meeting namespaces', async () => {
    let now = Date.now();
    const gate = new LimitedAccess({ ...await config(), recordingMs: 1000 }, () => now); gates.push(gate); await gate.quotas.initialize();
    const first = await enter(gate), second = await enter(gate);
    expect(gate.namespace(first.session, 'meeting')).not.toBe(gate.namespace(second.session, 'meeting'));
    await gate.claimRecording(first.session, 'recording', false);
    await expect(gate.claimRecording(second.session, 'recording', true)).rejects.toThrow();
    await gate.reserveAudio(first.session, 'recording', 32_000);
    gate.detach(first.session, 'recording'); now += 500;
    await gate.claimRecording(first.session, 'recording', true);
    expect(gate.remainingRecordingMs(first.session, 'recording')).toBe(500);
    await expect(gate.reserveAudio(first.session, 'recording', 2)).rejects.toMatchObject({ code: 'access_audio_limit' });
  });
});
