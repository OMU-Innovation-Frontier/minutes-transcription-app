/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRANSCRIPTION_PROVIDER?: 'browser' | 'mock' | 'websocket' | 'local-whisper';
  readonly VITE_TRANSCRIPTION_WEBSOCKET_URL?: string;
  readonly VITE_SERVER_HTTP_URL?: string;
  readonly VITE_AUDIO_BUFFER_MAX_SECONDS?: string;
  readonly VITE_AUDIO_BUFFER_MAX_BYTES?: string;
  readonly VITE_WS_RECONNECT_BASE_MS?: string;
  readonly VITE_WS_RECONNECT_MAX_MS?: string;
  readonly VITE_WS_RECONNECT_MAX_ATTEMPTS?: string;
  readonly VITE_WS_RECONNECT_JITTER_RATIO?: string;
  readonly VITE_WS_CONNECTION_TIMEOUT_MS?: string;
  readonly VITE_WS_HEARTBEAT_INTERVAL_MS?: string;
  readonly VITE_WS_HEARTBEAT_TIMEOUT_MS?: string;
  readonly VITE_WS_MAX_BUFFERED_AMOUNT_BYTES?: string;
  readonly VITE_SENTENCE_SILENCE_MS?: string;
  readonly VITE_SENTENCE_MAX_DURATION_MS?: string;
  readonly VITE_SENTENCE_MAX_CHARS_JA?: string;
  readonly VITE_SENTENCE_MAX_CHARS_EN?: string;
  readonly VITE_SUMMARY_SENTENCE_BATCH_SIZE?: string;
  /** @deprecated Use VITE_TRANSCRIPTION_PROVIDER. */
  readonly VITE_STT_PROVIDER?: 'auto' | 'browser' | 'mock';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
