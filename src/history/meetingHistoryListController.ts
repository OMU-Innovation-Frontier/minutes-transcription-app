import type { MeetingHistoryRepository } from './meetingHistoryRepository';
import type { MeetingRecord } from './meetingRecord';

export type MeetingHistoryLoadPhase = 'initial' | 'refresh';

export type MeetingHistoryListState =
  | { status: 'idle'; records: readonly MeetingRecord[] }
  | { status: 'loading'; records: readonly MeetingRecord[]; phase: MeetingHistoryLoadPhase }
  | { status: 'ready'; records: readonly MeetingRecord[] }
  | { status: 'empty'; records: readonly MeetingRecord[] }
  | { status: 'unavailable'; records: readonly MeetingRecord[] }
  | { status: 'failed'; records: readonly MeetingRecord[]; phase: MeetingHistoryLoadPhase }
  | { status: 'disposed'; records: readonly MeetingRecord[] };

export class MeetingHistoryListController {
  private stateValue: MeetingHistoryListState = { status: 'idle', records: [] };
  private inFlight: Promise<void> | null = null;
  private pendingRefresh = false;
  private generation = 0;
  private hasSuccessfulLoad = false;
  private disposed = false;

  constructor(
    private readonly repository: MeetingHistoryRepository | null,
    private readonly onChange: (state: MeetingHistoryListState) => void = () => undefined,
  ) {}

  get state(): MeetingHistoryListState {
    return this.stateValue;
  }

  load(): Promise<void> {
    return this.requestLoad('initial');
  }

  refresh(): Promise<void> {
    return this.requestLoad('refresh');
  }

  retry(): Promise<void> {
    if (this.stateValue.status !== 'failed') return Promise.resolve();
    return this.requestLoad(this.hasSuccessfulLoad ? 'refresh' : 'initial');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.pendingRefresh = false;
    this.stateValue = { status: 'disposed', records: this.stateValue.records };
  }

  private requestLoad(requestedPhase: MeetingHistoryLoadPhase): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.repository) {
      this.updateState({ status: 'unavailable', records: this.stateValue.records });
      return Promise.resolve();
    }
    if (this.inFlight) {
      if (requestedPhase === 'refresh') this.pendingRefresh = true;
      return this.inFlight;
    }

    const phase: MeetingHistoryLoadPhase = this.hasSuccessfulLoad ? 'refresh' : 'initial';
    const generation = ++this.generation;
    this.updateState({ status: 'loading', records: this.stateValue.records, phase });

    const operation = Promise.resolve()
      .then(() => this.repository?.list() ?? [])
      .then((records) => {
        if (!this.isCurrent(generation)) return;
        const preservedOrder = Object.freeze([...records]);
        this.hasSuccessfulLoad = true;
        this.updateState(preservedOrder.length === 0
          ? { status: 'empty', records: preservedOrder }
          : { status: 'ready', records: preservedOrder });
      })
      .catch(() => {
        if (!this.isCurrent(generation)) return;
        this.updateState({
          status: 'failed',
          records: this.stateValue.records,
          phase: this.hasSuccessfulLoad ? 'refresh' : 'initial',
        });
      })
      .then(async () => {
        if (!this.isCurrent(generation) || !this.pendingRefresh) return;
        this.pendingRefresh = false;
        this.inFlight = null;
        await this.requestLoad('refresh');
      })
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      });

    this.inFlight = operation;
    return operation;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private updateState(state: MeetingHistoryListState): void {
    if (this.disposed) return;
    this.stateValue = state;
    try {
      this.onChange(state);
    } catch {
      // A presentation callback must not turn a history read into an application failure.
    }
  }
}
