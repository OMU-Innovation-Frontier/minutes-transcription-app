import { SummaryProviderError } from './summary/summaryProviderCommon.js';
import { loadAccessConfig, type AccessConfig } from './access/config.js';
import { LimitedAccess, type AccessSession } from './access/limitedAccess.js';
import { AccessError } from './access/quotaStore.js';
import { securityHeaders, loginPage, handleLogin, serveApp } from './access/http.js';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { MAX_AUDIO_CHUNK_BYTES, MAX_SESSION_ID_BYTES, decodeAudioFrame, parseClientControlMessage, type ServerMessage } from '../../shared/protocol.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createServerSpeechToTextProviderRuntime, type ServerProviderRuntimeDependencies } from './providers/providerFactory.js';
import type { SttProvider } from './providers/types.js';
import { TranscriptionWebSocketSession } from './session.js';
import { TranscriptionSessionRegistry } from './sessionRegistry.js';
import { loadSummaryConfig, type SummaryConfig } from './summary/config.js';
import { createSummaryService, SummaryServiceError, type SummaryService } from './summary/summaryService.js';
import type { FinalSummaryInput, IncrementalSummaryInput } from '../../shared/summary.js';
import { loadCorrectionConfig, type CorrectionConfig } from './correction/config.js';
import { createCorrectionService, type CorrectionService } from './correction/correctionService.js';

const MAX_WEBSOCKET_PAYLOAD_BYTES = MAX_AUDIO_CHUNK_BYTES + MAX_SESSION_ID_BYTES + 25;

export interface TranscriptionServerOptions {
  config?: ServerConfig;
  accessConfig?: AccessConfig;
  providerFactory?: (config: ServerConfig, requestedProvider?: import('../../shared/protocol.js').ServerProviderRequest) => SttProvider;
  authorizeUpgrade?: (request: IncomingMessage) => boolean | Promise<boolean>;
  summaryConfig?: SummaryConfig;
  summaryService?: SummaryService;
  correctionConfig?: CorrectionConfig;
  correctionService?: CorrectionService;
  providerRuntimeDependencies?: ServerProviderRuntimeDependencies;
}

export interface RunningTranscriptionServer {
  readonly httpServer: HttpServer;
  readonly websocketServer: WebSocketServer;
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
}

