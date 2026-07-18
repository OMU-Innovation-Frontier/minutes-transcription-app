import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAppView,
  createInitialAppViewState,
  transitionAppView,
  type AppViewSections,
} from './appView';

function sections(): AppViewSections {
  document.body.innerHTML = '<section id="home"></section><section id="meeting"></section><section id="detail"></section>';
  return {
    home: document.querySelector('#home') as HTMLElement,
    meeting: document.querySelector('#meeting') as HTMLElement,
    meetingDetail: document.querySelector('#detail') as HTMLElement,
  };
}

describe('app view state', () => {
  beforeEach(() => { document.documentElement.removeAttribute('data-app-view'); });

  it('starts on the home view', () => {
    expect(createInitialAppViewState()).toEqual({ view: 'home', meetingStarted: false, meetingEnded: false });
  });

  it('shows only the requested section', () => {
    const elements = sections();
    applyAppView('home', elements);
    expect(elements.home.hidden).toBe(false);
    expect(elements.meeting.hidden).toBe(true);
    expect(elements.meetingDetail.hidden).toBe(true);
    expect(document.documentElement.dataset.appView).toBe('home');
  });

  it('moves from a new meeting action to the meeting view', () => {
    expect(transitionAppView(createInitialAppViewState(), 'start-meeting')).toEqual({
      view: 'meeting', meetingStarted: true, meetingEnded: false,
    });
  });

  it('returns home without losing an active meeting state', () => {
    const active = transitionAppView(createInitialAppViewState(), 'start-meeting');
    expect(transitionAppView(active, 'open-home')).toEqual({ view: 'home', meetingStarted: true, meetingEnded: false });
  });

  it('resumes the meeting after a display-only home transition', () => {
    const home = { view: 'home' as const, meetingStarted: true, meetingEnded: false };
    expect(transitionAppView(home, 'resume-meeting').view).toBe('meeting');
  });

  it('moves an ended meeting to the detail view', () => {
    const active = transitionAppView(createInitialAppViewState(), 'start-meeting');
    expect(transitionAppView(active, 'end-meeting')).toEqual({ view: 'meeting-detail', meetingStarted: true, meetingEnded: true });
  });

  it('does not open a detail view before a meeting has ended', () => {
    const initial = createInitialAppViewState();
    expect(transitionAppView(initial, 'open-detail')).toBe(initial);
  });
});
