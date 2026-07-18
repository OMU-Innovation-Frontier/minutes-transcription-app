export type AppView = 'home' | 'meeting' | 'meeting-detail';

export interface AppViewState {
  view: AppView;
  meetingStarted: boolean;
  meetingEnded: boolean;
}

export type AppViewAction = 'start-meeting' | 'open-home' | 'resume-meeting' | 'end-meeting' | 'open-detail';

export interface AppViewSections {
  home: HTMLElement;
  meeting: HTMLElement;
  meetingDetail: HTMLElement;
}

export function createInitialAppViewState(): AppViewState {
  return { view: 'home', meetingStarted: false, meetingEnded: false };
}

export function transitionAppView(state: AppViewState, action: AppViewAction): AppViewState {
  switch (action) {
    case 'start-meeting':
      return { view: 'meeting', meetingStarted: true, meetingEnded: false };
    case 'open-home':
      return { ...state, view: 'home' };
    case 'resume-meeting':
      return state.meetingStarted && !state.meetingEnded ? { ...state, view: 'meeting' } : state;
    case 'end-meeting':
      return state.meetingStarted ? { view: 'meeting-detail', meetingStarted: true, meetingEnded: true } : state;
    case 'open-detail':
      return state.meetingEnded ? { ...state, view: 'meeting-detail' } : state;
  }
}

export function applyAppView(view: AppView, sections: AppViewSections): void {
  const entries: Array<[AppView, HTMLElement]> = [
    ['home', sections.home],
    ['meeting', sections.meeting],
    ['meeting-detail', sections.meetingDetail],
  ];
  for (const [name, section] of entries) {
    const active = name === view;
    section.hidden = !active;
    section.setAttribute('aria-hidden', String(!active));
  }
  document.documentElement.dataset.appView = view;
}
