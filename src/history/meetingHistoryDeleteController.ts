import {
  isValidMeetingHistoryId,
  type MeetingHistoryRepository,
} from './meetingHistoryRepository';

export type MeetingHistoryDeleteState =
  | { status: 'idle' }
  | { status: 'confirming'; meetingId: string; title: string }
  | { status: 'deleting'; meetingId: string; title: string }
  | { status: 'deleted'; meetingId: string }
  | { status: 'not_found'; meetingId: string }
  | { status: 'failed'; meetingId: string; title: string }
  | { status: 'unavailable' }
  | { status: 'disposed' };

export class MeetingHistoryDeleteController {
  private stateValue: MeetingHistoryDeleteState = { status: 'idle' };
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly repository: MeetingHistoryRepository | null,
    private readonly onChange: (state: MeetingHistoryDeleteState) => void = () => undefined,
  ) {}

  get state(): MeetingHistoryDeleteState {
    return this.stateValue;
  }

  confirm(meetingId: string, title: string): boolean {
    if (this.disposed || this.inFlight) return false;
    if (!isValidMeetingHistoryId(meetingId)) return false;
    if (!this.repository) {
      this.beginNewGeneration();
      this.updateState({ status: 'unavailable' });
      return false;
    }

    this.beginNewGeneration();
    this.updateState({ status: 'confirming', meetingId, title });
    return true;
  }

  cancel(): void {
    if (this.disposed || this.stateValue.status !== 'confirming') return;
    this.beginNewGeneration();
    this.updateState({ status: 'idle' });
  }

  delete(): Promise<void> {
    if (this.stateValue.status !== 'confirming') return this.inFlight ?? Promise.resolve();
    return this.startDelete(this.stateValue.meetingId, this.stateValue.title);
  }

  retry(): Promise<void> {
    if (this.stateValue.status !== 'failed') return this.inFlight ?? Promise.resolve();
    return this.startDelete(this.stateValue.meetingId, this.stateValue.title);
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

  private startDelete(meetingId: string, title: string): Promise<void> {
    if (this.disposed || this.inFlight || !this.repository) {
      if (!this.disposed && !this.repository) this.updateState({ status: 'unavailable' });
      return this.inFlight ?? Promise.resolve();
    }

    const generation = ++this.generation;
    this.updateState({ status: 'deleting', meetingId, title });
    const operation = Promise.resolve()
      .then(() => this.repository?.deleteById(meetingId) ?? false)
      .then((deleted) => {
        if (!this.isCurrent(generation)) return;
        this.updateState(deleted
          ? { status: 'deleted', meetingId }
          : { status: 'not_found', meetingId });
      })
      .catch(() => {
        if (!this.isCurrent(generation)) return;
        this.updateState({ status: 'failed', meetingId, title });
      })
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      });
    this.inFlight = operation;
    return operation;
  }

  private beginNewGeneration(): void {
    this.generation += 1;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private updateState(state: MeetingHistoryDeleteState): void {
    if (this.disposed) return;
    this.stateValue = state;
    try {
      this.onChange(state);
    } catch {
      // Presentation failures must not turn a completed delete into an unhandled rejection.
    }
  }
}
