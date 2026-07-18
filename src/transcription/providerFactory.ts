import { BrowserSpeechToTextProvider, isBrowserSpeechRecognitionSupported } from './browserProvider';
import { MockSpeechToTextProvider } from './mockProvider';
import type { SpeechToTextProvider, SpeechToTextProviderKind } from './types';
import { WebSocketSpeechToTextProvider } from './webSocketProvider';

export function createSpeechToTextProvider(kind: SpeechToTextProviderKind): SpeechToTextProvider {
  if (kind === 'browser') return new BrowserSpeechToTextProvider();
  if (kind === 'websocket') return new WebSocketSpeechToTextProvider();
  if (kind === 'local-whisper') return new WebSocketSpeechToTextProvider({ mode: 'local-whisper' });
  return new MockSpeechToTextProvider();
}

export function getDefaultProviderKind(): SpeechToTextProviderKind {
  const configured = import.meta.env.VITE_TRANSCRIPTION_PROVIDER ?? import.meta.env.VITE_STT_PROVIDER;
  if (configured === 'websocket') return 'websocket';
  if (configured === 'local-whisper') return 'local-whisper';
  if (configured === 'mock') return 'mock';
  if (configured === 'browser' && isBrowserSpeechRecognitionSupported()) return 'browser';
  return isBrowserSpeechRecognitionSupported() ? 'browser' : 'mock';
}
