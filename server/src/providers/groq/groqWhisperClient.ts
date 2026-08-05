import type { WireLanguage } from '../../../../shared/protocol.js';
import { ServerProviderError } from '../types.js';

export const GROQ_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TRANSCRIPT_CHARS = 100_000;

export interface GroqWhisperClientOptions {
  apiKey?: string;
  externalEnabled: boolean;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class GroqWhisperClient {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: GroqWhisperClientOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
  }

  assertConfigured(): void {
    if (!this.options.externalEnabled) throw groqError('groq_external_disabled', false);
    if (!this.options.apiKey?.trim()) throw groqError('groq_api_key_missing', false);
  }

  async transcribe(wav: Uint8Array, language: WireLanguage, signal?: AbortSignal): Promise<string> {
    this.assertConfigured();
    if (language !== 'ja' && language !== 'en') throw groqError('groq_language_unsupported', false);

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.options.timeoutMs);
    try {
      const body = new FormData();
      body.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
      body.append('model', GROQ_WHISPER_MODEL);
      body.append('language', language);
      body.append('response_format', 'json');
      body.append('temperature', '0');
      const response = await this.fetchImplementation(GROQ_TRANSCRIPTION_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw mapHttpError(response.status);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json')) throw groqError('groq_response_invalid', false);
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw groqError('groq_response_too_large', false);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw groqError('groq_response_too_large', false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw groqError('groq_response_invalid', false);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw groqError('groq_response_invalid', false);
      const text = (parsed as Record<string, unknown>).text;
      if (typeof text !== 'string') throw groqError('groq_response_invalid', false);
      const normalized = text.trim();
      if (!normalized) throw groqError('groq_transcript_empty', false);
      if (normalized.length > MAX_TRANSCRIPT_CHARS) throw groqError('groq_transcript_too_large', false);
      return normalized;
    } catch (error) {
      if (error instanceof ServerProviderError) throw error;
      if (controller.signal.aborted) {
        throw groqError(signal?.aborted ? 'groq_request_cancelled' : 'groq_request_timeout', true);
      }
      throw groqError('groq_request_failed', true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function mapHttpError(status: number): ServerProviderError {
  if (status === 401 || status === 403) return groqError('groq_auth_failed', false);
  if (status === 413) return groqError('groq_audio_too_large', false);
  if (status === 429) return groqError('groq_rate_limited', true);
  return groqError('groq_request_failed', status >= 500);
}

export function groqError(code: string, retryable: boolean): ServerProviderError {
  const messages: Record<string, string> = {
    groq_external_disabled: 'Groq音声認識はサーバー設定で無効です。',
    groq_api_key_missing: 'Groq音声認識のサーバー設定が不足しています。',
    groq_language_unsupported: '指定された認識言語には対応していません。',
    groq_request_timeout: 'Groq音声認識がタイムアウトしました。',
    groq_request_cancelled: 'Groq音声認識を中止しました。',
    groq_request_failed: 'Groq音声認識リクエストに失敗しました。',
    groq_auth_failed: 'Groq音声認識の認証設定を確認できませんでした。',
    groq_audio_too_large: '音声区間がGroq音声認識の上限を超えています。',
    groq_rate_limited: 'Groq音声認識の利用上限に達しました。',
    groq_usage_limit: 'アプリ内のGroq音声利用上限に達しました。',
    groq_queue_limit: 'Groq音声認識の待機上限に達しました。',
    groq_session_inactive: 'Groq音声認識セッションは終了しています。',
    groq_session_limit: 'Groq音声認識の同時セッション上限に達しました。',
    groq_runtime_closed: 'Groq音声認識は終了処理中です。',
    groq_model_unsupported: '設定されたGroq音声認識モデルには対応していません。',
    groq_audio_format_unsupported: 'Groq音声認識には16 kHz mono PCM16音声が必要です。',
    groq_pcm_invalid: '受信したPCM音声が不正です。',
    groq_vad_configuration_invalid: 'Groq音声認識の発話検出設定が不正です。',
    groq_stop_timeout: 'Groq音声認識の終了待機がタイムアウトしました。',
    groq_recognition_failed: 'Groq音声認識に失敗しました。',
    groq_response_invalid: 'Groq音声認識の応答を検証できませんでした。',
    groq_response_too_large: 'Groq音声認識の応答が上限を超えています。',
    groq_transcript_empty: 'Groq音声認識から文字起こし結果を取得できませんでした。',
    groq_transcript_too_large: 'Groq音声認識の文字起こし結果が上限を超えています。',
  };
  return new ServerProviderError(code, retryable, messages[code] ?? 'Groq音声認識に失敗しました。');
}
