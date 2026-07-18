import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { MAX_AUDIO_CHUNK_BYTES, MAX_SESSION_ID_BYTES, type ServerMessage } from '../../shared/protocol.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createServerSpeechToTextProvider, createServerSpeechToTextProviderRuntime } from './providers/providerFactory.js';
import type { ServerSpeechToTextProvider } from './providers/types.js';
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
  providerFactory?: (config: ServerConfig, requestedProvider?: import('../../shared/protocol.js').ServerProviderRequest) => ServerSpeechToTextProvider;
  authorizeUpgrade?: (request: IncomingMessage) => boolean | Promise<boolean>;
  summaryConfig?: SummaryConfig;
  summaryService?: SummaryService;
  correctionConfig?: CorrectionConfig;
  correctionService?: CorrectionService;
}

export interface RunningTranscriptionServer {
  readonly httpServer: HttpServer;
  readonly websocketServer: WebSocketServer;
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
}

export function createTranscriptionServer(options: TranscriptionServerOptions = {}): RunningTranscriptionServer {
  const config = options.config ?? loadServerConfig();
  const providerRuntime = options.providerFactory ? undefined : createServerSpeechToTextProviderRuntime(config);
  const providerFactory = options.providerFactory ?? ((serverConfig: ServerConfig, requestedProvider?: import('../../shared/protocol.js').ServerProviderRequest) =>
    providerRuntime?.create(requestedProvider) ?? createServerSpeechToTextProvider(serverConfig, requestedProvider));
  const authorizeUpgrade = options.authorizeUpgrade ?? (() => true);
  const summaryService = options.summaryService ?? createSummaryService(options.summaryConfig ?? loadSummaryConfig());
  const correctionService = options.correctionService ?? createCorrectionService(options.correctionConfig ?? loadCorrectionConfig());
  const sessionRegistry = new TranscriptionSessionRegistry(
    (requestedProvider) => providerFactory(config, requestedProvider),
    { resumeTtlMs: config.sessionResumeTtlMs ?? 120_000, maxSessions: config.maxSessions },
  );

  const httpServer = createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin && config.allowedOrigins.has(origin)) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-allow-headers', 'content-type');
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(origin && config.allowedOrigins.has(origin) ? 204 : 403);
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
      void readJsonBody(request)
        .then((body) => correctionService.correct(body))
        .then((correction) => sendJson(response, 200, correction))
        .catch((error) => sendCorrectionError(response, error));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/summary/status') {
      sendJson(response, 200, summaryService.status());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/summary/usage') {
      const meetingId = url.searchParams.get('meetingId');
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
      void readJsonBody(request)
        .then((body): Promise<unknown> => url.pathname.endsWith('/live')
          ? summaryService.update(body as IncrementalSummaryInput)
          : summaryService.finalize(body as FinalSummaryInput))
        .then((summary) => sendJson(response, 200, summary))
        .catch((error) => sendSummaryError(response, error));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'not_found' }));
  });

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== config.websocketPath) return rejectUpgrade(socket, 404, 'Not Found');
      const origin = request.headers.origin;
      if (!origin || !config.allowedOrigins.has(origin)) return rejectUpgrade(socket, 403, 'Forbidden');
      if (websocketServer.clients.size >= config.maxSessions) return rejectUpgrade(socket, 503, 'Busy');
      if (!await authorizeUpgrade(request)) return rejectUpgrade(socket, 401, 'Unauthorized');

      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit('connection', websocket, request);
      });
    })().catch(() => rejectUpgrade(socket, 500, 'Upgrade Failed'));
  });

  websocketServer.on('connection', (websocket) => {
    const send = (message: ServerMessage): void => {
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
      sessionRegistry,
    );

    let messageQueue = Promise.resolve();
    websocket.on('message', (data, isBinary) => {
      messageQueue = messageQueue.then(async () => {
        if (isBinary) await session.handleBinary(toUint8Array(data));
        else await session.handleText(toUtf8Text(data));
      });
    });
    websocket.on('close', () => {
      void session.close();
    });
    websocket.on('error', () => {
      void session.close();
    });
  });

  return {
    httpServer,
    websocketServer,
    start: () => new Promise<AddressInfo>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      httpServer.once('error', onError);
      httpServer.listen(config.port, config.host, () => {
        httpServer.off('error', onError);
        const address = httpServer.address();
        if (!address || typeof address === 'string') return reject(new Error('Server address is unavailable.'));
        resolve(address);
      });
    }),
    stop: async () => {
      for (const client of websocketServer.clients) client.terminate();
      await sessionRegistry.closeAll();
      await providerRuntime?.close();
      await Promise.all([
        new Promise<void>((resolve) => websocketServer.close(() => resolve())),
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => error ? reject(error) : resolve());
        }),
      ]);
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