export function createTranscriptionServer(options: TranscriptionServerOptions = {}): RunningTranscriptionServer {
  const config = options.config ?? loadServerConfig();
  const accessConfig = options.accessConfig ?? loadAccessConfig();
  if (!accessConfig.enabled && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('外部公開には限定公開認証の有効化が必要です。');
  if (accessConfig.enabled && (config.localSttEnabled || config.localSttDebugAudio)) throw new Error('限定公開ではLocal Whisperと音声デバッグ保存を無効にしてください。');
  const access = accessConfig.enabled ? new LimitedAccess(accessConfig) : null;
  const privateRegistries = new Map<string, TranscriptionSessionRegistry>();
  const socketSessions = new WeakMap<WebSocket, AccessSession>();
  const providerRuntime = options.providerFactory ? undefined
    : createServerSpeechToTextProviderRuntime(config, options.providerRuntimeDependencies);
  const providerFactory = options.providerFactory ?? ((serverConfig: ServerConfig, requestedProvider?: import('../../shared/protocol.js').ServerProviderRequest) =>
    providerRuntime?.create(requestedProvider) ?? failMissingProviderRuntime(serverConfig));
  const authorizeUpgrade = options.authorizeUpgrade ?? (() => true);
  const summaryService = options.summaryService ?? createSummaryService(options.summaryConfig ?? loadSummaryConfig());
  const correctionService = options.correctionService ?? createCorrectionService(options.correctionConfig ?? loadCorrectionConfig());
  const sessionRegistry = new TranscriptionSessionRegistry(
    (requestedProvider) => providerFactory(config, requestedProvider),
    { resumeTtlMs: config.sessionResumeTtlMs ?? 120_000, maxSessions: config.maxSessions },
  );

  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (error instanceof AccessError) sendJson(response, error.status, { code: error.code, message: error.message });
      else sendJson(response, 503, { code: 'access_unavailable', message: '処理を完了できません。管理者に連絡してください。' });
    });
  });
  async function handleRequest(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const route = new URL(request.url ?? '/', 'http://localhost');
    if (access) securityHeaders(response);
    let principal: AccessSession | null = null;
    if (access) {
      if (request.method === 'GET' && route.pathname === '/health') { sendJson(response, 200, { status: 'ok' }); return; }
      if (request.method === 'GET' && route.pathname === '/auth/login') { loginPage(response); return; }
      if (request.method === 'POST' && route.pathname === '/auth/login') { await handleLogin(request, response, access); return; }
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
    if (request.method === 'GET' && url.pathname === '/api/correction/status') {
      sendJson(response, 200, correctionService.status());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/correction') {
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
    if (request.method === 'GET' && url.pathname === '/api/summary/status') {
      sendJson(response, 200, summaryService.status());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/summary/usage') {
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
    if (request.method === 'POST' && (url.pathname === '/api/summary/live' || url.pathname === '/api/summary/final')) {
      if (origin && !(access ? origin === access.config.origin : config.allowedOrigins.has(origin))) {
        sendJson(response, 403, { code: 'invalid_origin', message: 'この接続元からは要約を実行できません。' });
        return;
      }
      const selectedProvider = summaryService.status().provider;
      const expectedProvider = request.headers['x-summary-provider'];
      if ((expectedProvider !== undefined && expectedProvider !== selectedProvider)
        || (selectedProvider === 'groq' && expectedProvider !== 'groq')) {
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
    if (access) { await serveApp(request, response, access.config.staticDirectory, url.pathname); return; }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'not_found' }));
  }

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 15_000;

  httpServer.on('upgrade', (request, socket, head) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== config.websocketPath) return rejectUpgrade(socket, 404, 'Not Found');
      const origin = request.headers.origin;
      if (!origin || !(access ? origin === access.config.origin : config.allowedOrigins.has(origin))) return rejectUpgrade(socket, 403, 'Forbidden');
      if (websocketServer.clients.size >= config.maxSessions) return rejectUpgrade(socket, 503, 'Busy');
      const principal = access?.authenticate(request);
      if (access && !principal) return rejectUpgrade(socket, 401, 'Unauthorized');
      let release: (() => void) | undefined;
      try {
        if (access && principal) release = access.acquireConnection(principal);
        if (!await authorizeUpgrade(request) || (access && principal && !access.valid(principal))) return rejectUpgrade(socket, 401, 'Unauthorized');
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
          if (principal) socketSessions.set(websocket, principal);
          const releaseConnection = release;
          websocket.once('close', () => releaseConnection?.());
          release = undefined;
          websocketServer.emit('connection', websocket, request);
        });
      } catch (error) {
        if (error instanceof AccessError) return rejectUpgrade(socket, error.status, 'Access denied');
        throw error;
      } finally { release?.(); }
    })().catch(() => rejectUpgrade(socket, 500, 'Upgrade Failed'));
  });

  if (access) access.onRevoke = (principal) => {
    for (const socket of websocketServer.clients) if (socketSessions.get(socket)?.id === principal.id) socket.close(1008, 'Access expired');
    const registry = privateRegistries.get(principal.id);
    privateRegistries.delete(principal.id);
    void registry?.closeAll().catch(() => undefined);
  };
  websocketServer.on('connection', (websocket) => {
    const principal = socketSessions.get(websocket);
    let registry = sessionRegistry;
    if (access && principal) {
      registry = privateRegistries.get(principal.id) ?? new TranscriptionSessionRegistry(
        (requestedProvider) => providerFactory(config, requestedProvider),
        { resumeTtlMs: 120_000, maxSessions: access.config.maxConnections });
      privateRegistries.set(principal.id, registry);
    }
    let recordingId: string | null = null;
    let receivedMessages = 0;
    let recordingTimer: ReturnType<typeof setTimeout> | undefined;
    const sessionTimer = access && principal ? setTimeout(() => websocket.close(1008, 'Access expired'), Math.max(1, principal.expiresAt - Date.now())) : undefined;
    const send = (message: ServerMessage): void => {
      if (access && principal && !access.valid(principal)) return;
      if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(message));
    };
    const session = new TranscriptionWebSocketSession(
      providerFactory(config),
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
    websocket.on('message', (data, isBinary) => {
      if (access && ++receivedMessages > 8) { websocket.close(1008, 'Message backlog'); return; }
      messageQueue = messageQueue.then(async () => {
        if (access && principal) {
          if (!access.valid(principal) || websocket.readyState !== WebSocket.OPEN) throw new AccessError(401, 'access_required', '合言葉を入力し直してください。');
          if (isBinary) {
            const frame = decodeAudioFrame(toUint8Array(data));
            if (!frame.metadata || frame.metadata.sampleRate !== 16000 || frame.metadata.channels !== 1 || frame.sessionId !== recordingId) throw new AccessError(400, 'access_audio_format', '録音形式を確認してください。');
            await access.reserveAudio(principal, frame.sessionId, frame.audio.byteLength);
          } else {
            const control = parseClientControlMessage(toUtf8Text(data));
            if (control.type === 'start' || control.type === 'resume') {
              if (recordingId || control.provider !== 'groq-whisper') throw new AccessError(400, 'access_provider', '限定公開ではGroq Whisperを選んでください。');
              await access.claimRecording(principal, control.sessionId, control.type === 'resume');
              recordingId = control.sessionId;
              recordingTimer = setTimeout(() => websocket.close(1008, 'Recording time limit'), access.remainingRecordingMs(principal, control.sessionId));
            }
          }
          if (!access.valid(principal) || websocket.readyState !== WebSocket.OPEN) throw new AccessError(401, 'access_required', '合言葉を入力し直してください。');
        }
        if (isBinary) await session.handleBinary(toUint8Array(data));
        else {
          await session.handleText(toUtf8Text(data));
          if (access && principal && recordingId) {
            const control = parseClientControlMessage(toUtf8Text(data));
            if ((control.type === 'stop' || control.type === 'cancel') && control.sessionId === recordingId) {
              access.releaseRecording(principal, recordingId); recordingId = null; clearTimeout(recordingTimer);
            }
          }
        }
      }).catch(() => {
        if (access) { send({ type: 'error', code: 'access_limit', message: '録音の利用上限または接続状態を確認してください。', retryable: false }); websocket.close(1008, 'Access limit'); }
      }).finally(() => { if (access) receivedMessages--; });
    });
    websocket.on('close', () => {
      clearTimeout(sessionTimer); clearTimeout(recordingTimer);
      if (access && principal && recordingId) access.detach(principal, recordingId);
      void session.close();
    });
    websocket.on('error', () => {
      void session.close();
    });
  });

  return {
    httpServer,
    websocketServer,
    start: async () => {
      if (access) {
        try { await access.quotas.initialize(); }
        catch { await access.close(); throw new Error('利用上限の記録を準備できません。永続保存先を確認してください。'); }
      }
      return new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once('error', onError);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', onError);
          const address = httpServer.address();
          if (!address || typeof address === 'string') return reject(new Error('Server address is unavailable.'));
          resolve(address);
        });
      });
    },
    stop: async () => {
      for (const client of websocketServer.clients) client.terminate();
      await sessionRegistry.closeAll();
      await Promise.all([...privateRegistries.values()].map(registry => registry.closeAll()));
      await access?.close();
      await providerRuntime?.close();
      await correctionService.dispose();
      summaryService.dispose();
      await Promise.all([
        new Promise<void>((resolve) => websocketServer.close(() => resolve())),
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => error ? reject(error) : resolve());
        }),
      ]);
    },
  };
}

function failMissingProviderRuntime(config: ServerConfig): never {
  throw new Error(`STT provider runtime is unavailable for ${config.provider}.`);
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

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toUtf8Text(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number, statusText: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
