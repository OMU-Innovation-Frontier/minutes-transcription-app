import { MEETING_RECORDING_LIMIT_MS, SONIX_RECORDING_LIMIT_MS } from '../../shared/sonix.js';
import { SummaryProviderError } from './summary/summaryProviderCommon.js';
import { loadAccessConfig, type AccessConfig } from './access/config.js';
import { LimitedAccess, type AccessSession } from './access/limitedAccess.js';
import { AccessError } from './access/quotaStore.js';
import { securityHeaders, loginPage, handleLogin, serveApp } from './access/http.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { MAX_AUDIO_CHUNK_BYTES, MAX_SESSION_ID_BYTES, decodeAudioFrame, parseClientControlMessage, type ServerMessage, type ServerProviderRequest } from '../../shared/protocol.js';
import type { ServerConfig } from './config.js';
import type { SttProvider } from './providers/types.js';
import { TranscriptionWebSocketSession } from './session.js';
import { TranscriptionSessionRegistry } from './sessionRegistry.js';
import { loadSummaryConfig, type SummaryConfig } from './summary/config.js';
import { createSummaryService, SummaryServiceError, type SummaryService } from './summary/summaryService.js';
import type { FinalSummaryInput, IncrementalSummaryInput } from '../../shared/summary.js';
import { loadCorrectionConfig, OPENAI_CORRECTION_MODEL, type CorrectionConfig } from './correction/config.js';
import { ApiUsageStore } from './summary/usageStore.js';
import { createCorrectionService, type CorrectionService } from './correction/correctionService.js';

export const MAX_WEBSOCKET_PAYLOAD_BYTES = MAX_AUDIO_CHUNK_BYTES + MAX_SESSION_ID_BYTES + 25;

export interface TranscriptionApplicationOptions {
  config: ServerConfig;
  accessConfig?: AccessConfig;
  createProvider(requestedProvider?: ServerProviderRequest): SttProvider;
  summaryConfig?: SummaryConfig;
  summaryService?: SummaryService;
  correctionConfig?: CorrectionConfig;
  correctionService?: CorrectionService;
  textModelEnvironment?: NodeJS.ProcessEnv;
}

export interface RecordingSocket {
  isOpen(): boolean;
  send(data: string): void;
  close(code: number, reason: string): void;
}

interface HttpOptions {
  loginAddress?(request: IncomingMessage): string | undefined;
  serveAsset?(request: IncomingMessage, response: ServerResponse, path: string): Promise<void>;
}

