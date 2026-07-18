import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertSafeChildPath } from './chunkComparison.js';
import type { LocalUtteranceMetrics } from './localWhisperServerProvider.js';

export class LocalRealtimeMetricsRecorder {
  private pending = Promise.resolve();
  private readonly outputPath: string;

  constructor(private readonly enabled: boolean, localRoot: string) {
    const outputRoot = resolve(localRoot, 'results/realtime');
    this.outputPath = resolve(outputRoot, `local-whisper-realtime-${new Date().toISOString().slice(0, 10)}.jsonl`);
    assertSafeChildPath(outputRoot, this.outputPath);
  }

  record(metric: LocalUtteranceMetrics): void {
    if (!this.enabled) return;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.outputPath), { recursive: true });
      await appendFile(this.outputPath, `${JSON.stringify(metric)}\n`, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => undefined);
  }

  close(): Promise<void> {
    return this.pending;
  }
}
