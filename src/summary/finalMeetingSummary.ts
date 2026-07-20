import type { FinalMeetingSummary } from '../../shared/summary';
import type { MeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { CompletedSentence } from '../transcription/types';
import type { SummaryStatus } from './summaryClient';

export interface FinalMeetingTodo {
  content: string;
  assignee: string | null;
  dueDate: string | null;
  completed: boolean;
}

export interface FinalMeetingSummaryRecord {
  meetingId: string;
  summary: FinalMeetingSummary;
  todos: readonly FinalMeetingTodo[];
  createdAt: string;
  provider: SummaryStatus['provider'] | null;
}

export type FinalMeetingSummaryState =
  | { status: 'idle' }
  | { status: 'disabled' }
  | { status: 'processing' }
  | { status: 'succeeded'; record: FinalMeetingSummaryRecord }
  | { status: 'failed' };

export interface CompleteFinalMeetingSummaryOptions {
  meetingId: string;
  settings: MeetingSettingsSnapshot | null;
  sentences: readonly CompletedSentence[];
  provider: SummaryStatus['provider'] | null | (() => SummaryStatus['provider'] | null);
  finalize: (sentences: readonly CompletedSentence[]) => Promise<FinalMeetingSummary | null>;
}

export type FinalMeetingSummaryRetryAvailability =
  | { available: true; message: string }
  | { available: false; message: string };

export interface FinalMeetingSummaryRenderOptions {
  retryAvailability?: FinalMeetingSummaryRetryAvailability;
  retryInProgress?: boolean;
  onRetry?: () => void;
}

export class FinalMeetingSummaryController {
  private stateValue: FinalMeetingSummaryState = { status: 'idle' };
  private inFlight: Promise<FinalMeetingSummaryState> | null = null;
  private generation = 0;
  private meetingId: string | null = null;
  private retryInProgressValue = false;

  constructor(
    private readonly onChange: (state: FinalMeetingSummaryState) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get state(): FinalMeetingSummaryState {
    return this.stateValue;
  }

  get retryInProgress(): boolean {
    return this.retryInProgressValue;
  }

  complete(options: CompleteFinalMeetingSummaryOptions): Promise<FinalMeetingSummaryState> {
    if (this.inFlight) return this.inFlight;
    if (this.stateValue.status !== 'idle') {
      return Promise.resolve(this.stateValue);
    }
    if (!this.bindMeeting(options.meetingId)) {
      this.setState({ status: 'failed' });
      return Promise.resolve(this.stateValue);
    }
    if (!options.settings?.finalSummaryEnabled) {
      this.setState({ status: 'disabled' });
      return Promise.resolve(this.stateValue);
    }

    return this.run(options);
  }

  retry(options: CompleteFinalMeetingSummaryOptions): Promise<FinalMeetingSummaryState> {
    if (this.inFlight) return this.inFlight;
    if (!this.retryAvailability(options).available) return Promise.resolve(this.stateValue);
    this.retryInProgressValue = true;
    return this.run(options);
  }

  retryAvailability(options: Pick<CompleteFinalMeetingSummaryOptions, 'meetingId' | 'settings' | 'sentences'>): FinalMeetingSummaryRetryAvailability {
    if (this.stateValue.status === 'processing' || this.inFlight) {
      return { available: false, message: '再試行中です。' };
    }
    if (this.stateValue.status !== 'failed') {
      return { available: false, message: '現在は再試行できません。' };
    }
    if (!options.meetingId.trim() || this.meetingId !== options.meetingId) {
      return { available: false, message: '対象の会議を確認できないため再試行できません。' };
    }
    if (!options.settings) {
      return { available: false, message: 'この会議には確定済みの設定がないため再試行できません。' };
    }
    if (!options.settings.finalSummaryEnabled) {
      return { available: false, message: 'この会議では最終要約が無効です。' };
    }
    if (options.sentences.length === 0) {
      return { available: false, message: '確定済みの文字起こしがないため再試行できません。' };
    }
    return { available: true, message: '文字起こしを保持したまま再試行できます。' };
  }

  private run(options: CompleteFinalMeetingSummaryOptions): Promise<FinalMeetingSummaryState> {
    const meetingId = options.meetingId;

    this.setState({ status: 'processing' });
    const generation = this.generation;
    const operation = (async () => {
      try {
        const summary = await options.finalize(options.sentences);
        if (!this.isCurrent(generation, meetingId)) return this.stateValue;
        if (!summary) {
          this.finishRun(generation, meetingId);
          this.setState({ status: 'failed' });
          return this.stateValue;
        }
        this.finishRun(generation, meetingId);
        this.setState({
          status: 'succeeded',
          record: createFinalMeetingSummaryRecord(
            meetingId,
            summary,
            this.now().toISOString(),
            typeof options.provider === 'function' ? options.provider() : options.provider,
          ),
        });
        return this.stateValue;
      } catch {
        if (this.isCurrent(generation, meetingId)) {
          this.finishRun(generation, meetingId);
          this.setState({ status: 'failed' });
        }
        return this.stateValue;
      } finally {
        this.finishRun(generation, meetingId);
      }
    })();
    this.inFlight = operation;
    return operation;
  }

  reset(): void {
    this.generation += 1;
    this.inFlight = null;
    this.meetingId = null;
    this.retryInProgressValue = false;
    this.setState({ status: 'idle' });
  }

  private bindMeeting(meetingId: string): boolean {
    if (!meetingId.trim()) return false;
    this.meetingId ??= meetingId;
    return this.meetingId === meetingId;
  }

  private isCurrent(generation: number, meetingId: string): boolean {
    return generation === this.generation && meetingId === this.meetingId;
  }

  private finishRun(generation: number, meetingId: string): void {
    if (!this.isCurrent(generation, meetingId)) return;
    this.inFlight = null;
    this.retryInProgressValue = false;
  }

  private setState(state: FinalMeetingSummaryState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.onChange(state);
  }
}

export function createFinalMeetingSummaryRecord(
  meetingId: string,
  summary: FinalMeetingSummary,
  createdAt: string,
  provider: SummaryStatus['provider'] | null,
): FinalMeetingSummaryRecord {
  return {
    meetingId,
    summary: cloneSummary(summary),
    todos: summary.actionItems.map((item) => ({
      content: item.task,
      assignee: item.assignee,
      dueDate: item.dueDate,
      completed: false,
    })),
    createdAt,
    provider,
  };
}

export function renderFinalMeetingSummary(
  statusElement: HTMLElement,
  contentElement: HTMLElement,
  state: FinalMeetingSummaryState,
  options: FinalMeetingSummaryRenderOptions = {},
): void {
  contentElement.replaceChildren();
  contentElement.hidden = state.status !== 'succeeded'
    && state.status !== 'failed'
    && !(state.status === 'processing' && options.retryInProgress);

  if (state.status === 'idle') {
    statusElement.textContent = '会議終了後に最終要約の状態を表示します。';
    return;
  }
  if (state.status === 'disabled') {
    statusElement.textContent = 'この会議では最終要約が無効です。';
    return;
  }
  if (state.status === 'processing') {
    statusElement.textContent = '最終要約とTODOを作成しています。';
    if (options.retryInProgress) contentElement.append(createRetryButton(undefined, true, '再試行中'));
    return;
  }
  if (state.status === 'failed') {
    statusElement.textContent = '最終要約を作成できませんでした。文字起こしは保持されています。';
    const availability = options.retryAvailability ?? {
      available: false,
      message: '再試行に必要な会議情報を確認できません。',
    };
    const retryStatus = document.createElement('p');
    retryStatus.className = 'final-summary__retry-status';
    retryStatus.textContent = availability.message;
    contentElement.append(retryStatus, createRetryButton(options.onRetry, !availability.available || !options.onRetry, '最終要約を再試行'));
    return;
  }

  const { record } = state;
  statusElement.textContent = '最終要約を作成しました。';
  const overviewHeading = heading('h3', '最終要約');
  const overview = document.createElement('p');
  overview.textContent = record.summary.overview || '要約できる確定済み発話がありませんでした。';

  const todoHeading = heading('h3', 'TODO');
  const todoContent = record.todos.length === 0
    ? emptyMessage('TODOは検出されませんでした。')
    : createTodoList(record.todos);

  const metadata = document.createElement('dl');
  metadata.className = 'final-summary__metadata';
  appendDefinition(metadata, '作成日時', formatCreatedAt(record.createdAt));
  if (record.provider) appendDefinition(metadata, '要約方法', providerLabel(record.provider));

  contentElement.append(overviewHeading, overview, todoHeading, todoContent, metadata);
  contentElement.hidden = false;
}

function createRetryButton(onRetry: (() => void) | undefined, disabled: boolean, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'secondary-button final-summary__retry-button';
  button.type = 'button';
  button.textContent = label;
  button.disabled = disabled;
  if (!disabled && onRetry) button.addEventListener('click', onRetry);
  return button;
}

function createTodoList(todos: readonly FinalMeetingTodo[]): HTMLOListElement {
  const list = document.createElement('ol');
  list.className = 'final-summary__todos';
  for (const todo of todos) {
    const item = document.createElement('li');
    const content = document.createElement('p');
    content.textContent = todo.content;
    const details = document.createElement('dl');
    appendDefinition(details, '担当者', todo.assignee?.trim() || '未指定');
    appendDefinition(details, '期限', todo.dueDate?.trim() || '未指定');
    appendDefinition(details, '状態', todo.completed ? '完了' : '未完了');
    item.append(content, details);
    list.append(item);
  }
  return list;
}

function heading(tagName: 'h3', text: string): HTMLHeadingElement {
  const element = document.createElement(tagName);
  element.textContent = text;
  return element;
}

function emptyMessage(text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = 'final-summary__empty';
  element.textContent = text;
  return element;
}

function appendDefinition(list: HTMLDListElement, termText: string, valueText: string): void {
  const term = document.createElement('dt');
  term.textContent = termText;
  const value = document.createElement('dd');
  value.textContent = valueText;
  list.append(term, value);
}

function providerLabel(provider: SummaryStatus['provider']): string {
  return provider === 'mock' ? 'Mock要約（外部送信なし）' : '設定済みの要約Provider';
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '不明';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function cloneSummary(summary: FinalMeetingSummary): FinalMeetingSummary {
  return {
    ...summary,
    agenda: summary.agenda.map(cloneEvidenceItem),
    keyPoints: summary.keyPoints.map(cloneEvidenceItem),
    decisions: summary.decisions.map(cloneEvidenceItem),
    unresolvedItems: summary.unresolvedItems.map(cloneEvidenceItem),
    actionItems: summary.actionItems.map((item) => ({ ...item, evidenceSentenceIds: [...item.evidenceSentenceIds] })),
    nextChecks: summary.nextChecks.map(cloneEvidenceItem),
  };
}

function cloneEvidenceItem<T extends { text: string; evidenceSentenceIds: string[] }>(item: T): T {
  return { ...item, evidenceSentenceIds: [...item.evidenceSentenceIds] };
}
