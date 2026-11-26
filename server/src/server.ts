import { AccessError } from './access/quotaStore.js';
import type { AccessSession } from './access/limitedAccess.js';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { ServerProviderRequest } from '../../shared/protocol.js';
import { createTranscriptionApplication, MAX_WEBSOCKET_PAYLOAD_BYTES, type TranscriptionApplicationOptions } from './transcriptionApplication.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createServerSpeechToTextProviderRuntime, type ServerProviderRuntime, type ServerProviderRuntimeDependencies } from './providers/providerFactory.js';
import type { SttProvider } from './providers/types.js';

export interface TranscriptionServerOptions extends Omit<TranscriptionApplicationOptions, 'config' | 'createProvider'> {
  config?: ServerConfig;
  providerFactory?: (config: ServerConfig, requestedProvider?: ServerProviderRequest) => SttProvider;
  providerRuntimeDependencies?: ServerProviderRuntimeDependencies;
  authorizeUpgrade?: (request: IncomingMessage) => boolean | Promise<boolean>;
}

export interface RunningTranscriptionServer {
  readonly httpServer: HttpServer;
  readonly websocketServer: WebSocketServer;
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
}

export function createTranscriptionServer(options: TranscriptionServerOptions = {}): RunningTranscriptionServer {
  const config = options.config ?? loadServerConfig();
  let runtime: ServerProviderRuntime | undefined;
  const application = createTranscriptionApplication({
    ...options,
    config,
    createProvider(requestedProvider) {
      if (options.providerFactory) return options.providerFactory(config, requestedProvider);
      runtime ??= createServerSpeechToTextProviderRuntime(config, options.providerRuntimeDependencies);
      return runtime.create(requestedProvider);
    },
  });
  const { access } = application;
  const authorizeUpgrade = options.authorizeUpgrade ?? (() => true);
  const httpServer = createServer(application.handleHttp);
  const websocketPrincipals = new WeakMap<WebSocket, AccessSession>();

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
          if (principal) websocketPrincipals.set(websocket, principal);
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

  websocketServer.on('connection', (websocket) => {
    const connection = application.connect({
      isOpen: () => websocket.readyState === WebSocket.OPEN,
      send: (data) => websocket.send(data),
      close: (code, reason) => websocket.close(code, reason),
    }, websocketPrincipals.get(websocket));
    websocket.on('message', (data, isBinary) => {
      void connection.message(isBinary ? toUint8Array(data) : toUtf8Text(data));
    });
    websocket.on('close', () => { void connection.close(); });
    websocket.on('error', () => { void connection.error(); });
  });

  return {
    httpServer,
    websocketServer,
    start: async () => {
      if (access) {
        try { await access.prepareQuotas(); }
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
      try { await application.close(); }
      finally { await runtime?.close(); }
      await Promise.all([
        new Promise<void>((resolve) => websocketServer.close(() => resolve())),
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => error ? reject(error) : resolve());
        }),
      ]);
    },
  };
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
