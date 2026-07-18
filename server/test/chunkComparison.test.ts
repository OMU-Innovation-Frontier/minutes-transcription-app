// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calculateNormalizedJapaneseCharacterErrorRate } from '../src/providers/evaluationHarness';
import { inspectPcm16Mono16kWav } from '../src/providers/local/audioConverter';
import {
  assessTargetRecovery,
  assertSafeChildPath,
  deduplicateChunkTranscripts,
  parseWhisperTimestampOutput,
  removeTemporaryRunDirectory,
  splitPcm16Mono16kWav,
  validateChunkDurations,
} from '../src/providers/local/chunkComparison';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PCM WAV chunk splitting', () => {
  it('splits at exact PCM frame boundaries and retains the final short chunk', async () => {
    const fixture = await createFixture(10_000);
    const split = await splitPcm16Mono16kWav({
      sourcePath: fixture.source,
      allowedSourceRoots: [fixture.root],
      temporaryRoot: fixture.temp,
      runDirectoryName: 'three-second-chunks',
      chunkDurationMs: 3_000,
      overlapDurationMs: 0,
    });
    expect(split.boundaries.map(({ startFrame, endFrame }) => [startFrame, endFrame])).toEqual([
      [0, 48_000], [48_000, 96_000], [96_000, 144_000], [144_000, 160_000],
    ]);
    expect(split.boundaries.reduce((total, chunk) => total + chunk.frameCount, 0)).toBe(160_000);
    expect(split.boundaries.every((chunk, index) => index === 0 || chunk.startFrame === split.boundaries[index - 1]?.endFrame)).toBe(true);
    const last = split.boundaries.at(-1);
    if (!last) throw new Error('missing last chunk');
    await expect(inspectPcm16Mono16kWav(last.filePath, [split.runDirectory])).resolves.toMatchObject({ durationSeconds: 1 });
  });

  it('creates correct overlap boundaries while covering the source through its final frame', async () => {
    const fixture = await createFixture(10_000);
    const split = await splitPcm16Mono16kWav({
      sourcePath: fixture.source,
      allowedSourceRoots: [fixture.root],
      temporaryRoot: fixture.temp,
      runDirectoryName: 'overlap-chunks',
      chunkDurationMs: 4_000,
      overlapDurationMs: 1_000,
    });
    expect(split.boundaries.map(({ startFrame, endFrame }) => [startFrame, endFrame])).toEqual([
      [0, 64_000], [48_000, 112_000], [96_000, 160_000],
    ]);
    expect(split.boundaries.at(-1)?.endFrame).toBe(160_000);
    expect(split.boundaries.slice(1).every((chunk, index) =>
      (split.boundaries[index]?.endFrame ?? 0) - chunk.startFrame === 16_000)).toBe(true);
  });

  it('rejects malformed WAV input before creating chunks', async () => {
    const root = await createTemporaryDirectory();
    const temp = resolve(root, 'temp');
    await mkdir(temp);
    const source = resolve(root, 'bad.wav');
    await writeFile(source, 'not a wav');
    await expect(splitPcm16Mono16kWav({
      sourcePath: source,
      allowedSourceRoots: [root],
      temporaryRoot: temp,
      runDirectoryName: 'invalid-input',
      chunkDurationMs: 15_000,
      overlapDurationMs: 0,
    })).rejects.toMatchObject({ code: 'local_wav_format_unsupported' });
  });

  it('rejects invalid durations and overlap equal to or longer than the chunk', () => {
    expect(() => validateChunkDurations(0, 0)).toThrowError(/chunk duration/u);
    expect(() => validateChunkDurations(15_000, 15_000)).toThrowError(/chunk overlap/u);
    expect(() => validateChunkDurations(15_000, 16_000)).toThrowError(/chunk overlap/u);
  });

  it('accepts only safe temporary child paths and removes only the created run directory', async () => {
    const root = await createTemporaryDirectory();
    const child = resolve(root, 'safe-run');
    await mkdir(child);
    expect(() => assertSafeChildPath(root, child)).not.toThrow();
    expect(() => assertSafeChildPath(root, root)).toThrowError(/temporary path/u);
    expect(() => assertSafeChildPath(root, resolve(root, '..', 'outside'))).toThrowError(/temporary path/u);
    await removeTemporaryRunDirectory(child, root);
    await expect(readFile(resolve(child, 'missing'))).rejects.toBeDefined();
  });
});

