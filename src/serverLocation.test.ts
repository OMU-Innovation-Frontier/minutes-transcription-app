import { afterEach, expect, it, vi } from 'vitest';
import { serverHttpUrl, serverWebSocketUrl } from './serverLocation';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('preserves the existing loopback defaults in development', () => {
  vi.stubEnv('PROD', false);
  vi.stubEnv('VITE_SERVER_HTTP_URL', undefined);
  vi.stubEnv('VITE_TRANSCRIPTION_WEBSOCKET_URL', undefined);
  expect(serverHttpUrl()).toBe('http://127.0.0.1:8787');
  expect(serverWebSocketUrl()).toBe('ws://localhost:8787/transcription');
});

it('uses same-origin HTTPS and WSS in the public build without exposing credentials', () => {
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_SERVER_HTTP_URL', undefined);
  vi.stubEnv('VITE_TRANSCRIPTION_WEBSOCKET_URL', undefined);
  vi.stubGlobal('window', { location: { href: 'https://synthetic.test/', origin: 'https://synthetic.test', protocol: 'https:' } });
  expect(serverHttpUrl()).toBe('https://synthetic.test');
  expect(serverWebSocketUrl()).toBe('wss://synthetic.test/transcription');
});

it('keeps explicit local configuration compatible', () => {
  vi.stubEnv('VITE_SERVER_HTTP_URL', 'http://127.0.0.1:9000');
  vi.stubEnv('VITE_TRANSCRIPTION_WEBSOCKET_URL', 'ws://127.0.0.1:9000/transcription');
  expect(serverHttpUrl()).toBe('http://127.0.0.1:9000');
  expect(serverWebSocketUrl()).toBe('ws://127.0.0.1:9000/transcription');
});
