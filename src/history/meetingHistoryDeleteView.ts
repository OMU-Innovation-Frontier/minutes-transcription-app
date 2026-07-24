import type { MeetingHistoryDeleteState } from './meetingHistoryDeleteController';
import type { MeetingHistoryDetailState } from './meetingHistoryDetailController';

export interface MeetingHistoryDeleteElements {
  actions: HTMLElement;
  deleteButton: HTMLButtonElement;
  status: HTMLElement;
  retryButton: HTMLButtonElement;
  dialog: HTMLElement;
  dialogTargetTitle: HTMLElement;
  dialogProgress: HTMLElement;
  cancelButton: HTMLButtonElement;
  confirmButton: HTMLButtonElement;
}

export function renderMeetingHistoryDelete(
  elements: MeetingHistoryDeleteElements,
  detailState: MeetingHistoryDetailState,
  deleteState: MeetingHistoryDeleteState,
  persistedDetailSelected: boolean,
): void {
  if (deleteState.status === 'disposed') return;
  reset(elements);

  const detailReady = persistedDetailSelected && detailState.status === 'ready';
  const targetMatches = detailReady && stateMeetingId(deleteState) === detailState.record.meetingId;
  const canShowActions = detailReady
    && deleteState.status !== 'unavailable'
    && deleteState.status !== 'deleted'
    && deleteState.status !== 'not_found'
    && (deleteState.status === 'idle' || targetMatches);
  setHidden(elements.actions, !canShowActions);
  if (!canShowActions) return;

  if (deleteState.status === 'failed') {
    elements.status.textContent = '会議履歴を削除できませんでした。時間をおいてもう一度お試しください。';
    setHidden(elements.status, false);
    setHidden(elements.deleteButton, true);
    setHidden(elements.retryButton, false);
    return;
  }

  if (deleteState.status === 'confirming' || deleteState.status === 'deleting') {
    const deleting = deleteState.status === 'deleting';
    setHidden(elements.deleteButton, deleting);
    elements.deleteButton.disabled = deleting;
    elements.dialogTargetTitle.textContent = deleteState.title;
    elements.dialogProgress.textContent = deleting ? '削除しています。' : '';
    setHidden(elements.dialogProgress, !deleting);
    elements.cancelButton.disabled = deleting;
    elements.confirmButton.disabled = deleting;
    elements.confirmButton.textContent = deleting ? '削除しています' : '削除する';
    setHidden(elements.dialog, false);
  }
}

export function handleMeetingHistoryDeleteDialogKeydown(
  elements: MeetingHistoryDeleteElements,
  state: MeetingHistoryDeleteState,
  event: KeyboardEvent,
  cancel: () => void,
): boolean {
  if (elements.dialog.hidden) return false;
  if (event.key === 'Tab') trapDialogFocus(elements, event);
  if (event.key === 'Escape' && state.status === 'confirming') {
    event.preventDefault();
    cancel();
  }
  return true;
}

function reset(elements: MeetingHistoryDeleteElements): void {
  setHidden(elements.actions, true);
  setHidden(elements.deleteButton, false);
  elements.deleteButton.disabled = false;
  setHidden(elements.status, true);
  elements.status.textContent = '';
  setHidden(elements.retryButton, true);
  elements.retryButton.disabled = false;
  setHidden(elements.dialog, true);
  elements.dialogTargetTitle.textContent = '';
  setHidden(elements.dialogProgress, true);
  elements.dialogProgress.textContent = '';
  elements.cancelButton.disabled = false;
  elements.confirmButton.disabled = false;
  elements.confirmButton.textContent = '削除する';
}

function stateMeetingId(state: MeetingHistoryDeleteState): string | null {
  switch (state.status) {
    case 'confirming':
    case 'deleting':
    case 'deleted':
    case 'not_found':
    case 'failed':
      return state.meetingId;
    case 'idle':
    case 'unavailable':
    case 'disposed':
      return null;
  }
}

function trapDialogFocus(elements: MeetingHistoryDeleteElements, event: KeyboardEvent): void {
  const focusable = [elements.cancelButton, elements.confirmButton]
    .filter((button) => !button.disabled && !button.hidden);
  if (focusable.length === 0) {
    event.preventDefault();
    elements.dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if ((event.shiftKey && document.activeElement === first)
    || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
}

function setHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
  element.setAttribute('aria-hidden', String(hidden));
}
