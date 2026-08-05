import { describe, expect, it } from 'vitest';
import {
  buildExternalProcessingDisclosure,
  buildMeetingSetupSummary,
  createInitialMeetingSetupDraft,
  createMeetingSettingsSnapshot,
  meetingTranscriptionCatalog,
  requiresExternalProcessingAcknowledgement,
  validateMeetingSetupDraft,
} from './meetingSetup';

describe('meeting setup draft and snapshot', () => {
  it('requires explicit acknowledgement and describes Groq Whisper precisely', () => {
    const draft = createInitialMeetingSetupDraft('groq-whisper');
    const option = meetingTranscriptionCatalog.find((item) => item.id === 'groq-whisper');
    expect(option).toEqual(expect.objectContaining({
      label: 'Groq Whisper（無料枠）',
      description: '音声を文字起こしするためGroqへ送信します。無料枠には利用上限があり、提供条件は変更される場合があります。',
      audience: 'standard', externalAcknowledgementRequired: true,
    }));
    expect(validateMeetingSetupDraft(draft)).toBe('データ処理方法を確認してください。');
    expect(validateMeetingSetupDraft({ ...draft, externalProcessingAcknowledged: true })).toBeNull();
  });
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

  it('requires acknowledgement for enabled external correction even with Local Whisper', () => {
    const draft = { ...createInitialMeetingSetupDraft('local-whisper'), correctionEnabled: true };
    const requirements = { correctionStatusKnown: true, correctionExternalTransmission: true };
    expect(requiresExternalProcessingAcknowledgement(draft, requirements)).toBe(true);
    expect(validateMeetingSetupDraft(draft, requirements)).toBe('データ処理方法を確認してください。');
    expect(validateMeetingSetupDraft({ ...draft, externalProcessingAcknowledged: true }, requirements)).toBeNull();
    expect(buildExternalProcessingDisclosure(draft, requirements)).toBe('確定した文字起こし、直前の発話、設定した用語集を整文のためGroqへ送信します。');
  });

  it('describes both audio and text transmission when Groq Whisper and Groq correction are enabled', () => {
    const draft = { ...createInitialMeetingSetupDraft('groq-whisper'), correctionEnabled: true };
    const requirements = { correctionStatusKnown: true, correctionExternalTransmission: true };
    const disclosure = buildExternalProcessingDisclosure(draft, requirements);
    expect(disclosure).toContain('音声を文字起こしするためGroqへ送信します。');
    expect(disclosure).toContain('確定した文字起こし、直前の発話、設定した用語集を整文のためGroqへ送信します。');
    expect(buildMeetingSetupSummary(draft, requirements).join('\n')).toContain('用語集');
  });

  it('does not require correction consent while correction is disabled or local', () => {
    const local = createInitialMeetingSetupDraft('local-whisper');
    expect(requiresExternalProcessingAcknowledgement(local, { correctionStatusKnown: true, correctionExternalTransmission: true })).toBe(false);
    expect(requiresExternalProcessingAcknowledgement({ ...local, correctionEnabled: true }, { correctionStatusKnown: true, correctionExternalTransmission: false })).toBe(false);
  });

  it('blocks correction until the server transmission status is known', () => {
    const draft = { ...createInitialMeetingSetupDraft('local-whisper'), correctionEnabled: true };
    expect(validateMeetingSetupDraft(draft, { correctionStatusKnown: false, correctionExternalTransmission: false }))
      .toBe('整文のデータ処理方法を確認できません。');
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
