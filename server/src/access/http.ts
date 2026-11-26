import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { LimitedAccess } from './limitedAccess.js';
import { AccessError } from './quotaStore.js';

export function securityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  // no-referrer makes native form POSTs send Origin: null, breaking strict login/logout checks.
  // Preserve same-origin form metadata while suppressing referrers to external sites.
  response.setHeader('referrer-policy', 'same-origin');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

export function loginPage(response: ServerResponse, status = 200): void {
  const message = status === 401 ? '合言葉を確認してください。' : status === 429 ? '時間をおいてから再試行してください。' : '';
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Minutesへの入室</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#fff;color:#151515}main{max-width:28rem;margin:10vh auto;padding:1.5rem}label{display:block;margin:1rem 0}input,button{box-sizing:border-box;width:100%;min-height:48px;padding:.75rem;font:inherit}button{background:#145dce;color:white;border:0;cursor:pointer}:focus-visible{outline:3px solid #145dce;outline-offset:3px}p{line-height:1.7}</style></head><body><main><h1>Minutesへの入室</h1><p>サークルの合言葉を入力してください。APIキーは入力しません。</p><p role="alert">${message}</p><form method="post" action="/auth/login"><label for="passphrase">合言葉</label><input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">入室する</button></form></main></body></html>`);
}

export async function handleLogin(request: IncomingMessage, response: ServerResponse, gate: LimitedAccess, clientAddress?: string): Promise<void> {
  gate.assertOrigin(request);
  if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new AccessError(400, 'invalid_request', '入力形式を確認してください。');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > 2048) throw new AccessError(413, 'invalid_request', '入力が大きすぎます。');
    chunks.push(bytes);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const password = fields.get('passphrase');
  if (fields.size !== 1 || !password || password.length > 256) throw new AccessError(400, 'invalid_request', '合言葉を確認してください。');
  try { await gate.login(request, response, password, clientAddress); }
  catch (error) {
    if (error instanceof AccessError && [401, 429].includes(error.status)) { loginPage(response, error.status); return; }
    throw error;
  }
  response.writeHead(303, { location: '/' });
  response.end();
}

export async function serveApp(request: IncomingMessage, response: ServerResponse, directory: string, pathname: string): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(404); response.end(); return; }
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };
  try {
    const root = await realpath(resolve(directory));
    const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    if (decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) throw new Error();
    const target = await realpath(resolve(root, '.' + decoded));
    if (!target.startsWith(root + sep) || !types[extname(target)]) throw new Error();
    const info = await stat(target);
    if (!info.isFile()) throw new Error();
    response.writeHead(200, { 'content-type': types[extname(target)]!, 'content-length': info.size });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(target);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch { if (!response.headersSent) { response.writeHead(404); response.end(); } }
}
