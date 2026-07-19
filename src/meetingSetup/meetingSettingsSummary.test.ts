import { describe, expect, it } from 'vitest';
import {
  createInitialMeetingSetupDraft,
  createMeetingSettingsSnapshot,
  type MeetingSetupDraft,
} from './meetingSetup';
import { buildMeetingSettingsSummary, renderMeetingSettingsSummary } from './meetingSettingsSummary';

function createSnapshot(overrides: Partial<ReturnType<typeof createInitialMeetingSetupDraft>> = {}) {
  return createMeetingSettingsSnapshot({
    ...createInitialMeetingSetupDraft('browser'),
    title: '設計会議',
    externalProcessingAcknowledged: true,
    ...overrides,
  }, '2026-07-19T03:04:00.000Z');
}

describe('meeting settings summary', () => {
  it('presents every snapshot setting with user-facing labels', () => {
    const summary = buildMeetingSettingsSummary(createSnapshot({
      language: 'ja-JP',
      correctionEnabled: true,
      liveSummaryEnabled: true,
      finalSummaryEnabled: true,
    }), () => '2026年7月19日 12:04');

    expect(summary).toMatchObject({
      title: '設計会議',
      language: '日本語',
      provider: 'ブラウザー音声認識',
      correction: '確定した発言を整文します',
      summary: '会議中の簡易要約と、会議終了後の最終要約・TODOを使用します',
      historyRetention: expect.stringContaining('現在のページ'),
      createdAt: '2026年7月19日 12:04',
      externalProcessingRequired: true,
    });
    expect(summary.provider).not.toBe('browser');
  });

  it('presents disabled correction and summary settings accurately', () => {
    const summary = buildMeetingSettingsSummary(createSnapshot({
      correctionEnabled: false,
      liveSummaryEnabled: false,
      finalSummaryEnabled: false,
    }));

    expect(summary.correction).toBe('整文は使用しません');
    expect(summary.summary).toBe('要約は使用しません');
  });

  it.each(['local-whisper', 'mock'] as const)('does not show an external-processing warning for %s', (provider) => {
    const root = document.createElement('section');
    root.id = 'settings';
    renderMeetingSettingsSummary(root, createSnapshot({
      transcriptionProvider: provider,
      externalProcessingAcknowledged: false,
    }));

    expect(root.querySelector('[data-setting="external-processing"]')?.textContent).toContain('外部処理はありません');
    expect(root.querySelector('.meeting-settings-summary__row--external')).toBeNull();
  });

  it('keeps displaying the snapshot after draft and recording-state changes', () => {
    const draft: MeetingSetupDraft = {
      ...createInitialMeetingSetupDraft('local-whisper'),
      title: '固定された会議',
      language: 'en-US',
    };
    const snapshot = createMeetingSettingsSnapshot(draft, '2026-07-19T03:04:00.000Z');
    const root = document.createElement('section');
    root.id = 'settings';
    renderMeetingSettingsSummary(root, snapshot);
    const initialText = root.textContent;

    draft.title = 'フォームで変更された会議';
    draft.language = 'ja-JP';
    root.dataset.recordingState = 'paused';
    renderMeetingSettingsSummary(root, snapshot);
    root.dataset.recordingState = 'active';

    expect(root.textContent).toBe(initialText);
    expect(root.textContent).toContain('固定された会議');
    expect(root.textContent).not.toContain('フォームで変更された会議');
  });

  it('is safe when no snapshot exists', () => {
    const root = document.createElement('section');
    expect(() => renderMeetingSettingsSummary(root, null)).not.toThrow();
    expect(root.hidden).toBe(true);
    expect(root.childElementCount).toBe(0);
  });

  it('renders user text as text and contains no editable controls', () => {
    const root = document.createElement('section');
    root.id = 'settings';
    renderMeetingSettingsSummary(root, createSnapshot({ title: '<img src=x onerror=alert(1)>' }));

    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.querySelector('input, select, textarea, button')).toBeNull();
  });
});
