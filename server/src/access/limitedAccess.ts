import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccessConfig } from './config.js';
import { AccessError, AccessQuotaStore, type QuotaLedger } from './quotaStore.js';
import { SupabaseQuotaStore } from './supabaseQuotaStore.js';

export interface AccessSession { id: string; expiresAt: number }
export class LimitedAccess {
  readonly quotas: QuotaLedger;
  private readonly salt = randomBytes(32);
  private readonly passwordHash: Buffer;
  private readonly sessions = new Map<string, AccessSession>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly connections = new Map<string, number>();
  private readonly recordings = new Map<string, { owner: string; endsAt: number; bytes: number; detachedUntil?: number }>();
  private pendingHttp = 0;
  private loginChecks = 0;
  private quotaReady?: Promise<void>;
  private readonly sweeper: ReturnType<typeof setInterval>;
  onRevoke?: (session: AccessSession) => void;

  constructor(readonly config: AccessConfig, private readonly now: () => number = Date.now) {
    this.passwordHash = scryptSync(config.passphrase, this.salt, 32);
    this.quotas = config.quotaBackend === 'supabase' ? new SupabaseQuotaStore(config) : new AccessQuotaStore(config, now);
    this.sweeper = setInterval(() => this.sweep(), 10_000);
    this.sweeper.unref();
  }
  get cookieName(): string { return this.config.secure ? '__Host-minutes_access' : 'minutes_access'; }
  prepareQuotas(): Promise<void> {
    return this.quotaReady ??= this.quotas.initialize().catch((error: unknown) => {
      this.quotaReady = undefined;
      throw error;
    });
  }
  cookie(token: string, seconds: number): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.config.secure ? '; Secure' : ''}`;
  }
  authenticate(request: { headers: { cookie?: string } }): AccessSession | null {
    this.sweep();
    const raw = request.headers.cookie || '';
    if (raw.length > 4096) return null;
    const values = raw.split(';').map(item => item.trim()).filter(item => item.startsWith(this.cookieName + '='));
    if (values.length !== 1) return null;
    const token = values[0]!.slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? this.sessions.get(hash(token)) ?? null : null;
  }
  valid(session: AccessSession): boolean { return this.sessions.get(session.id) === session && session.expiresAt > this.now(); }
  assertOrigin(request: IncomingMessage): void {
    if (request.headers.origin !== this.config.origin) throw new AccessError(403, 'access_origin', 'この接続元からは操作できません。');
  }
  async login(request: IncomingMessage, response: ServerResponse, password: string, clientAddress?: string): Promise<void> {
    this.assertOrigin(request);
    this.sweep();
    // Only use an explicit address from an adapter that trusts its reverse proxy.
    const address = hash(clientAddress || request.socket.remoteAddress || 'unknown');
    this.attempt('all', 30); this.attempt(address, 5);
    if (this.loginChecks >= 2) throw new AccessError(429, 'access_login_limit', '時間をおいてから再試行してください。');
    this.loginChecks++;
    try {
      const candidate = await new Promise<Buffer>((resolve, reject) => scrypt(password, this.salt, 32, (error, value) => error ? reject(error) : resolve(value)));
      const matches = timingSafeEqual(candidate, this.passwordHash); candidate.fill(0);
      if (!matches) throw new AccessError(401, 'access_login_failed', '合言葉を確認してください。');
      if (this.sessions.size >= this.config.maxSessions) throw new AccessError(429, 'access_sessions_full', '利用者数の上限に達しています。');
      const token = randomBytes(32).toString('base64url');
      const id = hash(token);
      this.sessions.set(id, { id, expiresAt: this.now() + this.config.sessionMs });
      response.setHeader('set-cookie', this.cookie(token, Math.floor(this.config.sessionMs / 1000)));
    } finally { this.loginChecks--; }
  }
  logout(session: AccessSession): void {
    this.sessions.delete(session.id);
    this.onRevoke?.(session);
    for (const [key, lease] of this.recordings) if (lease.owner === session.id) this.recordings.delete(key);
  }
  acquireConnection(session: AccessSession): () => void {
    if (!this.valid(session)) throw new AccessError(401, 'access_required', '合言葉を入力し直してください。');
    if ([...this.connections.values()].reduce((a,b) => a+b, 0) >= this.config.maxConnections) throw new AccessError(429, 'access_busy', 'ほかの録音が進行中です。');
    this.connections.set(session.id, (this.connections.get(session.id) ?? 0) + 1);
    let released = false;
    return () => { if (released) return; released = true; const count = (this.connections.get(session.id) ?? 1) - 1; if (count > 0) this.connections.set(session.id,count); else this.connections.delete(session.id); };
  }
  async claimRecording(session: AccessSession, id: string, resume: boolean): Promise<void> {
    this.sweep();
    const key = session.id + ':' + id;
    const existing = this.recordings.get(key);
    if (resume && existing && existing.endsAt > this.now()) { existing.detachedUntil = undefined; return; }
    if (resume || existing || this.recordings.size >= this.config.maxConnections) throw new AccessError(429, 'access_recording_limit', '録音の利用上限を確認してください。');
    // Insert before awaiting persistence, preventing simultaneous starts from exceeding the limit.
    this.recordings.set(key, { owner: session.id, endsAt: this.now() + this.config.recordingMs, bytes: 0 });
    try {
      await this.prepareQuotas();
      await this.quotas.reserve('starts');
    } catch (error) { this.recordings.delete(key); throw error; }
  }
  async reserveAudio(session: AccessSession, id: string, bytes: number): Promise<void> {
    const lease = this.recordings.get(session.id + ':' + id);
    if (!lease || lease.endsAt <= this.now() || lease.bytes + bytes > this.config.recordingMs * 32) throw new AccessError(429, 'access_audio_limit', 'この録音の時間上限に達しました。');
    lease.bytes += bytes;
    await this.quotas.reserve('audioBytes',bytes);
  }
  detach(session: AccessSession, id: string): void {
    const lease = this.recordings.get(session.id + ':' + id);
    if (lease) lease.detachedUntil = this.now() + 120_000;
  }
  remainingRecordingMs(session: AccessSession, id: string): number {
    return Math.max(1, (this.recordings.get(session.id + ':' + id)?.endsAt ?? this.now()) - this.now());
  }
  releaseRecording(session: AccessSession, id: string): void { this.recordings.delete(session.id + ':' + id); }
  async beginHttp(session: AccessSession, kind: 'summary' | 'correction'): Promise<() => void> {
    if (!this.valid(session)) throw new AccessError(401, 'access_required', '合言葉を入力し直してください。');
    if (this.pendingHttp >= this.config.maxHttpConcurrent) throw new AccessError(429, 'access_busy', '処理中です。しばらくお待ちください。');
    this.pendingHttp++;
    try {
      await this.prepareQuotas();
      await this.quotas.reserve(kind);
    }
    catch (error) { this.pendingHttp--; throw error; }
    let released = false;
    return () => { if (!released) { released = true; this.pendingHttp--; } };
  }
  namespace(session: AccessSession, id: unknown): string {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new AccessError(400, 'invalid_request', '会議IDを確認してください。');
    return session.id + '-' + id;
  }
  async close(): Promise<void> { clearInterval(this.sweeper); for (const session of this.sessions.values()) this.logout(session); await this.quotas.settled(); this.passwordHash.fill(0); }
  private attempt(key: string, maximum: number): void {
    let value = this.attempts.get(key);
    if (!value || value.until <= this.now()) { value = { count: 0, until: this.now() + 60_000 }; this.attempts.set(key,value); }
    if (++value.count > maximum || this.attempts.size > 1000) throw new AccessError(429, 'access_login_limit', '時間をおいてから再試行してください。');
  }
  private sweep(): void {
    for (const session of this.sessions.values()) if (session.expiresAt <= this.now()) this.logout(session);
    for (const [key, value] of this.attempts) if (value.until <= this.now()) this.attempts.delete(key);
    for (const [key, value] of this.recordings) if (value.endsAt <= this.now() || (value.detachedUntil !== undefined && value.detachedUntil <= this.now())) this.recordings.delete(key);
  }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
