import { handleAsNodeRequest } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';
import { createServer, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { AccessError } from './access/quotaStore.js';
import { loadAccessConfig } from './access/config.js';
import { loadServerConfig } from './config.js';
import { loadSummaryConfig } from './summary/config.js';
import { loadCorrectionConfig } from './correction/config.js';
import { createTranscriptionApplication, MAX_WEBSOCKET_PAYLOAD_BYTES } from './transcriptionApplication.js';
import { createGroqWhisperProviderRuntime } from './providers/groq/groqWhisperProviderRuntime.js';

interface Fetcher { fetch(request: Request): Promise<Response> }
interface Env {
  ASSETS: Fetcher;
  MINUTES: { getByName(name: string): Fetcher };
  APP_PUBLIC_ORIGIN?: string;
}
interface WorkerSocket extends WebSocket { accept(): void }
declare const WebSocketPair: new () => { 0: WorkerSocket; 1: WorkerSocket };

const NODE_HTTP_PORT = 8790;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.APP_PUBLIC_ORIGIN) return unavailable();
    if (new URL(request.url).origin !== env.APP_PUBLIC_ORIGIN) return new Response(null, { status: 421 });
    try {
      return await env.MINUTES.getByName('minutes').fetch(request);
    } catch {
      return unavailable();
    }
  },
};

export class MinutesDurableObject extends DurableObject<Env> {
  private application?: ReturnType<typeof createTranscriptionApplication>;

  async fetch(request: Request): Promise<Response> {
    try {
      const { config, access, connect } = this.application ??= this.createApplication();
      if (!access) return unavailable();
      if (new URL(request.url).pathname !== config.websocketPath) return await handleAsNodeRequest(NODE_HTTP_PORT, request);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
      if (request.headers.get('origin') !== access.config.origin) return new Response(null, { status: 403 });
      const principal = access.authenticate({ headers: { cookie: request.headers.get('cookie') ?? undefined } });
      if (!principal) return new Response(null, { status: 401 });

      await access.prepareQuotas();
      const release = access.acquireConnection(principal);
      try {
        const { 0: client, 1: socket } = new WebSocketPair();
        socket.binaryType = 'arraybuffer';
        socket.accept();
        const connection = connect({
          isOpen: () => socket.readyState === WebSocket.OPEN,
          send: (data) => socket.send(data),
          close: (code, reason) => socket.close(code, reason),
        }, principal);
        socket.addEventListener('message', ({ data }) => {
          const bytes = typeof data === 'string' ? Buffer.byteLength(data)
            : data instanceof ArrayBuffer ? data.byteLength : Infinity;
          if (bytes > MAX_WEBSOCKET_PAYLOAD_BYTES) { socket.close(1009, 'Message too large'); return; }
          this.ctx.waitUntil(connection.message(typeof data === 'string' ? data : new Uint8Array(data)));
        });
        socket.addEventListener('close', () => {
          release();
          this.ctx.waitUntil(connection.close());
        });
        socket.addEventListener('error', () => { this.ctx.waitUntil(connection.error()); });
        const upgrade: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };
        return new Response(null, upgrade);
      } catch (error) {
        release();
        throw error;
      }
    } catch (error) {
      return error instanceof AccessError && error.status < 500
        ? new Response(null, { status: error.status })
        : unavailable();
    }
  }

  private createApplication() {
    const bindings: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(this.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const accessConfig = loadAccessConfig(bindings);
    const config = loadServerConfig(bindings);
    if (!accessConfig.enabled || accessConfig.quotaBackend !== 'supabase' || config.provider !== 'groq-whisper'
      || !config.externalEnabled || !config.groqApiKey) {
      throw new Error('公開設定を確認してください。');
    }
    const summaryConfig = { ...loadSummaryConfig(bindings), usageFile: undefined };
    const provider = createGroqWhisperProviderRuntime(config);
    const application = createTranscriptionApplication({
      config, accessConfig, summaryConfig, createProvider: provider.create, correctionConfig: loadCorrectionConfig(bindings),
    }, {
      loginAddress: (request) => {
        const ip = request.headers['cf-connecting-ip'];
        return typeof ip === 'string' ? ip : undefined;
      },
      serveAsset: async (request, response, path) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(404).end();
          return;
        }
        await sendAsset(response, this.env.ASSETS, path, request.method);
      },
    });
    const server = createServer(application.handleHttp);
    server.listen(NODE_HTTP_PORT);
    return application;
  }
}

async function sendAsset(response: ServerResponse, assets: Fetcher, path: string, method: string): Promise<void> {
  const assetUrl = new URL('https://assets.invalid');
  assetUrl.pathname = path === '/' ? '/index.html' : path;
  const asset = await assets.fetch(new Request(assetUrl, { method }));
  const contentType = asset.headers.get('content-type');
  if (contentType) response.setHeader('content-type', contentType);
  response.writeHead(asset.status);
  if (!asset.body) { response.end(); return; }
  const stream = asset.body as import('node:stream/web').ReadableStream<Uint8Array>;
  Readable.fromWeb(stream).on('error', () => response.destroy()).pipe(response);
}

function unavailable(): Response {
  return new Response('Service unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
}
