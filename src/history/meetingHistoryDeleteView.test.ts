// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createMeetingSettingsSnapshot } from '../meetingSetup/meetingSetup';
import type { MeetingHistoryDeleteState } from './meetingHistoryDeleteController';
import {
  handleMeetingHistoryDeleteDialogKeydown,
  renderMeetingHistoryDelete,
  type MeetingHistoryDeleteElements,
} from './meetingHistoryDeleteView';
import type { MeetingHistoryDetailState } from './meetingHistoryDetailController';
import { createMeetingRecord } from './meetingRecord';

describe('meeting history delete view', () => {
  let elements: MeetingHistoryDeleteElements;

  beforeEach(() => {
    document.body.replaceChildren();
    elements = createElements();
  });

  it('shows the delete area only for a selected persisted ready detail', () => {
    renderMeetingHistoryDelete(elements, readyDetail(), { status: 'idle' }, true);
    expect(elements.actions.hidden).toBe(false);
    expect(elements.deleteButton.type).toBe('button');
    expect(elements.deleteButton.textContent).toBe('この会議履歴を削除');

    for (const state of [
      { status: 'loading', meetingId: 'meeting-1' },
      { status: 'failed', meetingId: 'meeting-1' },
      { status: 'not_found', meetingId: 'meeting-1' },
      { status: 'unavailable' },
    ] satisfies MeetingHistoryDetailState[]) {
      renderMeetingHistoryDelete(elements, state, { status: 'idle' }, true);
      expect(elements.actions.hidden).toBe(true);
      expect(elements.actions.getAttribute('aria-hidden')).toBe('true');
    }

    renderMeetingHistoryDelete(elements, readyDetail(), { status: 'idle' }, false);
    expect(elements.actions.hidden).toBe(true);
  });

  it('renders an accessible confirmation dialog and HTML-like title as text', () => {
    const title = `<script data-value="'&">${'very-long-title'.repeat(100)}</script>`;
    renderMeetingHistoryDelete(elements, readyDetail(), {
      status: 'confirming',
      meetingId: 'meeting-1',
      title,
    }, true);

    expect(elements.dialog.hidden).toBe(false);
    expect(elements.dialog.getAttribute('aria-hidden')).toBe('false');
    expect(elements.dialog.getAttribute('aria-labelledby')).toBe('delete-dialog-title');
    expect(elements.dialog.getAttribute('aria-describedby')).toBe('delete-dialog-description');
    expect(elements.dialogTargetTitle.textContent).toBe(title);
    expect(elements.dialogTargetTitle.querySelector('script')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(elements.cancelButton.type).toBe('button');
    expect(elements.confirmButton.type).toBe('button');
  });

  it('locks the dialog and reports progress while deleting', () => {
    renderMeetingHistoryDelete(elements, readyDetail(), {
      status: 'deleting',
      meetingId: 'meeting-1',
      title: '固定タイトル',
    }, true);

    expect(elements.dialog.hidden).toBe(false);
    expect(elements.deleteButton.disabled).toBe(true);
    expect(elements.deleteButton.hidden).toBe(true);
    expect(elements.cancelButton.disabled).toBe(true);
    expect(elements.confirmButton.disabled).toBe(true);
    expect(elements.confirmButton.textContent).toBe('削除しています');
    expect(elements.dialogProgress.textContent).toBe('削除しています。');
  });

  it('shows a safe failure and manual retry only for the same selected target', () => {
    renderMeetingHistoryDelete(elements, readyDetail(), {
      status: 'failed',
      meetingId: 'meeting-1',
      title: '固定タイトル',
    }, true);

    expect(elements.dialog.hidden).toBe(true);
    expect(elements.status.hidden).toBe(false);
    expect(elements.status.textContent).toContain('会議履歴を削除できませんでした');
    expect(elements.status.textContent).not.toContain('IndexedDB');
    expect(elements.retryButton.hidden).toBe(false);
    expect(elements.retryButton.type).toBe('button');
    expect(elements.deleteButton.hidden).toBe(true);

    renderMeetingHistoryDelete(elements, readyDetail('meeting-2'), {
      status: 'failed',
      meetingId: 'meeting-1',
      title: '古い対象',
    }, true);
    expect(elements.actions.hidden).toBe(true);
  });

  it('hides actions and dialog after deleted, not-found, or unavailable states', () => {
    for (const state of [
      { status: 'deleted', meetingId: 'meeting-1' },
      { status: 'not_found', meetingId: 'meeting-1' },
      { status: 'unavailable' },
    ] satisfies MeetingHistoryDeleteState[]) {
      renderMeetingHistoryDelete(elements, readyDetail(), state, true);
      expect(elements.actions.hidden).toBe(true);
      expect(elements.dialog.hidden).toBe(true);
      expect(elements.actions.getAttribute('aria-hidden')).toBe('true');
      expect(elements.dialog.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('cancels with Escape, restores focus through the callback, and traps Tab in the dialog', () => {
    const state = {
      status: 'confirming',
      meetingId: 'meeting-1',
      title: '固定タイトル',
    } as const;
    renderMeetingHistoryDelete(elements, readyDetail(), state, true);
    elements.confirmButton.focus();

    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    expect(handleMeetingHistoryDeleteDialogKeydown(elements, state, tab, () => undefined)).toBe(true);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(elements.cancelButton);

    const cancel = () => {
      renderMeetingHistoryDelete(elements, readyDetail(), { status: 'idle' }, true);
      elements.deleteButton.focus();
    };
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handleMeetingHistoryDeleteDialogKeydown(elements, state, escape, cancel);
    expect(escape.defaultPrevented).toBe(true);
    expect(elements.dialog.hidden).toBe(true);
    expect(document.activeElement).toBe(elements.deleteButton);
  });

  it('does not cancel or close the dialog with Escape while deleting', () => {
    const state = {
      status: 'deleting',
      meetingId: 'meeting-1',
      title: '固定タイトル',
    } as const;
    renderMeetingHistoryDelete(elements, readyDetail(), state, true);
    let cancelled = false;

    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handleMeetingHistoryDeleteDialogKeydown(elements, state, escape, () => { cancelled = true; });

    expect(cancelled).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
    expect(elements.dialog.hidden).toBe(false);
  });
});

function createElements(): MeetingHistoryDeleteElements {
  const actions = document.createElement('section');
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.textContent = 'この会議履歴を削除';
  const status = document.createElement('p');
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  actions.append(deleteButton, status, retryButton);

  const dialog = document.createElement('section');
  dialog.tabIndex = -1;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-labelledby', 'delete-dialog-title');
  dialog.setAttribute('aria-describedby', 'delete-dialog-description');
  const dialogTargetTitle = document.createElement('strong');
  const dialogProgress = document.createElement('p');
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  dialog.append(dialogTargetTitle, dialogProgress, cancelButton, confirmButton);
  document.body.append(actions, dialog);
  return {
    actions,
    deleteButton,
    status,
    retryButton,
    dialog,
    dialogTargetTitle,
    dialogProgress,
    cancelButton,
    confirmButton,
  };
}

function readyDetail(meetingId = 'meeting-1'): MeetingHistoryDetailState {
  const settings = createMeetingSettingsSnapshot({
    title: '保存済み会議',
    language: 'ja-JP',
    transcriptionProvider: 'mock',
    correctionEnabled: false,
    liveSummaryEnabled: false,
    finalSummaryEnabled: false,
    historyRetention: 'page-session',
    externalProcessingAcknowledged: false,
  }, '2026-07-20T01:00:00.000Z');
  return {
    status: 'ready',
    record: createMeetingRecord({
      meetingId,
      createdAt: settings.createdAt,
      startedAt: null,
      endedAt: '2026-07-20T01:30:00.000Z',
      updatedAt: '2026-07-20T01:30:00.000Z',
      settingsSnapshot: settings,
      sentences: [],
    }),
  };
}
