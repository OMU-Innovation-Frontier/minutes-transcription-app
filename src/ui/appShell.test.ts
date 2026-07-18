// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const html = readFileSync(resolve('index.html'), 'utf8');
const mainSource = readFileSync(resolve('src/main.ts'), 'utf8');

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
