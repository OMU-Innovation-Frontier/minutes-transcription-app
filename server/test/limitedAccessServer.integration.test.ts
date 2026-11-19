// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createTranscriptionServer, type RunningTranscriptionServer } from '../src/server';
import { loadServerConfig } from '../src/config';
import { loadSummaryConfig } from '../src/summary/config';
import { loadCorrectionConfig } from '../src/correction/config';
import { createCorrectionService } from '../src/correction/correctionService';
import { loadAccessConfig, type AccessConfig } from '../src/access/config';
import { SummaryService } from '../src/summary/summaryService';
import { MockSummaryProvider } from '../src/summary/mockSummaryProvider';
import { ApiUsageStore } from '../src/summary/usageStore';
import type { SttProvider } from '../src/providers/types';
import { encodeAudioFrame } from '../../shared/protocol';

const servers: RunningTranscriptionServer[] = [];
const folders: string[] = [];
const passphrase = 'synthetic-passphrase-for-tests-only';
const publicOrigin = 'http://127.0.0.1:8787';
const summaryBody = { meetingId: 'synthetic-meeting', liveSummary: null, sentences: [{ id: 's1', text: 'TODO: 合成データを確認', startTime: 0, endTime: 1 }] };
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  for (const folder of folders.splice(0)) {
    if (!resolve(folder).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test directory');
    await rm(folder, { recursive: true });
  }
});
async function start(overrides: Partial<AccessConfig> = {}, existingFolder?: string) {
  const folder = existingFolder ?? await mkdtemp(join(tmpdir(), 'minutes-access-server-'));
  if (!existingFolder) folders.push(folder);
  const assets = join(folder, 'dist'); await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'index.html'), '<!doctype html><html lang="ja"><body>synthetic application</body></html>');
  await writeFile(join(assets, '.env'), 'synthetic-private-file');
  const accessConfig = { ...loadAccessConfig({ APP_ACCESS_ENABLED: 'true', APP_ALLOW_LOCAL_HTTP: 'true', APP_PUBLIC_ORIGIN: publicOrigin, APP_ACCESS_PASSPHRASE: passphrase, APP_QUOTA_FILE: join(folder, 'quota.json'), APP_STATIC_DIR: assets }), ...overrides };
  const summary = new SummaryService({ ...loadSummaryConfig({}), enabled: true }, new MockSummaryProvider(), new ApiUsageStore());
  const finalized = vi.spyOn(summary, 'finalize');
  const correction = createCorrectionService(loadCorrectionConfig({}));
  const corrected = vi.spyOn(correction, 'correct');
  const started = vi.fn(async () => undefined), audio = vi.fn(async () => undefined), disposed = vi.fn(async () => undefined);
  const provider = (): SttProvider => ({ id: 'synthetic', startSession: started, sendAudio: audio, stopSession: async () => undefined, dispose: disposed, onTranscript: () => undefined, onError: () => undefined });
  const server = createTranscriptionServer({ config: { ...loadServerConfig({}), port: 0 }, accessConfig, summaryService: summary, correctionService: correction, providerFactory: provider });
  const address = await server.start(); servers.push(server);
  return { server, base: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}/transcription`, finalized, corrected, started, audio, disposed, folder, accessConfig };
}
async function login(base: string, password = passphrase): Promise<Response> {
  return fetch(base + '/auth/login', { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ passphrase: password }), redirect: 'manual' });
}
async function cookie(base: string): Promise<string> {
  const result = await login(base); expect(result.status).toBe(303);
  return result.headers.get('set-cookie')!.split(';')[0]!;
}
function post(base: string, path: string, session: string, body: unknown = summaryBody, origin = publicOrigin): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: { cookie: session, origin, 'content-type': 'application/json', 'x-summary-provider': 'mock' }, body: JSON.stringify(body) });
}
async function connect(url: string, session: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { origin: publicOrigin, headers: { cookie: session } });
  await once(socket, 'open'); return socket;
}
async function rejectedSocket(url: string, session = '', origin = publicOrigin): Promise<number> {
  return new Promise<number>((done, reject) => {
    const socket = new WebSocket(url, { origin, headers: { cookie: session } });
    socket.on('error', () => undefined);
    socket.once('unexpected-response', (_request, response) => { const status = response.statusCode!; response.resume(); socket.terminate(); done(status); });
    socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected upgrade')); });
  });
}
function control(socket: WebSocket, type: 'start' | 'resume', id = 'synthetic-recording'): void {
  socket.send(JSON.stringify({ type, sessionId: id, language: 'ja', audioFormat: 'audio/pcm;rate=16000;channels=1;format=s16le', provider: 'groq-whisper', ...(type === 'resume' ? { lastAcknowledgedSequence: -1 } : {}) }));
}
async function message(socket: WebSocket): Promise<Record<string, unknown>> { return JSON.parse(String((await once(socket, 'message'))[0])); }

describe('limited-access server boundaries', () => {
  it('protects the app, every AI HTTP route and websocket while keeping health minimal', async () => {
    const h = await start();
    const page = await fetch(h.base + '/'); expect(await page.text()).toContain('Minutesへの入室');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(await fetch(h.base + '/health').then(result => result.json())).toEqual({ status: 'ok' });
    for (const path of ['/api/summary/status', '/api/correction/status', '/api/summary/usage?meetingId=synthetic-meeting', '/index.html']) expect((await fetch(h.base + path)).status).toBe(401);
    for (const path of ['/api/summary/live', '/api/summary/final', '/api/correction']) expect((await post(h.base, path, '')).status).toBe(401);
    expect(await rejectedSocket(h.ws)).toBe(401);
    expect(h.finalized).not.toHaveBeenCalled(); expect(h.corrected).not.toHaveBeenCalled(); expect(h.started).not.toHaveBeenCalled();
  });
  it('serves only allowed build files after login, and logout invalidates the session', async () => {
    const h = await start();
    const failure = await login(h.base, '<script>synthetic</script>');
    expect(failure.status).toBe(401); expect(await failure.text()).not.toContain('<script>synthetic</script>');
    const session = await cookie(h.base);
    const page = await fetch(h.base + '/', { headers: { cookie: session } }); expect(await page.text()).toContain('synthetic application');
    for (const path of ['/.env', '/%2eenv', '/package.json', '/../package.json']) expect((await fetch(h.base + path, { headers: { cookie: session } })).status).toBe(404);
    const logout = await fetch(h.base + '/auth/logout', { method: 'POST', headers: { cookie: session, origin: publicOrigin }, redirect: 'manual' });
    expect(logout.status).toBe(303); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(h.base + '/api/summary/status', { headers: { cookie: session } })).status).toBe(401);
  });
  it('rejects cross-origin requests before quota reservation or provider invocation', async () => {
    const h = await start(); const session = await cookie(h.base);
    for (const path of ['/api/summary/final', '/api/correction', '/auth/logout']) expect((await post(h.base, path, session, summaryBody, 'https://untrusted.test')).status).toBe(403);
    expect(await rejectedSocket(h.ws, session, 'https://untrusted.test')).toBe(403);
    expect(h.finalized).not.toHaveBeenCalled(); expect(h.corrected).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(h.accessConfig.quotaFile, 'utf8'))).toMatchObject({ summary: 0, correction: 0 });
  });
  it('keeps native login/logout form origins usable and rejects absent, null and foreign origins', async () => {
    const h = await start();
    const page = await fetch(h.base + '/auth/login');
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(await page.text()).toContain('method="post" action="/auth/login"');
    const session = await cookie(h.base);
    const app = await fetch(h.base + '/', { headers: { cookie: session } });
    expect(app.headers.get('referrer-policy')).toBe('same-origin');
    for (const origin of [undefined, 'null', 'https://untrusted.test']) {
      for (const path of ['/auth/login', '/auth/logout']) {
        const rejected = await fetch(h.base + path, { method: 'POST', redirect: 'manual',
          headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
          body: new URLSearchParams({ passphrase }) });
        expect(rejected.status).toBe(403);
        expect(rejected.headers.get('set-cookie')).toBeNull();
        expect(await rejected.json()).toMatchObject({ code: 'access_origin' });
      }
    }
    expect((await fetch(h.base + '/auth/session', { headers: { cookie: session } })).status).toBe(200);
    const logout = await fetch(h.base + '/auth/logout', { method: 'POST', redirect: 'manual', headers: { cookie: session, origin: publicOrigin } });
    expect(logout.status).toBe(303);
    expect((await fetch(h.base + '/auth/session', { headers: { cookie: session } })).status).toBe(401);
  });
  it('reserves failed calls too, isolates meeting usage by login session, and retains the global limit after restart', async () => {
    const h = await start({ dailySummary: 2 }); const first = await cookie(h.base), second = await cookie(h.base);
    expect((await post(h.base, '/api/summary/final', first)).status).toBe(200);
    expect((await post(h.base, '/api/summary/final', second, {})).status).toBe(400);
    expect((await post(h.base, '/api/summary/final', second)).status).toBe(429);
    const suppliedId = h.finalized.mock.calls[0]![0].meetingId;
    expect(suppliedId).not.toBe(summaryBody.meetingId);
    expect(suppliedId.endsWith('-' + summaryBody.meetingId)).toBe(true);
    await h.server.stop(); servers.splice(servers.indexOf(h.server), 1);
    const restarted = await start({ dailySummary: 2 }, h.folder);
    const nextSession = await cookie(restarted.base);
    expect((await post(restarted.base, '/api/summary/final', nextSession)).status).toBe(429);
    expect(restarted.finalized).not.toHaveBeenCalled();
  });
  it('counts correction attempts and rejects excess work without contacting its provider', async () => {
    const h = await start({ dailyCorrection: 1 }); const session = await cookie(h.base);
    expect((await post(h.base, '/api/correction', session, {})).status).toBe(400);
    expect((await post(h.base, '/api/correction', session, {})).status).toBe(429);
    expect(h.corrected).toHaveBeenCalledTimes(1);
  });
  it('limits concurrent websocket connections, charges PCM bytes, and revokes active connections on logout', async () => {
    const h = await start({ dailyAudioSeconds: 1 }); const session = await cookie(h.base);
    const socket = await connect(h.ws, session);
    expect(await rejectedSocket(h.ws, session)).toBe(429);
    const ready = message(socket); control(socket, 'start'); expect((await ready).type).toBe('ready');
    const ack = message(socket);
    socket.send(encodeAudioFrame('synthetic-recording', 0, new ArrayBuffer(32_000), { capturedAt: 0, sampleRate: 16000, channels: 1, encoding: 'pcm_s16le', frameCount: 16000 }));
    expect((await ack).type).toBe('audio_ack'); expect(h.audio).toHaveBeenCalledOnce();
    const closed = once(socket, 'close');
    await fetch(h.base + '/auth/logout', { method: 'POST', headers: { cookie: session, origin: publicOrigin }, redirect: 'manual' });
    await closed;
    expect(await rejectedSocket(h.ws, session)).toBe(401);
  });
  it('blocks audio above the persistent daily cap before passing it to STT', async () => {
    const h = await start({ dailyAudioSeconds: 1 }); const session = await cookie(h.base);
    const socket = await connect(h.ws, session); const ready = message(socket); control(socket, 'start'); await ready;
    const error = message(socket); const closed = once(socket, 'close');
    socket.send(encodeAudioFrame('synthetic-recording', 0, new ArrayBuffer(32_002), { capturedAt: 0, sampleRate: 16000, channels: 1, encoding: 'pcm_s16le', frameCount: 16001 }));
    expect((await error).code).toBe('access_limit'); await closed;
    expect(h.audio).not.toHaveBeenCalled();
  });
  it('does not let another login resume a detached recording with the same session ID', async () => {
    const h = await start(); const first = await cookie(h.base), second = await cookie(h.base);
    const a = await connect(h.ws, first); const ready = message(a); control(a, 'start'); await ready;
    const closedA = once(a, 'close'); a.close(); await closedA;
    const b = await connect(h.ws, second); const error = message(b); const closedB = once(b, 'close'); control(b, 'resume');
    expect((await error).code).toBe('access_limit'); await closedB;
    expect(h.started).toHaveBeenCalledOnce();
  });
  it('does not listen on a public interface with authentication disabled', () => {
    expect(() => createTranscriptionServer({ config: { ...loadServerConfig({}), host: '0.0.0.0' }, accessConfig: loadAccessConfig({}) })).toThrow('認証');
  });
});
