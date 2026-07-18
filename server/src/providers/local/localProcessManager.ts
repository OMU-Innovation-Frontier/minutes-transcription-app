import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { LocalSttError } from './localSttTypes.js';
import { startWindowsProcessMetricsSampler, type ProcessMetrics } from './windowsProcessMetrics.js';

export interface LocalProcessRequest {
  executablePath: string;
  arguments: readonly string[];
  allowedExecutableRoots: readonly string[];
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface LocalProcessResult {
  stdout: string;
  stderr: string;
  totalProcessingMs: number;
  firstStdoutLatencyMs?: number;
  exitCode: number;
  cpuAveragePercent?: number;
  cpuPeakPercent?: number;
  peakMemoryBytes?: number;
  logicalProcessorCount?: number;
}

export class LocalProcessManager {
  private readonly active = new Set<ChildProcess>();
  private readonly waiters: Array<() => void> = [];
  private running = 0;

  constructor(private readonly maxConcurrency = 1) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
      throw new RangeError('maxConcurrency must be an integer between 1 and 8');
    }
  }

  async run(request: LocalProcessRequest): Promise<LocalProcessResult> {
    const executable = await validateExistingFile(
      request.executablePath,
      request.allowedExecutableRoots,
      'local_executable_missing',
      'Local STT executable is missing or outside the configured binary directory.',
    );
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 86_400_000) {
      throw new LocalSttError('local_timeout_invalid', 'Local STT timeout configuration is invalid.');
    }
    const release = await this.acquire();
    try {
      return await this.spawnAndWait(executable, request);
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    for (const child of this.active) child.kill();
    this.active.clear();
  }

  private async spawnAndWait(executable: string, request: LocalProcessRequest): Promise<LocalProcessResult> {
    if (request.signal?.aborted) {
      throw new LocalSttError('local_process_cancelled', 'Local STT processing was cancelled.');
    }
    const startedAt = performance.now();
    const maxOutputBytes = request.maxOutputBytes ?? 4 * 1024 * 1024;
    return await new Promise<LocalProcessResult>((resolveResult, reject) => {
      const child = spawn(executable, [...request.arguments], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const metricsSampler = startWindowsProcessMetricsSampler(child.pid);
      this.active.add(child);
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let firstStdoutLatencyMs: number | undefined;
      let metrics: ProcessMetrics | undefined;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(child);
        metrics = metricsSampler?.stop(performance.now() - startedAt);
        request.signal?.removeEventListener('abort', abort);
        callback();
      };
      const abort = (): void => {
        child.kill();
        finish(() => reject(new LocalSttError('local_process_cancelled', 'Local STT processing was cancelled.')));
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      const append = (current: Buffer, chunk: Buffer): Buffer => {
        if (current.length + chunk.length > maxOutputBytes) {
          child.kill();
          finish(() => reject(new LocalSttError(
            'local_output_limit',
            'Local STT produced more output than the configured safety limit.',
          )));
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        firstStdoutLatencyMs ??= performance.now() - startedAt;
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once('error', (error) => finish(() => reject(new LocalSttError(
        'local_process_start_failed',
        'Local STT process could not be started.',
        { cause: error },
      ))));
      child.once('close', (code) => finish(() => {
        const totalProcessingMs = performance.now() - startedAt;
        if (code !== 0) {
          reject(new LocalSttError('local_process_failed', 'Local STT process failed.'));
          return;
        }
        resolveResult({
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          totalProcessingMs,
          firstStdoutLatencyMs,
          exitCode: code,
          cpuAveragePercent: metrics?.cpuAveragePercent,
          cpuPeakPercent: metrics?.cpuPeakPercent,
          peakMemoryBytes: metrics?.peakMemoryBytes,
          logicalProcessorCount: metrics?.logicalProcessorCount,
        });
      }));
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new LocalSttError('local_process_timeout', 'Local STT process timed out.')));
      }, request.timeoutMs);
      timer.unref();
    });
  }

  private async acquire(): Promise<() => void> {
    if (this.running >= this.maxConcurrency) {
      await new Promise<void>((resolveWaiter) => this.waiters.push(resolveWaiter));
    }
    this.running += 1;
    return () => {
      this.running -= 1;
      this.waiters.shift()?.();
    };
  }
}

export async function validateExistingFile(
  filePath: string,
  allowedRoots: readonly string[],
  code: string,
  safeMessage: string,
): Promise<string> {
  if (!filePath || !isAbsolute(filePath) || allowedRoots.length === 0) {
    throw new LocalSttError(code, safeMessage);
  }
  try {
    const resolvedFile = await realpath(filePath);
    const fileStat = await stat(resolvedFile);
    if (!fileStat.isFile()) throw new Error('not a file');
    const allowed = allowedRoots.some((root) => isWithin(resolve(root), resolvedFile));
    if (!allowed) throw new Error('outside allowed roots');
    return resolvedFile;
  } catch (error) {
    if (error instanceof LocalSttError) throw error;
    throw new LocalSttError(code, safeMessage, { cause: error });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}
