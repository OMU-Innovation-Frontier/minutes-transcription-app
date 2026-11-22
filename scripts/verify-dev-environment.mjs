import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile?.(resolve(repoRoot, '.env')); } catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

console.log('Minutes Transcription App - read-only development environment check');
console.log(`Repository: ${repoRoot}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log('No files, settings, ports, or processes are changed by this script.\n');

writeCheck('Node.js', true, process.version);
for (const command of ['npm', 'pnpm', 'git']) {
  const version = commandVersion(command);
  writeCheck(command, Boolean(version), version ?? 'not on the current PATH');
}

console.log('');
for (const path of ['package.json', 'pnpm-lock.yaml', 'node_modules', '.env', '.env.example', 'src', 'server/src', 'server/test', 'shared', 'docs', 'scripts']) {
  writeCheck(path, existsSync(resolve(repoRoot, path)));
}

console.log('');
const localEngine = process.env.LOCAL_STT_ENGINE?.trim() === 'mlx-whisper' ? 'mlx-whisper' : 'whisper-cpp';
writeCheck('Local Whisper engine', true, localEngine);
if (localEngine === 'mlx-whisper') {
  const pythonPath = resolve(repoRoot, process.env.LOCAL_STT_MLX_PYTHON?.trim()
    || 'server/data/local-stt/mlx/venv/bin/python3');
  const modelDirectory = resolve(repoRoot, process.env.LOCAL_STT_MLX_MODEL_DIR?.trim()
    || 'server/data/local-stt/models/mlx/whisper-large-v3-turbo');
  writeArtifact('MLX Python executable', pythonPath, process.env.LOCAL_STT_MLX_PYTHON_SHA256?.trim());
  writeArtifact(
    'MLX Whisper large-v3-turbo weights',
    resolve(modelDirectory, 'weights.safetensors'),
    process.env.LOCAL_STT_MLX_MODEL_SHA256?.trim()
      || '951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6',
  );
} else {
  const modelPath = resolve(repoRoot, 'server/data/local-stt/models/ggml-small-q5_1.bin');
  writeArtifact('Local Whisper small model', modelPath);
  const defaultExecutable = process.platform === 'win32'
    ? 'server/data/local-stt/bin/v1.9.1/Release/whisper-cli.exe'
    : 'server/data/local-stt/bin/v1.9.1/whisper-cli';
  const executablePath = resolve(repoRoot, process.env.LOCAL_STT_EXECUTABLE?.trim() || defaultExecutable);
  writeArtifact('Local Whisper executable', executablePath, process.env.LOCAL_STT_EXECUTABLE_SHA256?.trim());
}

console.log('');
for (const port of [5173, 8787]) {
  const inUse = await isPortInUse(port);
  console.log(`[${inUse ? 'IN USE' : 'FREE'}] port ${port}`);
}

console.log('\nMissing Local Whisper artifacts do not block Browser, Mock, or WebSocket Mock development.');
console.log('This script never downloads or installs software.');

function commandVersion(command) {
  // Windows package-manager launchers are .cmd scripts, not native executables.
  // Commands are constants from the allowlist in the caller; no user input reaches cmd.exe.
  const useCommandInterpreter = process.platform === 'win32' && (command === 'npm' || command === 'pnpm');
  const result = useCommandInterpreter
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `${command}.cmd --version`], { encoding: 'utf8', shell: false })
    : spawnSync(command, ['--version'], { encoding: 'utf8', shell: false });
  return result.status === 0 ? (result.stdout || result.stderr).trim().split(/\r?\n/u)[0] : undefined;
}

function writeCheck(name, available, detail = '') {
  console.log(`[${available ? 'OK' : 'MISSING'}] ${name}${detail ? `: ${detail}` : ''}`);
}

function writeArtifact(name, path, expectedHash) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    writeCheck(name, false, 'not present (Mock development remains available)');
    return;
  }
  const size = statSync(path).size;
  const hash = hashFile(path);
  const verified = expectedHash ? hash === expectedHash.toLowerCase() : undefined;
  const verification = verified === undefined ? 'expected SHA-256 is not configured' : verified ? 'SHA-256 matches' : 'SHA-256 MISMATCH';
  writeCheck(name, verified !== false, `${path}; ${(size / 1024 / 1024).toFixed(2)} MB; SHA256=${hash}; ${verification}`);
}

function hashFile(path) {
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

function isPortInUse(port) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolveResult(true); });
    socket.once('timeout', () => { socket.destroy(); resolveResult(false); });
    socket.once('error', () => resolveResult(false));
  });
}