describe('timestamp parsing and conservative transcript merge', () => {
  it('parses whisper.cpp segment timestamps without treating other output as a transcript', () => {
    expect(parseWhisperTimestampOutput([
      '[00:00:00.000 --> 00:00:03.250] えっと、今日は',
      'ignored diagnostic',
      '[00:00:03.250 --> 00:00:06.000] 話します',
    ].join('\n'))).toEqual([
      { startMs: 0, endMs: 3_250, text: 'えっと、今日は' },
      { startMs: 3_250, endMs: 6_000, text: '話します' },
    ]);
  });

  it('removes an exact Japanese suffix/prefix overlap and saves before/after forms', () => {
    const result = deduplicateChunkTranscripts([
      '今日は音声認識の確認を行います',
      '音声認識の確認を行いますそして結果を保存します',
    ]);
    expect(result.rawMergedTranscript).toContain('行います 音声認識');
    expect(result.deduplicatedTranscript).toBe('今日は音声認識の確認を行います そして結果を保存します');
    expect(result.removedDuplicateParts).toEqual([
      expect.objectContaining({ removedText: '音声認識の確認を行います', reason: 'exactSuffixPrefix', similarity: 1 }),
    ]);
  });

  it('does not delete non-matching adjacent text', () => {
    const result = deduplicateChunkTranscripts(['前半の文章です', '後半は別の内容です']);
    expect(result.deduplicatedTranscript).toBe('前半の文章です 後半は別の内容です');
    expect(result.removedDuplicateParts).toEqual([]);
  });

  it('distinguishes exact, normalized, partial, and missing recovery evidence', () => {
    const target = 'WebSocketでサーバーへ送ります。';
    expect(assessTargetRecovery(target, `音声を${target}終了します`).status).toBe('exactRecovered');
    expect(assessTargetRecovery(target, '音声をwebsocketでサーバーへ送ります終了します').status).toBe('substantiallyRecovered');
    expect(assessTargetRecovery(target, 'WebSocketで送ります').status).toBe('partiallyRecovered');
    expect(assessTargetRecovery(target, 'まったく異なる発話です').status).toBe('missing');
  });

  it('detects recovery of the confirmed long second target and keeps CER measurable', () => {
    const target = '最終的には、マイクから取得した音声をWebSocketでサーバーへ送り、ローカル環境で文字起こしを行います。';
    const transcript = '前の文章です。最終的にはマイクから取得した音声をweb socketでサーバーへ送りローカル環境で文字起こしを行います。次の文章です。';
    expect(assessTargetRecovery(target, transcript)).toMatchObject({ status: 'substantiallyRecovered', similarity: 1 });
    expect(calculateNormalizedJapaneseCharacterErrorRate(target, transcript)).toBeGreaterThan(0);
  });
});

async function createFixture(durationMs: number): Promise<{ root: string; temp: string; source: string }> {
  const root = await createTemporaryDirectory();
  const temp = resolve(root, 'temp');
  await mkdir(temp);
  const source = resolve(root, 'source.wav');
  await writeFile(source, createPcmWav(durationMs));
  return { root, temp, source };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'minutes-chunk-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createPcmWav(durationMs: number): Buffer {
  const frameCount = Math.round(durationMs * 16_000 / 1_000);
  const dataBytes = frameCount * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(16_000, 24);
  output.writeUInt32LE(32_000, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  return output;
}
