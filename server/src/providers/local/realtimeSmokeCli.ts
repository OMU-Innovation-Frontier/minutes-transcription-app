import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AudioFrameMetadata } from '../../../../shared/protocol.js';
import { loadServerConfig } from '../../config.js';
import { inspectPcm16Mono16kWavQuality } from './audioConverter.js';
import { LocalWhisperRuntime } from './localWhisperRuntime.js';
import { LOCAL_PCM_MIME_TYPE, LocalWhisperServerProvider } from './localWhisperServerProvider.js';
import { RealtimeDebugAudioStore } from './realtimeDebugAudio.js';

const SAMPLE_RATE = 16_000;
const SMOKE_AUDIO_SECONDS = 10;

async function main(): Promise<void> {
  if (process.env.STT_EXTERNAL_ENABLED?.trim().toLowerCase() === 'true') {
    throw new Error('The local smoke test refuses to run while external STT is enabled.');
  }
  const repositoryRoot = process.cwd();
  const config = loadServerConfig();
  const localRoot = resolve(repositoryRoot, 'server/data/local-stt');
  const inputRoot = resolve(localRoot, 'input');
  const inputPath = resolve(inputRoot, 'ja.wav');
  const quality = await inspectPcm16Mono16kWavQuality(inputPath, [inputRoot]);
  const wav = await readFile(inputPath);
  const pcm = readPcmData(wav).subarray(0, Math.min(
    quality.dataBytes,
    SAMPLE_RATE * SMOKE_AUDIO_SECONDS * 2,
  ));
  if (pcm.byteLength < SAMPLE_RATE * 2) throw new Error('The smoke-test audio is too short.');

  const debugAudioStore = new RealtimeDebugAudioStore({
    enabled: config.localSttDebugAudio,
    localRoot,
    directory: resolve(repositoryRoot, config.localSttDebugAudioDirectory),
    maxFiles: config.localSttDebugAudioMaxFiles,
    maxBytes: config.localSttDebugAudioMaxBytes,
  });
  const runtime = new LocalWhisperRuntime({
    enabled: true,
    modelId: 'small-q5_1',
    root: localRoot,
    threads: 4,
    maxQueueSize: 10,
    maxSessions: 1,
    processTimeoutMs: 120_000,
    debugAudioStore,
  });
  const provider = new LocalWhisperServerProvider(runtime, {
    vad: {
      sampleRate: SAMPLE_RATE,
      silenceDurationMs: 1_300,
      maxUtteranceDurationMs: 20_000,
      minimumUtteranceDurationMs: 300,
      preSpeechBufferMs: 300,
      rmsThreshold: 0.012,
      noiseFloorMultiplier: 3,
    },
  });
  const transcripts: string[] = [];
  const errors: string[] = [];
  let segmentCount = 0;
  let lastMetrics: { audioDurationMs?: number; processingTimeMs?: number; realTimeFactor?: number } = {};
  provider.onTranscript((result) => {
    transcripts.push(result.text);
    segmentCount += result.segments?.length ?? 0;
  });
  provider.onError((error) => errors.push(error.code));
  provider.onStatus((status) => {
    if (status.state === 'completed') {
      lastMetrics = {
        audioDurationMs: status.audioDurationMs,
        processingTimeMs: status.processingTimeMs,
        realTimeFactor: status.realTimeFactor,
      };
    }
  });

  const sessionId = 'local-whisper-smoke';
  try {
    await provider.startSession({ sessionId, language: 'ja', mimeType: LOCAL_PCM_MIME_TYPE });
    const bytesPerChunk = SAMPLE_RATE * 2;
    let sequence = 0;
    for (let offset = 0; offset < pcm.byteLength; offset += bytesPerChunk) {
      const chunk = pcm.subarray(offset, Math.min(offset + bytesPerChunk, pcm.byteLength));
      const metadata: AudioFrameMetadata = {
        capturedAt: Date.now(), sampleRate: SAMPLE_RATE, channels: 1,
        encoding: 'pcm_s16le', frameCount: chunk.byteLength / 2,
      };
      await provider.sendAudio({ sessionId, sequence, audio: chunk, metadata });
      sequence += 1;
    }
    await provider.stopSession(sessionId);
    if (errors.length > 0) throw new Error(`Local Whisper smoke test failed safely: ${errors.join(',')}`);
    if (transcripts.length === 0 || segmentCount === 0) {
      throw new Error('Local Whisper returned no timestamped final transcript.');
    }
    const transcriptDigest = createHash('sha256').update(transcripts.join('\n'), 'utf8').digest('hex');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: provider.id,
      model: 'whisper-small-q5_1',
      externalCommunication: false,
      sourceAudioDurationMs: quality.durationMs,
      smokeAudioDurationMs: pcm.byteLength / 2 / SAMPLE_RATE * 1_000,
      finalTranscriptCount: transcripts.length,
      segmentCount,
      transcriptSha256: transcriptDigest,
      debugAudioEnabled: debugAudioStore.enabled,
      debugWavFileName: debugAudioStore.getSavedCaptures().at(-1)?.fileName ?? null,
      debugMetadataFileName: debugAudioStore.getSavedCaptures().at(-1)?.metadataPath.split(/[\\/]/u).at(-1) ?? null,
      ...lastMetrics,
    })}\n`);
  } finally {
    await provider.dispose();
    await runtime.close();
  }
}

function readPcmData(wav: Buffer): Buffer {
  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkBytes = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkBytes > wav.byteLength) throw new Error('Invalid WAV chunk size.');
    if (chunkId === 'data') return wav.subarray(chunkStart, chunkStart + chunkBytes);
    offset = chunkStart + chunkBytes + chunkBytes % 2;
  }
  throw new Error('WAV data chunk was not found.');
}

await main();
