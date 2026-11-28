// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decorateWorkspaceButton, initializeWorkspacePresentation } from './workspacePresentation';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe('workspace presentation', () => {
  it('keeps button text accessible and existing handlers intact', () => {
    const button = document.createElement('button');
    button.textContent = '文字起こしだけ保存';
    const click = vi.fn();
    button.addEventListener('click', click);
    decorateWorkspaceButton(button);
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.querySelector('.sr-only')?.textContent).toBe('文字起こしだけ保存');
    button.click();
    expect(click).toHaveBeenCalledOnce();
    decorateWorkspaceButton(button);
    expect(button.querySelectorAll('svg')).toHaveLength(1);
  });

  it('preserves labels on content-selection buttons', () => {
    document.body.innerHTML = '<button class="history-entry__surface">会議名</button><div class="choice-group"><button>日本語</button></div>';
    dispose = initializeWorkspacePresentation();
    expect(document.querySelector('svg')).toBeNull();
  });

  it('keeps changed labels and dynamically rendered actions as icons', async () => {
    document.body.innerHTML = '<button id="summary-toggle-button">要約を表示</button>';
    dispose = initializeWorkspacePresentation();
    const button = document.querySelector('button')!;
    button.textContent = '要約を閉じる';
    button.title = '要約を閉じる';
    await vi.waitFor(() => expect(button.querySelector('.sr-only')?.textContent).toBe('要約を閉じる'));
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.querySelectorAll('svg')).toHaveLength(1);
  });

  it('syncs keyboard-operable choices to the existing select and input/change handlers', () => {
    document.body.innerHTML = '<label><span>言語</span><select><option value="ja">日本語</option><option value="en">English</option></select></label>';
    const select = document.querySelector('select')!;
    const input = vi.fn();
    const change = vi.fn();
    select.addEventListener('input', input);
    select.addEventListener('change', change);
    dispose = initializeWorkspacePresentation();
    const choices = document.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    choices[0]!.focus();
    choices[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(select.value).toBe('en');
    expect(input).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(choices[1]);
    expect(choices[1]!.getAttribute('aria-checked')).toBe('true');
    expect(select.hidden).toBe(true);
  });

  it('opens saved summaries without a backdrop and closes with Escape', () => {
    document.body.innerHTML = '<button id="detail-summary-toggle" aria-expanded="false">要約を表示</button><div id="detail-summary-content" hidden><button>再試行</button></div>';
    dispose = initializeWorkspacePresentation();
    const toggle = document.querySelector<HTMLButtonElement>('#detail-summary-toggle')!;
    const content = document.querySelector<HTMLElement>('#detail-summary-content')!;
    toggle.click();
    expect(content.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(content.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it('deduplicates notices, renders text safely and lets users dismiss them', async () => {
    document.body.innerHTML = '<div id="error-message" hidden></div><div id="home-connection-error" hidden></div>';
    dispose = initializeWorkspacePresentation();
    for (const id of ['error-message', 'home-connection-error']) {
      const source = document.getElementById(id)!;
      source.textContent = '<img src=x onerror=alert(1)> 接続エラー';
      source.hidden = false;
    }
    await vi.waitFor(() => expect(document.querySelectorAll('.workspace-toast')).toHaveLength(1));
    expect(document.querySelector('.workspace-toast img')).toBeNull();
    document.querySelector<HTMLButtonElement>('.workspace-toast button')!.click();
    expect(document.querySelectorAll('.workspace-toast')).toHaveLength(0);
  });

  it('disconnects presentation observers on disposal', async () => {
    document.body.innerHTML = '<button>保存</button>';
    const cleanup = initializeWorkspacePresentation();
    cleanup();
    document.querySelector('button')!.textContent = '保存';
    await Promise.resolve();
    expect(document.querySelector('button svg')).toBeNull();
    expect(document.querySelector('.workspace-tooltip')).toBeNull();
  });

  it('removes resolved notifications instead of leaving stale errors on screen', async () => {
    document.body.innerHTML = '<div id="error-message" hidden></div>';
    dispose = initializeWorkspacePresentation();
    const error = document.getElementById('error-message')!;
    error.textContent = '接続を確認してください';
    error.hidden = false;
    await vi.waitFor(() => expect(document.querySelector('.workspace-toast')).not.toBeNull());
    error.hidden = true;
    await vi.waitFor(() => expect(document.querySelector('.workspace-toast')).toBeNull());
  });

  it('keeps the original layout constraints and new feature entry points', () => {
    const styles = readFileSync('src/styles.css', 'utf8') + readFileSync('src/ui/workspace.css', 'utf8');
    expect(styles).not.toMatch(/border-(?:top|left)\s*:/);
    expect(styles).not.toContain('font-variant-numeric');
    expect(styles).toMatch(/#workspace-start-button\s*\{[^}]*5\.25rem 50%/);
    expect(styles).toMatch(/#new-meeting-button\s*\{[^}]*1rem 50%/);
    expect(styles).toContain('@media (hover: none), (pointer: coarse)');
    document.body.innerHTML = readFileSync('index.html', 'utf8');
    expect(document.querySelector('.brand__mark')).toBeNull();
    expect(document.querySelector('.meeting-controls #elapsed-time')).not.toBeNull();
    for (const id of ['confirm-end-meeting-button', 'confirm-end-meeting-with-summary-button', 'meeting-share-dialog', 'rename-meeting-history-dialog', 'delete-meeting-history-dialog', 'setup-groq-model']) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.querySelectorAll('#meeting-setup-settings select')).toHaveLength(1);
    expect(document.querySelector('#meeting-setup-settings input')).toBeNull();
  });
});
