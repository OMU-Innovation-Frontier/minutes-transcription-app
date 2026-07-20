import { describe, expect, it } from 'vitest';
import {
  buildMeetingSetupSummary,
  createInitialMeetingSetupDraft,
  createMeetingSettingsSnapshot,
  meetingTranscriptionCatalog,
  validateMeetingSetupDraft,
} from './meetingSetup';

describe('meeting setup draft and snapshot', () => {
  it('rejects an external provider until acknowledgement is checked', () => {
    const draft = { ...createInitialMeetingSetupDraft('browser'), title: 'Review' };
    expect(validateMeetingSetupDraft(draft)).toBeTruthy();
    expect(validateMeetingSetupDraft({ ...draft, externalProcessingAcknowledged: true })).toBeNull();
  });

  it('does not require acknowledgement for local and mock providers', () => {
    for (const provider of ['local-whisper', 'mock'] as const) {
      expect(validateMeetingSetupDraft({ ...createInitialMeetingSetupDraft(provider), title: 'Offline' })).toBeNull();
    }
  });

  it('validates title length and language', () => {
    const draft = createInitialMeetingSetupDraft();
    expect(validateMeetingSetupDraft({ ...draft, title: ' '.repeat(2) })).toBeTruthy();
    expect(validateMeetingSetupDraft({ ...draft, title: 'a'.repeat(81) })).toBeTruthy();
    expect(validateMeetingSetupDraft({ ...draft, title: 'a'.repeat(80) })).toBeNull();
    expect(validateMeetingSetupDraft({ ...draft, language: 'xx' as never })).toBeTruthy();
  });

  it('captures all selected settings in an immutable snapshot', () => {
    const draft = { ...createInitialMeetingSetupDraft('local-whisper'), title: 'Design', language: 'en-US' as const, correctionEnabled: true, liveSummaryEnabled: true, finalSummaryEnabled: true };
    const snapshot = createMeetingSettingsSnapshot(draft, '2026-07-19T00:00:00.000Z');
    expect(snapshot).toMatchObject({ settingsVersion: 1, title: 'Design', language: 'en-US', transcriptionProvider: 'local-whisper', correctionEnabled: true, liveSummaryEnabled: true, finalSummaryEnabled: true, historyRetention: 'page-session', createdAt: '2026-07-19T00:00:00.000Z' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    draft.title = 'Changed';
    expect(snapshot.title).toBe('Design');
  });

  it('describes provider processing and feature choices', () => {
    const summary = buildMeetingSetupSummary({ ...createInitialMeetingSetupDraft('browser'), title: 'x', externalProcessingAcknowledged: true, correctionEnabled: true, liveSummaryEnabled: true, finalSummaryEnabled: true });
    expect(summary.length).toBe(8);
    expect(summary.join('\n')).toContain('TODO');
    expect(summary.join('\n')).toContain('ページ');
    expect(summary.join('\n')).toContain('端末のブラウザー内へ保存');
    expect(summary.join('\n')).toContain('ページを閉じて開き直しても確認できます');
    expect(summary.join('\n')).toContain('サイトデータを削除すると失われ');
    expect(summary.join('\n')).toContain('クラウド保存・チーム共有・アカウント保護には対応していません');
    expect(summary.join('\n')).not.toContain('再読み込み後は復元されません');
  });

  it('renders user-controlled summary text as text, not markup', () => {
    const list = document.createElement('ul');
    const item = document.createElement('li');
    item.textContent = '<img src=x onerror=alert(1)>';
    list.append(item);
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img');
  });

  it('keeps the catalog explicit about external processing', () => {
    expect(meetingTranscriptionCatalog.find((option) => option.id === 'local-whisper')?.externalAcknowledgementRequired).toBe(false);
    expect(meetingTranscriptionCatalog.find((option) => option.id === 'browser')?.externalAcknowledgementRequired).toBe(true);
    expect(meetingTranscriptionCatalog.find((option) => option.id === 'websocket')?.externalAcknowledgementRequired).toBe(true);
  });
});
