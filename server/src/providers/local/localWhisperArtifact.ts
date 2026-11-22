import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { validateExistingFile } from './localProcessManager.js';
import { LocalSttError } from './localSttTypes.js';

export const WINDOWS_WHISPER_CLI_SHA256 = '58245314fb73b30fbd0cf0542c5c172e23f02b6eb7cad7b51e792439cf5e1755';

export interface LocalWhisperArtifact {
  executablePath: string;
  expectedSha256?: string;
}

export function resolveConfiguredLocalWhisperArtifact(
  binaryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LocalWhisperArtifact {
  return resolveLocalWhisperArtifact({
    binaryRoot,
    executablePath: env.LOCAL_STT_EXECUTABLE,
    executableSha256: env.LOCAL_STT_EXECUTABLE_SHA256,
    platform,
  });
}

export function requireLocalWhisperArtifactSha256(artifact: LocalWhisperArtifact): string {
  if (!artifact.expectedSha256) {
    throw new LocalSttError(
      'local_executable_hash_missing',
      'LOCAL_STT_EXECUTABLE_SHA256 is required for this Local Whisper executable.',
    );
  }
  return artifact.expectedSha256;
}

export async function validateLocalWhisperArtifact(
  artifact: LocalWhisperArtifact,
  binaryRoot: string,
): Promise<string> {
  const expectedSha256 = requireLocalWhisperArtifactSha256(artifact);
  const executablePath = await validateExistingFile(
    artifact.executablePath,
    [binaryRoot],
    'local_executable_missing',
    'The whisper.cpp executable is missing or outside the configured binary directory.',
  );
  const actualSha256 = await hashFile(executablePath);
  if (actualSha256 !== expectedSha256) {
    throw new LocalSttError(
      'local_executable_hash_mismatch',
      'The whisper.cpp executable failed integrity verification.',
    );
  }
  return executablePath;
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export function resolveLocalWhisperArtifact(options: {
  binaryRoot: string;
  executablePath?: string;
  executableSha256?: string;
  platform?: NodeJS.Platform;
}): LocalWhisperArtifact {
  const platform = options.platform ?? process.platform;
  const configuredPath = options.executablePath?.trim();
  const configuredSha256 = options.executableSha256?.trim().toLowerCase();
  if (configuredSha256 && !/^[a-f0-9]{64}$/u.test(configuredSha256)) {
    throw new LocalSttError(
      'local_executable_hash_invalid',
      'LOCAL_STT_EXECUTABLE_SHA256 must be a 64-character SHA-256 value.',
    );
  }

  if (configuredPath) {
    return {
      executablePath: resolve(configuredPath),
      expectedSha256: configuredSha256,
    };
  }

  if (platform === 'win32') {
    return {
      executablePath: resolve(options.binaryRoot, 'v1.9.1/Release/whisper-cli.exe'),
      expectedSha256: configuredSha256 ?? WINDOWS_WHISPER_CLI_SHA256,
    };
  }

  return {
    executablePath: resolve(options.binaryRoot, 'v1.9.1/whisper-cli'),
    expectedSha256: configuredSha256,
  };
}
