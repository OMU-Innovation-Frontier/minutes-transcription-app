import { isValidMeetingHistoryId, type MeetingHistoryRepository } from './meetingHistoryRepository';
import type { MeetingRecord } from './meetingRecord';

export type MeetingHistoryDetailState =
  | { status: 'idle' }
  | { status: 'loading'; meetingId: string }
  | { status: 'ready'; record: MeetingRecord }
  | { status: 'not_found'; meetingId: string }
  | { status: 'failed'; meetingId: string }
  | { status: 'unavailable' }
  | { status: 'disposed' };

interface DetailOperation {
  meetingId: string;
  promise: Promise<void>;
}

export class MeetingHistoryDetailController {
  private stateValue: MeetingHistoryDetailState = { status: 'idle' };
  private inFlight: DetailOperation | null = null;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly repository: MeetingHistoryRepository | null,
    private readonly onChange: (state: MeetingHistoryDetailState) => void = () => undefined,
  ) {}

  get state(): MeetingHistoryDetailState {
    return this.stateValue;
  }

  open(meetingId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!isValidMeetingHistoryId(meetingId)) {
      this.beginNewGeneration();
      this.updateState({ status: 'not_found', meetingId: '' });
      return Promise.resolve();
    }
    if (!this.repository) {
      this.beginNewGeneration();
      this.updateState({ status: 'unavailable' });
      return Promise.resolve();
    }
    if (this.inFlight?.meetingId === meetingId) return this.inFlight.promise;

    const generation = ++this.generation;
    this.updateState({ status: 'loading', meetingId });
    const operation = Promise.resolve()
      .then(() => this.repository?.getById(meetingId) ?? null)
      .then((record) => {
        if (!this.isCurrent(generation)) return;
        this.updateState(record ? { status: 'ready', record } : { status: 'not_found', meetingId });
      })
      .catch(() => {
        if (!this.isCurrent(generation)) return;
        this.updateState({ status: 'failed', meetingId });
      })
      .finally(() => {
        if (this.inFlight?.promise === operation) this.inFlight = null;
      });
    this.inFlight = { meetingId, promise: operation };
    return operation;
  }

  retry(): Promise<void> {
    if (this.stateValue.status !== 'failed') return Promise.resolve();
    return this.open(this.stateValue.meetingId);
  }

  clear(): void {
    if (this.disposed) return;
    this.beginNewGeneration();
    this.updateState({ status: 'idle' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.beginNewGeneration();
    this.stateValue = { status: 'disposed' };
  }

  private beginNewGeneration(): void {
    this.generation += 1;
    this.inFlight = null;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private updateState(state: MeetingHistoryDetailState): void {
    if (this.disposed) return;
    this.stateValue = state;
    try {
      this.onChange(state);
    } catch {
      // Presentation failures must not turn a safe repository read into an unhandled rejection.
    }
  }
}
