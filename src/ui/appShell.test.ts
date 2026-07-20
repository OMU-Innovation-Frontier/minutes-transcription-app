// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const html = readFileSync(resolve('index.html'), 'utf8');
const mainSource = readFileSync(resolve('src/main.ts'), 'utf8');
const styles = readFileSync(resolve('src/styles.css'), 'utf8');

describe('application shell markup', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = html;
  });

  it('has a visible home screen and a hidden meeting screen initially', () => {
    expect(document.querySelector<HTMLElement>('#home-view')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#meeting-view')?.hidden).toBe(true);
  });

  it('offers the primary new meeting action', () => {
    expect(document.querySelector<HTMLButtonElement>('#new-meeting-button')?.textContent).toContain('新しい会議を始める');
  });

  it('shows a truthful empty state instead of fictional meeting history', () => {
    expect(document.querySelector('#home-history-empty')?.textContent).toContain('まだ保存された会議はありません');
    expect(document.querySelector('#meeting-history-list')?.children).toHaveLength(0);
  });

  it('places recording controls in the bottom meeting control bar', () => {
    const controls = document.querySelector('.meeting-controls');
    expect(controls?.querySelector('#start-button')).not.toBeNull();
    expect(controls?.querySelector('#stop-button')).not.toBeNull();
    expect(controls?.querySelector('#end-meeting-button-footer')).not.toBeNull();
  });

  it('keeps the latest-transcript action in a separate layout region above recording controls', () => {
    const meetingView = document.querySelector('#meeting-view');
    const actions = meetingView?.querySelector('.meeting-scroll-actions');
    const controls = meetingView?.querySelector('.meeting-controls');
    const latestButton = meetingView?.querySelector('#latest-transcript-button');

    expect(actions?.contains(latestButton ?? null)).toBe(true);
    expect(controls?.contains(latestButton ?? null)).toBe(false);
    expect(actions?.parentElement).toBe(meetingView);
  });

  it('reserves a responsive layout row for the wrapping recording control bar', () => {
    expect(styles).toMatch(/\.meeting-view\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/su);
    expect(styles).toMatch(/\.meeting-controls\s*\{[^}]*position:\s*relative;/su);
    expect(styles).toMatch(/\.meeting-controls__inner\s*\{[^}]*flex-wrap:\s*wrap;/su);
  });

  it('keeps transcript-follow and recording control events wired', () => {
    expect(mainSource).toContain("elements.latestTranscriptButton.addEventListener('click', scrollToLatestTranscript)");
    expect(mainSource).toContain("elements.startButton.addEventListener('click', () => void startSession())");
    expect(mainSource).toContain("elements.stopButton.addEventListener('click', () => void pauseSession())");
  });

  it('keeps final-summary retry inside the readonly detail summary', () => {
    expect(mainSource).toContain('finalSummaryController.retry(options)');
    expect(mainSource).toContain('endedMeetingSnapshot');
    expect(document.querySelector('#final-summary')).not.toBeNull();
    expect(document.querySelector('#final-summary input, #final-summary select, #final-summary textarea')).toBeNull();
    expect(mainSource).not.toContain('localStorage');
  });

  it('creates one IndexedDB history repository without startup hydrate or history listing', () => {
    expect(mainSource.match(/new IndexedDbMeetingHistoryRepository\(window\.indexedDB\)/gu)).toHaveLength(1);
    expect(mainSource).not.toContain('meetingHistoryRepository.list(');
    expect(mainSource).not.toContain('meetingHistoryPersistence.hydrate');
  });

  it('saves the ended snapshot before finalization and retries from the fixed snapshot', () => {
    const initialSave = mainSource.indexOf('await meetingHistoryPersistence.saveEndedMeeting(endedSnapshot)');
    const finalization = mainSource.indexOf('await finalSummaryController.complete(createFinalSummaryOptions(endedSnapshot))');
    const optionsStart = mainSource.indexOf('function createFinalSummaryOptions(');
    const optionsEnd = mainSource.indexOf('async function retryFinalMeetingSummary', optionsStart);
    const optionsSource = mainSource.slice(optionsStart, optionsEnd);

    expect(initialSave).toBeGreaterThan(0);
    expect(finalization).toBeGreaterThan(initialSave);
    expect(optionsSource).toContain('snapshot?.sentences ?? []');
    expect(optionsSource).not.toContain('transcriptStore.snapshot()');
  });

  it('closes history storage on pagehide without clearing saved history', () => {
    expect(mainSource).toContain('meetingHistoryRepository?.close().catch(() => undefined)');
    expect(mainSource).not.toContain('meetingHistoryRepository?.clear()');
    expect(mainSource).not.toContain('meetingHistoryRepository.clear()');
  });

  it('keeps developer controls closed by default', () => {
    expect(document.querySelector<HTMLDetailsElement>('#developer-settings')?.open).toBe(false);
  });

  it('contains an explicit end meeting confirmation', () => {
    expect(document.querySelector('#end-meeting-dialog')?.textContent).toContain('この会議を終了しますか');
    expect(document.querySelector('#confirm-end-meeting-button')).not.toBeNull();
  });

  it('places summary and transcript in the same scrolling main region', () => {
    const scroller = document.querySelector('#transcript-scroll');
    expect(scroller?.querySelector('.live-summary')).not.toBeNull();
    expect(scroller?.querySelector('.live-transcript')).not.toBeNull();
  });

  it('provides every DOM element required during application initialization', () => {
    const requiredIds = [...mainSource.matchAll(/requiredElement<[^>]+>\('([^']+)'\)/gu)].map((match) => match[1]);
    expect(requiredIds.length).toBeGreaterThan(40);
    for (const id of requiredIds) expect(document.getElementById(id ?? '')).not.toBeNull();
  });

  it('does not duplicate element ids across the three views and overlays', () => {
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
