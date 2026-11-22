import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const largeFileThresholdBytes = 10 * 1024 * 1024;
const requiredIgnoreRules = [
  'node_modules/', 'dist/', 'coverage/', '.env', '.env.*', '!.env.example', 'server/data/',
  '*.wav', '*.mp3', '*.m4a', '*.webm', '*.flac', '*.log', 'logs/', '*-backup-*/',
  'backup/', 'backups/', '.DS_Store', 'Thumbs.db', '.vscode/', '.idea/',
];

console.log('Minutes Transcription App - read-only share readiness review');
console.log(`Repository: ${repoRoot}`);
console.log('This script lists candidates only. It never deletes, moves, edits, uploads, commits, or pushes files.');
console.log('Results can include false positives and cannot guarantee complete secret detection.\n');

const ignoreLines = existsSync(resolve(repoRoot, '.gitignore'))
  ? readFileSync(resolve(repoRoot, '.gitignore'), 'utf8').split(/\r?\n/u).map((line) => line.trim())
  : [];
console.log('[.gitignore required rules]');
for (const rule of requiredIgnoreRules) console.log(`[${ignoreLines.includes(rule) ? 'OK' : 'MISSING'}] ${rule}`);

const files = walk(repoRoot);
console.log('\n[Candidate files - names and sizes only]');
let candidateCount = 0;
for (const path of files) {
  const relativePath = relative(repoRoot, path).replaceAll('\\', '/');
  const name = relativePath.split('/').at(-1).toLowerCase();
  const extension = extname(name);
  const size = statSync(path).size;
  let category;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) category = 'local environment / possible credential';
  else if (['.wav', '.mp3', '.m4a', '.webm', '.flac'].includes(extension)) category = 'audio recording';
  else if (name === 'whisper-cli.exe' || name === 'whisper-cli' || /^ggml-.*\.bin$/u.test(name)) category = 'Whisper executable or model';
  else if (relativePath.startsWith('server/data/')) category = 'runtime, debug, evaluation, metadata, or comparison data';
  else if (extension === '.log' || relativePath.split('/').includes('logs')) category = 'log';
  else if (/(^|\/)(backup|backups)(\/|$)|-backup-|\.(bak|backup)$/iu.test(relativePath)) category = 'backup';
  else if (/(api.?key|credential|password|passwd|secret|access.?token)/iu.test(name)) category = 'sensitive-looking filename';
  else if (size >= largeFileThresholdBytes) category = 'large file >= 10 MB';
  if (category) {
    candidateCount += 1;
    console.log(`REVIEW: ${relativePath} [${category}; ${(size / 1024 / 1024).toFixed(2)} MB]`);
  }
}
if (candidateCount === 0) console.log('No filename/size candidates found.');

console.log('\n[Conservative content signals in shareable text files - filenames only]');
const textExtensions = new Set(['.ts', '.js', '.mjs', '.json', '.jsonl', '.md', '.yml', '.yaml', '.html', '.css', '.env', '.example', '.ps1', '.txt']);
const signals = [
  ['known token/private-key format', /(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)/u],
  ['email-shaped text', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u],
  ['user-specific absolute path', /([A-Z]:[\\/]Users[\\/][^\\/\s]+|\/Users\/[^/\s]+|\/home\/[^/\s]+)/iu],
];
let signalCount = 0;
for (const path of files) {
  if (/check-share-readiness\.(mjs|ps1)$/u.test(path)) continue;
  if (!textExtensions.has(extname(path).toLowerCase()) || statSync(path).size > 2 * 1024 * 1024) continue;
  const content = readFileSync(path, 'utf8');
  for (const [name, pattern] of signals) {
    if (pattern.test(content)) {
      signalCount += 1;
      console.log(`REVIEW: ${relative(repoRoot, path).replaceAll('\\', '/')} [${name}]`);
    }
  }
}
if (signalCount === 0) console.log('No configured content signals found.');

const tracked = spawnSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8', shell: false });
console.log('');
if (tracked.status !== 0) {
  console.log('[Git] unavailable or this directory is not an initialized work tree.');
} else {
  const paths = tracked.stdout.trim() ? tracked.stdout.trim().split(/\r?\n/u) : [];
  console.log(`[Git] tracked files: ${paths.length}`);
  const risky = paths.filter((path) => path !== '.env.example'
    && /(^|\/)(server\/data|node_modules|dist|coverage)\/|(^|\/)\.env($|\.)|\.(wav|mp3|m4a|webm|flac|log|exe|bin)$/iu.test(path));
  console.log(risky.length ? `[Git] REVIEW tracked high-risk paths:\n  ${risky.join('\n  ')}` : '[Git] no configured high-risk tracked paths found.');
}

console.log('\nManual review is required before every commit and push.');

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
