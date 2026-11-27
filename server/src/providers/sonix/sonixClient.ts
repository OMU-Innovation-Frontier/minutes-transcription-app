import { setTimeout as delay } from 'node:timers/promises';
import type { WireLanguage } from '../../../../shared/protocol.js';
import { ServerProviderError } from '../types.js';

const API_URL = 'https://api.sonix.ai/v1';
const PENDING_STATUSES = new Set(['preparing', 'transcribing', 'aligning']);

interface SonixTurn {
  speakerLabel: string;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
}

export async function transcribeWithSonix(
  fetcher: typeof fetch, key: string, wav: Blob, language: WireLanguage, signal: AbortSignal,
  waitForPoll: (signal: AbortSignal) => Promise<void> = (signal) => delay(12_000, undefined, { signal }),
): Promise<SonixTurn[]> {
  async function request(path: string, body?: FormData): Promise<Record<string, unknown>> {
    const response = await fetcher(API_URL + path, {
      method: body ? 'POST' : 'GET', body, headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 402 || response.status === 403) {
        throw new ServerProviderError('sonix_authorization', false, 'SonixのAPIキーと利用権限を確認してください。');
      }
      if (response.status === 429) {
        throw new ServerProviderError('sonix_rate_limit', false, 'Sonixの利用上限に達しました。');
      }
      throw sonixError();
    }
    return record(await response.json());
  }

  const form = new FormData();
  form.set('file', wav, 'recording.wav');
  form.set('language', language);
  let media = await request('/media', form);
  let path = mediaPath(media.id);
  let usingDuplicate = false;
  if (media.status === 'duplicate') {
    path = mediaPath(media.duplicate_media_id);
    media = await request(path);
    usingDuplicate = true;
  }
  while (typeof media.status === 'string' && PENDING_STATUSES.has(media.status)) {
    await waitForPoll(signal);
    media = await request(path);
  }
  if (media.status !== 'completed' || (usingDuplicate && media.language !== language)) throw sonixError();
  return parseTurns(await request(`${path}/transcript.json`), language);
}

export function sonixError(): ServerProviderError {
  return new ServerProviderError('sonix_failed', false, 'Sonixの文字起こし結果を取得できませんでした。');
}

function parseTurns(result: Record<string, unknown>, language: WireLanguage): SonixTurn[] {
  if (!Array.isArray(result.transcript)) throw sonixError();
  const speakers = new Map<string, string>();
  const paragraphs = result.transcript.map((value: unknown) => {
    const entry = record(value);
    const startTimeMs = milliseconds(entry.start_time);
    const endTimeMs = milliseconds(entry.end_time);
    if (endTimeMs < startTimeMs || !Array.isArray(entry.words)
      || (entry.speaker != null && typeof entry.speaker !== 'string')) throw sonixError();
    return { startTimeMs, endTimeMs, speaker: entry.speaker?.trim(), words: entry.words as unknown[] };
  }).sort((left, right) => left.startTimeMs - right.startTimeMs);
  const turns: SonixTurn[] = [];
  for (const paragraph of paragraphs) {
    let text = '';
    let startTimeMs = paragraph.startTimeMs;
    let endTimeMs = startTimeMs;
    let speakerLabel: string | undefined;
    for (const value of paragraph.words) {
      const word = record(value);
      if (typeof word.text !== 'string') throw sonixError();
      const token = word.text.trim();
      if (!token) continue;
      const wordStart = milliseconds(word.start_time);
      const wordEnd = milliseconds(word.end_time);
      if (wordEnd < wordStart || token.length > 3_000) throw sonixError();
      speakerLabel ??= labelFor(paragraph.speaker, speakers);
      const separator = language === 'en' || /[\p{Script=Latin}\d]$/u.test(text) && /^[\p{Script=Latin}\d]/u.test(token) ? ' ' : '';
      if (text.length + separator.length + token.length > 3_000) {
        turns.push({ speakerLabel, text, startTimeMs, endTimeMs });
        text = '';
        startTimeMs = wordStart;
        endTimeMs = wordStart;
      }
      text += text ? separator + token : token;
      endTimeMs = Math.max(endTimeMs, wordEnd);
    }
    if (speakerLabel) turns.push({ speakerLabel, text, startTimeMs, endTimeMs: Math.max(endTimeMs, paragraph.endTimeMs) });
  }
  return turns;
}

function labelFor(speaker: string | undefined, speakers: Map<string, string>): string {
  if (!speaker) return '話者不明';
  const existing = speakers.get(speaker);
  if (existing) return existing;
  let suffix = '';
  for (let index = speakers.size + 1; index > 0; index = Math.floor((index - 1) / 26)) {
    suffix = String.fromCharCode(65 + (index - 1) % 26) + suffix;
  }
  const label = `話者${suffix}`;
  speakers.set(speaker, label);
  return label;
}

function mediaPath(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw sonixError();
  return `/media/${id}`;
}

function milliseconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86_400) throw sonixError();
  return Math.round(value * 1_000);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw sonixError();
  return value as Record<string, unknown>;
}
