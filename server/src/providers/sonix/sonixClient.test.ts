// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { transcribeWithSonix } from './sonixClient.js';

const audio = new Blob(['synthetic'], { type: 'audio/wav' });
const testKey = String();
const signal = new AbortController().signal;

function paragraph(speaker: string | null, text: string, start_time: number) {
  const end_time = start_time + 0.5;
  return { speaker, start_time, end_time, words: [{ text, start_time, end_time }] };
}

describe('Sonix transcript API', () => {
  it('uploads once, waits for completion, and labels returning speakers by first appearance', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'synthetic', status: 'preparing' }))
      .mockResolvedValueOnce(Response.json({ id: 'synthetic', status: 'completed' }))
      .mockResolvedValueOnce(Response.json({ transcript: [
        paragraph('source-1', '三番目', 5),
        paragraph('source-1', '一番目', 0),
        paragraph('source-2', '二番目', 3),
        paragraph(null, '四番目', 7),
      ] }));
    const wait = vi.fn(async () => undefined);

    expect(await transcribeWithSonix(fetcher, testKey, audio, 'ja', signal, wait)).toEqual([
      { speakerLabel: '話者A', text: '一番目', startTimeMs: 0, endTimeMs: 500 },
      { speakerLabel: '話者B', text: '二番目', startTimeMs: 3000, endTimeMs: 3500 },
      { speakerLabel: '話者A', text: '三番目', startTimeMs: 5000, endTimeMs: 5500 },
      { speakerLabel: '話者不明', text: '四番目', startTimeMs: 7000, endTimeMs: 7500 },
    ]);
    expect(wait).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method])).toEqual([
      ['/v1/media', 'POST'], ['/v1/media/synthetic', 'GET'], ['/v1/media/synthetic/transcript.json', 'GET'],
    ]);
    const form = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get('language')).toBe('ja');
    expect(form.get('file')).toMatchObject({ name: 'recording.wav', type: 'audio/wav' });
  });

  it('rejects invalid response data before publishing any transcript', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'synthetic', status: 'completed' }))
      .mockResolvedValueOnce(Response.json({ transcript: [
        paragraph('source-1', '合成データ', 0), { speaker: 'source-2', start_time: -1 },
      ] }));
    await expect(transcribeWithSonix(fetcher, testKey, audio, 'ja', signal)).rejects.toMatchObject({ code: 'sonix_failed' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops on API authorization errors without exposing the response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: 'synthetic detail' }, { status: 401 }));
    await expect(transcribeWithSonix(fetcher, testKey, audio, 'ja', signal)).rejects.toMatchObject({
      code: 'sonix_authorization', safeMessage: 'SonixのAPIキーと利用権限を確認してください。',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
