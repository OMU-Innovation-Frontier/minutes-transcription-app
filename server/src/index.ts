import { loadServerConfig } from './config.js';
import { createTranscriptionServer } from './server.js';

try {
  process.loadEnvFile?.();
} catch (error) {
  if (!isMissingEnvFile(error)) throw error;
}

const config = loadServerConfig();
if (config.localSttDebugAudio) {
  console.warn(
    `[local-whisper] development audio saving is enabled (maxFiles=${config.localSttDebugAudioMaxFiles}, maxBytes=${config.localSttDebugAudioMaxBytes}).`,
  );
}
const server = createTranscriptionServer({ config });
const address = await server.start();
console.info(`STT server listening on http://${address.address}:${address.port}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.stop();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

function isMissingEnvFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