export function createTranscriptionApplication(options: TranscriptionApplicationOptions, httpOptions: HttpOptions = {}) {
  const { config, createProvider } = options;
  const accessConfig = options.accessConfig ?? loadAccessConfig();
  if (!accessConfig.enabled && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('外部公開には限定公開認証の有効化が必要です。');
  if (accessConfig.enabled && (config.localSttEnabled || config.localSttDebugAudio)) throw new Error('限定公開ではLocal Whisperと音声デバッグ保存を無効にしてください。');
  const sonixEnabled = config.externalEnabled && Boolean(config.sonixApiKey);
  const sonioxEnabled = config.externalEnabled && Boolean(config.sonioxApiKey);
  const access = accessConfig.enabled ? new LimitedAccess(accessConfig) : null;
  const privateRegistries = new Map<string, TranscriptionSessionRegistry>();
  const socketSessions = new Map<RecordingSocket, AccessSession>();
  const textEnvironment = options.textModelEnvironment ?? process.env;
  const summaryConfig = options.summaryConfig ?? loadSummaryConfig(textEnvironment);
  const correctionConfig = options.correctionConfig ?? loadCorrectionConfig(textEnvironment);
  const usageStore = new ApiUsageStore(summaryConfig.usageFile);
  const defaultSummaryService = options.summaryService ?? createSummaryService(summaryConfig, usageStore);
  const defaultCorrectionService = options.correctionService ?? createCorrectionService(correctionConfig);
  const lunaKey = textEnvironment.OPENAI_API_KEY?.trim();
  const lunaSummaryService = lunaKey && summaryConfig.enabled ? createSummaryService({
    ...summaryConfig, provider: 'openai', apiKey: lunaKey,
    liveModel: OPENAI_CORRECTION_MODEL, finalModel: OPENAI_CORRECTION_MODEL,
    liveReasoningEffort: 'low', finalReasoningEffort: 'low',
    maxOutputTokens: 4096, pricingJson: textEnvironment.OPENAI_PRICING_JSON,
  }, usageStore) : undefined;
  const lunaCorrectionService = lunaKey && correctionConfig.enabled ? createCorrectionService({
    ...loadCorrectionConfig({ ...textEnvironment, LLM_CORRECTION_PROVIDER: 'openai' }),
    enabled: true, openAIApiKey: lunaKey,
  }) : undefined;
  const sessionRegistry = new TranscriptionSessionRegistry(
    createProvider,
    { resumeTtlMs: config.sessionResumeTtlMs ?? 120_000, maxSessions: config.maxSessions },
  );

  const handleHttp: RequestListener = (request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (error instanceof AccessError) sendJson(response, error.status, { code: error.code, message: error.message });
      else sendJson(response, 503, { code: 'access_unavailable', message: '処理を完了できません。管理者に連絡してください。' });
    });
  };
  async function handleRequest(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const route = new URL(request.url ?? '/', 'http://localhost');
    if (access) securityHeaders(response);
    let principal: AccessSession | null = null;
    if (access) {
      if (request.method === 'GET' && route.pathname === '/health') {
        response.setHeader('x-minutes-daily-limits', access.config.dailyLimitsEnabled === false ? 'disabled' : 'enabled');
        response.setHeader('x-minutes-recording-limit-seconds', String(access.config.recordingMs / 1_000));
        sendJson(response, 200, { status: 'ok' }); return;
      }
      if (request.method === 'GET' && route.pathname === '/auth/login') { loginPage(response); return; }
      if (request.method === 'POST' && route.pathname === '/auth/login') { await handleLogin(request, response, access, httpOptions.loginAddress?.(request)); return; }
      principal = access.authenticate(request);
      if (!principal) {
        if (request.method === 'GET' && route.pathname === '/') loginPage(response);
        else sendJson(response, 401, { code: 'access_required', message: 'ページを開き直して合言葉を入力してください。' });
        return;
      }
      if (request.method === 'POST') access.assertOrigin(request);
      if (request.method === 'POST' && route.pathname === '/auth/logout') {
        access.logout(principal);
        response.setHeader('set-cookie', access.cookie('', 0));
        response.writeHead(303, { location: '/' }); response.end(); return;
      }
      if (request.method === 'GET' && route.pathname === '/auth/session') { sendJson(response, 200, { expiresAt: principal.expiresAt }); return; }
    }
    const origin = request.headers.origin;
    if (origin && (access ? origin === access.config.origin : config.allowedOrigins.has(origin))) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-allow-headers', 'content-type,x-summary-provider');
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(origin && (access ? origin === access.config.origin : config.allowedOrigins.has(origin)) ? 204 : 403);
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', provider: config.provider, localSttEnabled: config.localSttEnabled }));
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/text-models') {
      response.setHeader('cache-control', 'no-store');
      sendJson(response, 200, { lunaSummary: Boolean(lunaSummaryService), lunaCorrection: lunaCorrectionService?.status().enabled === true });
      return;
    }
    const selectedTextProvider = url.searchParams.get('provider');
    const summaryService = selectedTextProvider === 'openai' ? lunaSummaryService : defaultSummaryService;
    const correctionService = selectedTextProvider === 'openai' ? lunaCorrectionService : defaultCorrectionService;
    if (selectedTextProvider !== null && (url.pathname.startsWith('/api/summary/') || url.pathname === '/api/correction' || url.pathname === '/api/correction/status')
      && (selectedTextProvider !== 'openai' || (url.pathname.startsWith('/api/summary/') ? !summaryService : !correctionService?.status().enabled))) {
      sendJson(response, 409, { code: 'text_model_unavailable', message: '選択したモデルを利用できません。' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/transcription/status') {
      response.setHeader('cache-control', 'no-store');
      const sonixRecordingLimitMs = access ? Math.min(SONIX_RECORDING_LIMIT_MS, access.config.recordingMs - 5_000) : SONIX_RECORDING_LIMIT_MS;
      sendJson(response, 200, {
        sonixRecordingLimitMs: sonixEnabled ? sonixRecordingLimitMs : null,
        sonioxRecordingLimitMs: sonioxEnabled ? Math.min(MEETING_RECORDING_LIMIT_MS, access?.config.recordingMs ?? MEETING_RECORDING_LIMIT_MS) : null,
      });
      return;
    }
    if (correctionService && request.method === 'GET' && url.pathname === '/api/correction/status') {
      sendJson(response, 200, correctionService.status());
      return;
    }
    if (correctionService && request.method === 'POST' && url.pathname === '/api/correction') {
      const release = access && principal ? await access.beginHttp(principal, 'correction') : () => undefined;
      try {
        const body = await readJsonBody(request);
        if (access && principal && !access.valid(principal)) throw new AccessError(401, 'access_required', '合言葉を入力し直してください。');
        sendJson(response, 200, await correctionService.correct(body));
      }
      catch (error) { if (error instanceof AccessError) throw error; sendCorrectionError(response, error); }
      finally { release(); }
      return;
    }
    if (summaryService && request.method === 'GET' && url.pathname === '/api/summary/status') {
      sendJson(response, 200, summaryService.status());
      return;
    }
    if (summaryService && request.method === 'GET' && url.pathname === '/api/summary/usage') {
      const originalId = url.searchParams.get('meetingId');
      const meetingId = access && principal && originalId ? access.namespace(principal, originalId) : originalId;
      if (!meetingId) {
        sendJson(response, 400, { code: 'invalid_request', message: 'meetingIdが必要です。' });
        return;
      }
      void summaryService.usage(meetingId)
        .then((usage) => sendJson(response, 200, usage))
        .catch((error) => sendSummaryError(response, error));
      return;
    }
    if (summaryService && request.method === 'POST' && (url.pathname === '/api/summary/live' || url.pathname === '/api/summary/final')) {
      if (origin && !(access ? origin === access.config.origin : config.allowedOrigins.has(origin))) {
        sendJson(response, 403, { code: 'invalid_origin', message: 'この接続元からは要約を実行できません。' });
        return;
      }
      const selectedProvider = summaryService.status().provider;
      const expectedProvider = request.headers['x-summary-provider'];
      if ((expectedProvider !== undefined && expectedProvider !== selectedProvider)
        || ((selectedProvider === 'groq' || selectedTextProvider === 'openai') && expectedProvider !== selectedProvider)) {
        sendJson(response, 409, { code: 'summary_provider_changed', message: '要約先を会議設定で確認し直してください。' });
        return;
      }
      const release = access && principal ? await access.beginHttp(principal, 'summary') : () => undefined;
      try {
        const body = await readJsonBody(request);
        if (access && principal) {
          if (!access.valid(principal)) throw new AccessError(401, 'access_required', '合言葉を入力し直してください。');
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400, 'invalid_request', '入力を確認してください。');
          const value = body as Record<string, unknown>;
          value.meetingId = access.namespace(principal, value.meetingId);
        }
        const result = url.pathname.endsWith('/live')
          ? await summaryService.update(body as IncrementalSummaryInput)
          : await summaryService.finalize(body as FinalSummaryInput);
        sendJson(response, 200, result);
      } catch (error) { if (error instanceof AccessError) throw error; sendSummaryError(response, error); }
      finally { release(); }
      return;
    }
    if (access) {
      if (httpOptions.serveAsset) await httpOptions.serveAsset(request, response, url.pathname);
      else await serveApp(request, response, access.config.staticDirectory, url.pathname);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'not_found' }));
  }

  if (access) access.onRevoke = (principal) => {
    for (const [socket, owner] of socketSessions) if (owner.id === principal.id) socket.close(1008, 'Access expired');
    const registry = privateRegistries.get(principal.id);
    privateRegistries.delete(principal.id);
    void registry?.closeAll().catch(() => undefined);
  };
  function connect(websocket: RecordingSocket, principal?: AccessSession) {
    if (principal) socketSessions.set(websocket, principal);
    let registry = sessionRegistry;
    if (access && principal) {
      registry = privateRegistries.get(principal.id) ?? new TranscriptionSessionRegistry(
        createProvider,
        { resumeTtlMs: 120_000, maxSessions: access.config.maxConnections });
      privateRegistries.set(principal.id, registry);
    }
    let recordingId: string | null = null;
    let finalizesAfterRecording = false;
    let receivedMessages = 0;
    let recordingTimer: ReturnType<typeof setTimeout> | undefined;
    const sessionTimer = access && principal ? setTimeout(() => websocket.close(1008, 'Access expired'), Math.max(1, principal.expiresAt - Date.now())) : undefined;
    const send = (message: ServerMessage): void => {
      if (access && principal && !access.valid(principal)) return;
      if (websocket.isOpen()) websocket.send(JSON.stringify(message));
    };
    const session = new TranscriptionWebSocketSession(
      createProvider(),
      {
        connectionTimeoutMs: config.connectionTimeoutMs,
        audioIdleTimeoutMs: config.audioIdleTimeoutMs,
        sessionResumeTtlMs: config.sessionResumeTtlMs,
        maxSessions: config.maxSessions,
      },
      send,
      () => websocket.close(1008, 'Session timeout'),
      registry,
    );

    let messageQueue = Promise.resolve();
    function message(data: string | Uint8Array): Promise<void> {
      if (access && receivedMessages >= 8) { websocket.close(1008, 'Message backlog'); return Promise.resolve(); }
      if (access) receivedMessages++;
      const isBinary = typeof data !== 'string';
      messageQueue = messageQueue.then(async () => {
        const control = access && typeof data === 'string' ? parseClientControlMessage(data) : undefined;
        if (access && principal) {
          if (!access.valid(principal) || !websocket.isOpen()) throw new AccessError(401, 'access_required', '合言葉を入力し直してください。');
          if (isBinary) {
            const frame = decodeAudioFrame(data);
            if (!frame.metadata || frame.metadata.sampleRate !== 16000 || frame.metadata.channels !== 1 || frame.sessionId !== recordingId) throw new AccessError(400, 'access_audio_format', '録音形式を確認してください。');
            await access.reserveAudio(principal, frame.sessionId, frame.audio.byteLength);
          } else if (control) {
            if (control.type === 'start' || control.type === 'resume') {
              const enabledProvider = control.provider === 'groq-whisper' || (control.provider === 'sonix' && sonixEnabled)
                || (control.provider === 'soniox' && sonioxEnabled);
              if (recordingId || !enabledProvider) {
                throw new AccessError(400, 'access_provider', '利用可能な文字起こし方法を選んでください。');
              }
              await access.claimRecording(principal, control.sessionId, control.type === 'resume');
              recordingId = control.sessionId;
              finalizesAfterRecording = control.provider === 'sonix' || control.provider === 'soniox';
              recordingTimer = setTimeout(() => websocket.close(1008, 'Recording time limit'), access.remainingRecordingMs(principal, control.sessionId));
            }
          }
          if (!access.valid(principal) || !websocket.isOpen()) throw new AccessError(401, 'access_required', '合言葉を入力し直してください。');
        }
        if (isBinary) await session.handleBinary(data);
        else {
          const ending = control && (control.type === 'stop' || control.type === 'cancel') && control.sessionId === recordingId;
          if (ending && finalizesAfterRecording) clearTimeout(recordingTimer);
          await session.handleText(data);
          if (ending && access && principal && recordingId) {
            access.releaseRecording(principal, recordingId); recordingId = null; clearTimeout(recordingTimer);
          }
        }
      }).catch((error: unknown) => {
        if (!access) return;
        const message = error instanceof AccessError ? error.message : '録音の利用上限または接続状態を確認してください。';
        send({ type: 'error', code: 'access_limit', message, retryable: false });
        websocket.close(1008, 'Access limit');
      }).finally(() => { if (access) receivedMessages--; });
      return messageQueue;
    }
    function close(): Promise<void> {
      socketSessions.delete(websocket);
      clearTimeout(sessionTimer); clearTimeout(recordingTimer);
      if (access && principal && recordingId) access.detach(principal, recordingId);
      return session.close();
    }
    return { message, close, error: () => session.close() };
  }

  return {
    config,
    access,
    handleHttp,
    connect,
    async close(): Promise<void> {
      await sessionRegistry.closeAll();
      await Promise.all([...privateRegistries.values()].map(registry => registry.closeAll()));
      await access?.close();
      await Promise.all([defaultCorrectionService.dispose(), lunaCorrectionService?.dispose()]);
      defaultSummaryService.dispose();
      lunaSummaryService?.dispose();
    },
  };
}

