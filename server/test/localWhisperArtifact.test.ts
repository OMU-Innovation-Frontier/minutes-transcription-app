// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  requireLocalWhisperArtifactSha256,
  resolveConfiguredLocalWhisperArtifact,
  resolveLocalWhisperArtifact,
  validateLocalWhisperArtifact,
  WINDOWS_WHISPER_CLI_SHA256,
} from '../src/providers/local/localWhisperArtifact';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Local Whisper platform artifact selection', () => {
  const binaryRoot = resolve('server/data/local-stt/bin');

  it('keeps the verified Windows artifact as the Windows default', () => {
    expect(resolveLocalWhisperArtifact({ binaryRoot, platform: 'win32' })).toEqual({
      executablePath: resolve(binaryRoot, 'v1.9.1/Release/whisper-cli.exe'),
      expectedSha256: WINDOWS_WHISPER_CLI_SHA256,
    });
  });

  it('uses the executable without an exe suffix on macOS and requires an explicit hash', () => {
    expect(resolveLocalWhisperArtifact({ binaryRoot, platform: 'darwin' })).toEqual({
      executablePath: resolve(binaryRoot, 'v1.9.1/whisper-cli'),
      expectedSha256: undefined,
    });
  });

  it('accepts an explicitly verified executable on every platform', () => {
    const hash = 'a'.repeat(64);
    expect(resolveLocalWhisperArtifact({
      binaryRoot,
      platform: 'darwin',
      executablePath: 'server/data/local-stt/bin/custom/whisper-cli',
      executableSha256: hash.toUpperCase(),
    })).toEqual({
      executablePath: resolve('server/data/local-stt/bin/custom/whisper-cli'),
      expectedSha256: hash,
    });
  });

  it('reads a verified custom artifact from the shared environment contract', () => {
    const hash = 'b'.repeat(64);
    expect(resolveConfiguredLocalWhisperArtifact(binaryRoot, {
      LOCAL_STT_EXECUTABLE: 'server/data/local-stt/bin/custom/whisper-cli',
      LOCAL_STT_EXECUTABLE_SHA256: hash,
    }, 'darwin')).toEqual({
      executablePath: resolve('server/data/local-stt/bin/custom/whisper-cli'),
      expectedSha256: hash,
    });
  });

  it('requires an explicit integrity hash for non-Windows defaults', () => {
    const artifact = resolveLocalWhisperArtifact({ binaryRoot, platform: 'darwin' });
    expect(() => requireLocalWhisperArtifactSha256(artifact))
      .toThrow(/LOCAL_STT_EXECUTABLE_SHA256 is required/u);
  });

  it('validates a configured executable inside the binary root against its SHA-256', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'minutes-whisper-artifact-'));
    temporaryDirectories.push(root);
    const executablePath = resolve(root, 'v1.9.1/whisper-cli');
    await mkdir(resolve(root, 'v1.9.1'), { recursive: true });
    await writeFile(executablePath, 'verified executable fixture');
    const expectedSha256 = createHash('sha256').update('verified executable fixture').digest('hex');
    await expect(validateLocalWhisperArtifact({ executablePath, expectedSha256 }, root))
      .resolves.toBe(await realpath(executablePath));
    await expect(validateLocalWhisperArtifact({ executablePath, expectedSha256: '0'.repeat(64) }, root))
      .rejects.toMatchObject({ code: 'local_executable_hash_mismatch' });
  });

  it('rejects a configured executable outside the binary root before hashing it', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'minutes-whisper-root-'));
    const outside = await mkdtemp(resolve(tmpdir(), 'minutes-whisper-outside-'));
    temporaryDirectories.push(root, outside);
    const executablePath = resolve(outside, 'whisper-cli');
    await writeFile(executablePath, 'outside fixture');
    await expect(validateLocalWhisperArtifact({
      executablePath,
      expectedSha256: createHash('sha256').update('outside fixture').digest('hex'),
    }, root)).rejects.toMatchObject({ code: 'local_executable_missing' });
  });

  it('rejects malformed configured hashes', () => {
    expect(() => resolveLocalWhisperArtifact({
      binaryRoot,
      executableSha256: 'not-a-sha256',
    })).toThrow(/64-character SHA-256/u);
  });
});
