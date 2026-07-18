import { resolve } from 'node:path';
import { loadServerConfig } from '../../config.js';
import { compareRealtimeDebugAudio } from './realtimeAudioComparison.js';

async function main(): Promise<void> {
  if (process.env.STT_EXTERNAL_ENABLED?.trim().toLowerCase() === 'true') {
    throw new Error('The Local Whisper comparison refuses to run while external STT is enabled.');
  }
  const argumentsWithoutFlags = process.argv.slice(2).filter((value) => !value.startsWith('--'));
  const wavArgument = argumentsWithoutFlags[0];
  if (!wavArgument) throw new Error('Pass one saved Local Whisper debug WAV path.');
  const showTranscript = process.argv.slice(2).includes('--show-transcript');
  const config = loadServerConfig();
  const localRoot = resolve(process.cwd(), 'server/data/local-stt');
  const debugAudioDirectory = resolve(process.cwd(), config.localSttDebugAudioDirectory);
  const result = await compareRealtimeDebugAudio({
    wavPath: resolve(wavArgument),
    localRoot,
    debugAudioDirectory,
    timeoutMs: config.localSttProcessTimeoutMs,
    showTranscript,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.classification === 'runtime-error' || result.classification === 'invalid-audio'
    || result.classification === 'audio-mismatch') {
    process.exitCode = 1;
  }
}

await main();
