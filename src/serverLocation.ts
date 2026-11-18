export function serverHttpUrl(): string {
  return import.meta.env.VITE_SERVER_HTTP_URL ?? (import.meta.env.PROD ? window.location.origin : 'http://127.0.0.1:8787');
}

export function serverWebSocketUrl(): string {
  if (import.meta.env.VITE_TRANSCRIPTION_WEBSOCKET_URL) return import.meta.env.VITE_TRANSCRIPTION_WEBSOCKET_URL;
  if (!import.meta.env.PROD) return 'ws://localhost:8787/transcription';
  const url = new URL('/transcription', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
