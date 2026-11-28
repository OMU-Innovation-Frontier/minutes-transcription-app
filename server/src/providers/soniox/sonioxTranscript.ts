import type { WireLanguage } from '../../../../shared/protocol.js';
import { ServerProviderError, type SttTranscriptResult } from '../types.js';

interface Token { text: string; final: boolean; start?: number; end?: number; speaker?: string }
interface Span { text: string; start: number; end: number; speaker?: string }

const errors = {
  format: 'Sonioxの録音形式を確認してください。',
  connect: 'MinutesのサーバーからSonioxへの接続を開始できませんでした。',
  connect_timeout: 'MinutesのサーバーからSonioxへの接続がタイムアウトしました。',
  upgrade: 'SonioxへのWebSocket接続を確立できませんでした。',
  start: 'Sonioxに文字起こしの開始設定を送れませんでした。',
  closed_before_audio: '音声送信前にSonioxとの接続が切れました。',
  closed_during_audio: '音声送信中にSonioxとの接続が切れました。',
  closed_before_finish: '文字起こしの確定前にSonioxとの接続が切れました。',
  send_audio: 'Sonioxに音声データを送れませんでした。',
  authorization: 'SonioxのAPIキーとストリーミングの利用権限を確認してください。',
  billing: 'Sonioxの残高または月間予算の上限を確認してください。',
  limit: 'Sonioxの利用上限に達しました。',
  result: 'Sonioxの文字起こし結果を処理できませんでした。',
  timeout: 'Sonioxの最後の発言を時間内に受信できませんでした。',
};

export function sonioxError(code: keyof typeof errors, status?: number): ServerProviderError {
  const suffix = status !== undefined && Number.isInteger(status) && status >= 100 && status <= 4999 ? `（コード ${status}）` : '';
  return new ServerProviderError(`soniox_${code}`, false, `${errors[code]}${suffix}`);
}

export function sonioxStatusError(status: number | undefined): ServerProviderError | undefined {
  if (status === 401 || status === 403) return sonioxError('authorization', status);
  if (status === 402) return sonioxError('billing', status);
  if (status === 429) return sonioxError('limit', status);
  return undefined;
}

export function parseSonioxResult(data: unknown): { tokens: Token[]; finished: boolean } | undefined {
  if (typeof data !== 'string' || data.length > 1_000_000) throw sonioxError('result');
  const value = record(JSON.parse(data));
  if (value.type === 'pong') return undefined;
  if (value.error_code !== undefined) {
    const status = typeof value.error_code === 'number' ? value.error_code : undefined;
    throw sonioxStatusError(status) ?? sonioxError('result', status);
  }
  if (value.tokens === undefined && value.finished === true) return { tokens: [], finished: true };
  if (!Array.isArray(value.tokens) || value.tokens.length > 5_000) throw sonioxError('result');
  return {
    tokens: value.tokens.map((item: unknown) => {
      const token = record(item);
      if (typeof token.text !== 'string' || token.text.length > 3_000 || typeof token.is_final !== 'boolean'
        || (token.speaker !== undefined && (typeof token.speaker !== 'string' || token.speaker.length > 128))) throw sonioxError('result');
      const start = timestamp(token.start_ms);
      const end = timestamp(token.end_ms);
      if (start !== undefined && end !== undefined && end < start) throw sonioxError('result');
      return { text: token.text, final: token.is_final, start, end, speaker: token.speaker };
    }),
    finished: value.finished === true,
  };
}

export class SonioxTranscript {
  private offset?: number;
  private position = 0;
  private current?: Span;
  private readonly labels = new Map<string, string>();
  private sequence = 0;
  private revision = 0;
  private lastDraft = '';

  constructor(
    private readonly sessionId: string, private readonly language: WireLanguage, private readonly model: string,
    private readonly publish: (result: SttTranscriptResult) => void,
  ) {}

  setAudioStart(timestamp: number): void { this.offset ??= Math.max(0, timestamp); }

  apply(tokens: Token[], finished: boolean): void {
    const provisional: Token[] = [];
    for (const token of tokens) {
      if (token.text === '<end>' || token.text === '<fin>') {
        if (token.final) this.flush();
        continue;
      }
      if (!token.final) { provisional.push(token); continue; }
      const speaker = token.speaker || this.current?.speaker;
      if (this.current && (speaker !== this.current.speaker || this.current.text.length + token.text.length > 3_000)) this.flush();
      const start = token.start ?? this.position;
      const end = Math.max(start, token.end ?? start);
      this.current ??= { speaker, start, end, text: '' };
      this.current.text += token.text;
      this.current.end = Math.max(this.current.end, end);
      this.position = Math.max(this.position, end);
      if (/[。！？.!?][」』”"]?\s*$/u.test(this.current.text) || this.current.end - this.current.start >= 10_000) this.flush();
    }
    if (finished) this.flush();

    const draft = finished ? '' : this.draft(provisional);
    if (draft !== this.lastDraft) {
      this.lastDraft = draft;
      this.publish({ sessionId: this.sessionId, segmentId: 'soniox-preview', revision: ++this.revision,
        text: draft, isFinal: false, language: this.language, provider: 'soniox', model: this.model,
        startTime: (this.offset ?? 0) + (this.current?.start ?? this.position) });
    }
  }

  private draft(tokens: Token[]): string {
    const labels = new Map(this.labels);
    const lines: { speaker?: string; text: string }[] = this.current ? [{ ...this.current }] : [];
    for (const token of tokens) {
      const last = lines.at(-1);
      const speaker = token.speaker || last?.speaker;
      if (last && last.speaker === speaker) last.text += token.text;
      else lines.push({ speaker, text: token.text });
    }
    return lines.filter(({ text }) => text.trim()).map(({ text, speaker }) =>
      `${speakerLabel(speaker, labels)}\u3000${text.trim()}`).join('\n').slice(0, 3_000);
  }

  private flush(): void {
    const span = this.current;
    this.current = undefined;
    if (!span?.text.trim()) return;
    this.publish({ sessionId: this.sessionId, segmentId: `soniox-${++this.sequence}`, revision: 1,
      text: span.text.trim(), isFinal: true, language: this.language, provider: 'soniox', model: this.model,
      speakerLabel: speakerLabel(span.speaker, this.labels),
      startTime: (this.offset ?? 0) + span.start, endTime: (this.offset ?? 0) + span.end });
  }
}

function speakerLabel(speaker: string | undefined, labels: Map<string, string>): string {
  if (!speaker || labels.size >= 26 && !labels.has(speaker)) return '話者不明';
  const previous = labels.get(speaker);
  if (previous) return previous;
  const label = `話者${String.fromCharCode(65 + labels.size)}`;
  labels.set(speaker, label);
  return label;
}

function record(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw sonioxError('result');
  return data as Record<string, unknown>;
}

function timestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86_400_000) throw sonioxError('result');
  return value;
}