function sendJson(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sendSummaryError(response: import('node:http').ServerResponse, error: unknown): void {
  if (error instanceof RequestBodyError) {
    sendJson(response, error.status, { code: error.code, message: error.message });
    return;
  }
  if (error instanceof SummaryServiceError) {
    sendJson(response, error.status, { code: error.code, message: error.message });
    return;
  }
  if (error instanceof SummaryProviderError && error.code === 'summary_input_too_large') {
    sendJson(response, 413, { code: 'summary_input_too_large', message: '要約対象の文章量が上限を超えています。' });
    return;
  }
  if (error instanceof SummaryProviderError && error.code === 'rate_limited') {
    sendJson(response, 429, { code: 'summary_rate_limited', message: '要約サービスの利用制限に達しました。' });
    return;
  }
  sendJson(response, 500, { code: 'summary_failed', message: '要約処理に失敗しました。' });
}

function sendCorrectionError(response: import('node:http').ServerResponse, error: unknown): void {
  if (error instanceof RequestBodyError) {
    sendJson(response, error.status, { code: error.code, message: error.message });
    return;
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    sendJson(response, 400, { code: error.code, message: '整文リクエストを検証できませんでした。' });
    return;
  }
  sendJson(response, 500, { code: 'correction_failed', message: '整文処理に失敗しました。' });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > 1_000_000) throw new RequestBodyError('request_too_large', 'リクエストが大きすぎます。', 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestBodyError('invalid_json', 'JSONリクエストを解析できません。', 400);
  }
}

class RequestBodyError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = 'RequestBodyError';
  }
}
