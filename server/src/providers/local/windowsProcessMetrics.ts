import { spawn, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';

export interface ProcessMetrics {
  cpuAveragePercent?: number;
  cpuPeakPercent?: number;
  peakMemoryBytes?: number;
  logicalProcessorCount: number;
}

export interface ProcessMetricsSampler {
  stop(totalProcessingMs: number): ProcessMetrics;
}

const SAMPLER_SCRIPT = [
  '$culture=[Globalization.CultureInfo]::InvariantCulture',
  'while ($true) {',
  'try {',
  '$p=Get-Process -Id ([int]$env:LOCAL_STT_SAMPLE_PID) -ErrorAction Stop',
  '$wall=[Diagnostics.Stopwatch]::GetTimestamp()*1000.0/[Diagnostics.Stopwatch]::Frequency',
  '$age=([DateTime]::UtcNow-$p.StartTime.ToUniversalTime()).TotalMilliseconds',
  '[Console]::Out.WriteLine([string]::Format($culture,"{0}|{1}|{2}|{3}",$p.TotalProcessorTime.TotalMilliseconds,$p.WorkingSet64,$wall,$age))',
  '[Console]::Out.Flush()',
  'Start-Sleep -Milliseconds 250',
  '} catch { break }',
  '}',
].join(';');

export function startWindowsProcessMetricsSampler(processId: number | undefined): ProcessMetricsSampler | undefined {
  if (process.platform !== 'win32' || !Number.isSafeInteger(processId) || (processId ?? 0) <= 0) return undefined;
  const systemRoot = resolve(process.env.SystemRoot || 'C:\\Windows');
  const allowedRoot = resolve(systemRoot, 'System32/WindowsPowerShell/v1.0');
  const executablePath = resolve(allowedRoot, 'powershell.exe');
  if (!isValidatedExecutable(executablePath, allowedRoot)) return undefined;
  const sampler = spawn(executablePath, ['-NoProfile', '-NonInteractive', '-Command', SAMPLER_SCRIPT], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { SystemRoot: systemRoot, LOCAL_STT_SAMPLE_PID: String(processId) },
  });
  return collectMetrics(sampler);
}

function collectMetrics(sampler: ChildProcess): ProcessMetricsSampler {
  let pending = '';
  let lastCpuMilliseconds: number | undefined;
  let previousCpuMilliseconds: number | undefined;
  let previousWallMilliseconds: number | undefined;
  let cpuPeakPercent: number | undefined;
  let peakMemoryBytes: number | undefined;
  const consumeLine = (line: string): void => {
    const [cpuText, memoryText, wallText, ageText] = line.trim().split('|');
    const cpu = Number(cpuText);
    const memory = Number(memoryText);
    const wall = Number(wallText);
    const age = Number(ageText);
    if (Number.isFinite(cpu) && cpu >= 0 && Number.isFinite(age) && age > 0
      && previousCpuMilliseconds === undefined) {
      const initialPercent = cpu / age / availableParallelism() * 100;
      if (Number.isFinite(initialPercent) && initialPercent >= 0) cpuPeakPercent = initialPercent;
    }
    if (Number.isFinite(cpu) && Number.isFinite(wall)
      && previousCpuMilliseconds !== undefined && previousWallMilliseconds !== undefined
      && wall > previousWallMilliseconds) {
      const intervalPercent = (cpu - previousCpuMilliseconds) / (wall - previousWallMilliseconds)
        / availableParallelism() * 100;
      if (Number.isFinite(intervalPercent) && intervalPercent >= 0) cpuPeakPercent = Math.max(cpuPeakPercent ?? 0, intervalPercent);
    }
    if (Number.isFinite(cpu) && cpu >= 0) lastCpuMilliseconds = cpu;
    if (Number.isFinite(cpu) && cpu >= 0) previousCpuMilliseconds = cpu;
    if (Number.isFinite(wall) && wall >= 0) previousWallMilliseconds = wall;
    if (Number.isFinite(memory) && memory >= 0) peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, memory);
  };
  sampler.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
  });
  sampler.once('error', () => undefined);
  return {
    stop(totalProcessingMs) {
      if (pending.trim()) consumeLine(pending);
      sampler.kill();
      const logicalProcessorCount = availableParallelism();
      const cpuAveragePercent = lastCpuMilliseconds === undefined || totalProcessingMs <= 0
        ? undefined
        : lastCpuMilliseconds / totalProcessingMs / logicalProcessorCount * 100;
      return { cpuAveragePercent, cpuPeakPercent, peakMemoryBytes, logicalProcessorCount };
    },
  };
}

function isValidatedExecutable(executablePath: string, allowedRoot: string): boolean {
  try {
    const realExecutable = realpathSync(executablePath);
    const realRoot = realpathSync(allowedRoot);
    const pathFromRoot = relative(realRoot, realExecutable);
    return statSync(realExecutable).isFile()
      && (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot)));
  } catch {
    return false;
  }
}
