import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApiUsageRecord, MeetingUsageSummary } from '../../../shared/summary.js';

export class ApiUsageStore {
  private records: ApiUsageRecord[] = [];
  private loaded = false;

  constructor(private readonly filePath?: string) {}

  async append(record: ApiUsageRecord): Promise<void> {
    await this.load();
    this.records.push(record);
    if (this.filePath) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  async forMeeting(meetingId: string): Promise<ApiUsageRecord[]> {
    await this.load();
    return this.records.filter((record) => record.meetingId === meetingId);
  }

  async monthlyEstimatedCost(now = new Date()): Promise<number> {
    await this.load();
    const prefix = now.toISOString().slice(0, 7);
    return this.records
      .filter((record) => record.createdAt.startsWith(prefix))
      .reduce((sum, record) => sum + (record.estimatedCostUsd ?? 0), 0);
  }

  async meetingSummary(meetingId: string): Promise<MeetingUsageSummary> {
    const records = await this.forMeeting(meetingId);
    const priced = records.filter((record) => record.estimatedCostUsd !== undefined);
    return {
      inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
      outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
      totalTokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
      estimatedCostUsd: records.length > 0 && priced.length === records.length
        ? priced.reduce((sum, record) => sum + (record.estimatedCostUsd ?? 0), 0)
        : undefined,
      requestCount: records.length,
      pricingConfigured: records.length === 0 || priced.length === records.length,
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const content = await readFile(this.filePath, 'utf8');
      this.records = content.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as ApiUsageRecord);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
