import { beforeEach, describe, expect, it } from 'vitest';
import { createMeetingSettingsSnapshot, createInitialMeetingSetupDraft, validateMeetingSetupDraft } from './meetingSetup';
import { applyAppView, createInitialAppViewState, transitionAppView } from '../ui/appView';

describe('meeting setup to recording boundary', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <section id="home"></section>
      <section id="setup"><form id="form"><input id="title"><select id="provider"><option value="local-whisper">Local Whisper</option><option value="browser">Browser</option></select><select id="language"><option value="ja-JP">日本語</option><option value="en-US">English</option></select><button id="create" type="submit">作成</button></form></section>
      <section id="meeting"><button id="record" type="button">録音を開始</button></section>
    `;
  });

  it('creates a snapshot without starting recording, then uses that snapshot at recording start', () => {
    let state = createInitialAppViewState();
    const sections = { home: document.querySelector('#home') as HTMLElement, meetingSetup: document.querySelector('#setup') as HTMLElement, meeting: document.querySelector('#meeting') as HTMLElement, meetingDetail: document.createElement('section') };
    state = transitionAppView(state, 'open-meeting-setup');
    applyAppView(state.view, sections);
    expect(sections.meetingSetup.hidden).toBe(false);

    const title = document.querySelector<HTMLInputElement>('#title')!;
    const provider = document.querySelector<HTMLSelectElement>('#provider')!;
    const language = document.querySelector<HTMLSelectElement>('#language')!;
    title.value = 'Snapshot meeting';
    provider.value = 'local-whisper';
    language.value = 'en-US';
    const draft = { ...createInitialMeetingSetupDraft('local-whisper'), title: title.value, transcriptionProvider: provider.value as 'local-whisper', language: language.value as 'en-US' };
    expect(validateMeetingSetupDraft(draft)).toBeNull();
    const snapshot = createMeetingSettingsSnapshot(draft, '2026-07-19T00:00:00.000Z');

    state = transitionAppView(state, 'create-meeting');
    applyAppView(state.view, sections);
    expect(state.view).toBe('meeting');
    expect(sections.meeting.hidden).toBe(false);
    expect(sections.meetingSetup.hidden).toBe(true);
    expect(document.querySelector('#record')?.getAttribute('aria-pressed')).toBeNull();

    // Changing the form after creation must not alter the snapshot used to start.
    provider.value = 'browser';
    language.value = 'ja-JP';
    let providerStarted = '';
    let languageStarted = '';
    document.querySelector('#record')!.addEventListener('click', () => {
      providerStarted = snapshot.transcriptionProvider;
      languageStarted = snapshot.language;
    });
    document.querySelector<HTMLButtonElement>('#record')!.click();
    expect(providerStarted).toBe('local-whisper');
    expect(languageStarted).toBe('en-US');
  });
});
