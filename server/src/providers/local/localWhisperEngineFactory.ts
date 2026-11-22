import { resolve } from 'node:path';
import type { ServerConfig } from '../../config.js';
import type { LocalWhisperEngine } from './localWhisperEngine.js';
import { MlxWhisperEngine } from './mlxWhisperEngine.js';
import { WhisperCppEngine } from './whisperCppEngine.js';

export function createLocalWhisperEngine(
  config: ServerConfig,
  localRoot: string,
): LocalWhisperEngine {
  if (config.localSttEngine === 'mlx-whisper') {
    return new MlxWhisperEngine({
      root: localRoot,
      modelId: config.localSttModel,
      pythonPath: config.localSttMlxPython,
      pythonSha256: config.localSttMlxPythonSha256,
      modelPath: config.localSttMlxModelDirectory,
      modelSha256: config.localSttMlxModelSha256,
      workerPath: resolve(process.cwd(), 'server/scripts/mlx_whisper_worker.py'),
      startupTimeoutMs: config.localSttProcessTimeoutMs,
    });
  }
  return new WhisperCppEngine({
    root: localRoot,
    modelId: config.localSttModel,
    threads: config.localSttThreads,
    executablePath: config.localSttExecutable,
    executableSha256: config.localSttExecutableSha256,
  });
}
