// Presentation only: existing buttons, events and persistence controllers remain authoritative.
const paths = {
  play: ['m8 5 12 7-12 7Z'],
  close: ['m6 6 12 12M6 18 18 6'],
  panel: ['M9 4v16', 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z'],
  chevron: ['m6 15 6-6 6 6'],
  refresh: ['M20 7a8 8 0 1 0 1 7M20 3v5h-5'],
  save: ['M5 3h12l4 4v14H3V3h2M7 3v6h10V3M7 21v-8h10v8'],
  summary: ['M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01'],
  share: ['M12 16V3m-4 4 4-4 4 4M5 12v9h14v-9'],
  download: ['M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'],
  edit: ['m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5'],
  trash: ['M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7'],
  check: ['m5 12 4 4L19 6'],
  down: ['M12 4v16m-7-7 7 7 7-7'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  mic: ['M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3'],
  stop: ['M6 6h12v12H6Z'],
  logout: ['M9 3H3v18h6M9 12h12m-5-5 5 5-5 5'],
  document: ['M14 2H4v20h16V8l-6-6ZM14 2v6h6M8 12h8M8 16h8'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'],
} satisfies Record<string, string[]>;
type Icon = keyof typeof paths;

export function createWorkspaceIcon(name: Icon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths[name]) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function iconFor(button: HTMLButtonElement, label: string): Icon {
  if (button.id === 'home-settings-button') return 'settings';
  if (button.id.includes('summary-toggle')) return 'chevron';
  if (/削除|クリア/.test(label)) return 'trash';
  if (/再試行|再読み込み|再接続|再生成|再作成/.test(label)) return 'refresh';
  if (/名前を変更/.test(label)) return 'edit';
  if (/最終要約を作って|要約/.test(label)) return 'summary';
  if (/共有/.test(label)) return 'share';
  if (/ダウンロード|PDFを保存/.test(label)) return 'download';
  if (/終了|保存/.test(label)) return 'save';
  if (/閉じる|キャンセル/.test(label)) return 'close';
  if (/原文/.test(label)) return 'document';
  if (/履歴|一覧/.test(label)) return 'panel';
  if (/最新/.test(label)) return 'down';
  if (/確定/.test(label)) return 'check';
  if (/停止/.test(label)) return 'stop';
  if (/録音/.test(label)) return 'mic';
  if (/退室/.test(label)) return 'logout';
  if (/続ける|現在の会議|再生/.test(label)) return 'play';
  return 'more';
}

export function decorateWorkspaceButton(button: HTMLButtonElement): void {
  if (button.closest('.choice-group') || button.classList.contains('history-entry__surface') || button.id === 'setup-glossary-save') return;
  const text = button.textContent?.trim() ?? '';
  const label = button.getAttribute('aria-label') || text || button.title;
  if (!label) return;
  button.classList.add('icon-action');
  button.removeAttribute('title');
  if (button.querySelector('svg')) return;
  const caption = document.createElement('span');
  caption.className = 'sr-only';
  caption.textContent = text || label;
  button.replaceChildren(createWorkspaceIcon(iconFor(button, label)), caption);
}

export function initializeWorkspacePresentation(): () => void {
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const tooltip = document.createElement('div');
  tooltip.className = 'workspace-tooltip';
  tooltip.hidden = true;
  document.body.append(tooltip);
  const hideTooltip = () => { tooltip.hidden = true; };
  const showTooltip = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button.icon-action') : null;
    if (!button || button.disabled) return;
    tooltip.textContent = button.getAttribute('aria-label') || button.textContent;
    tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tooltip.offsetWidth - 8, rect.left + rect.width / 2 - tooltip.offsetWidth / 2))}px`;
    tooltip.style.top = `${rect.top > tooltip.offsetHeight + 16 ? rect.top - tooltip.offsetHeight - 8 : rect.bottom + 8}px`;
  };
  document.addEventListener('pointerover', showTooltip, options);
  document.addEventListener('focusin', showTooltip, options);
  for (const type of ['pointerout', 'focusout', 'click', 'keydown']) document.addEventListener(type, hideTooltip, options);
  window.addEventListener('resize', hideTooltip, options);
  const mobile = window.matchMedia?.('(max-width: 760px)');
  const syncMobileSidebar = () => {
    const main = document.querySelector<HTMLElement>('.workspace-main');
    const sidebar = document.getElementById('workspace-sidebar');
    if (main && sidebar) main.inert = Boolean(mobile?.matches && !sidebar.hidden);
  };
  mobile?.addEventListener('change', syncMobileSidebar, options);
  syncMobileSidebar();
  const settingsButton = document.getElementById('home-settings-button');
  settingsButton?.replaceChildren(createWorkspaceIcon('settings'));

  const audio = document.querySelector<HTMLAudioElement>('#local-record-player');
  const playback = document.createElement('button');
  playback.type = 'button';
  playback.setAttribute('aria-label', '録音を再生');
  playback.hidden = true;
  if (audio) {
    audio.controls = false;
    audio.after(playback);
    const syncPlayback = () => {
      playback.hidden = audio.hidden;
      playback.setAttribute('aria-label', audio.paused ? '録音を再生' : '再生を停止');
      playback.replaceChildren(createWorkspaceIcon(audio.paused ? 'play' : 'stop'));
    };
    playback.addEventListener('click', () => {
      if (audio.paused) void audio.play().catch(() => {
        playback.setAttribute('aria-label', '再生できませんでした。再試行');
      });
      else audio.pause();
    }, options);
    for (const type of ['play', 'pause', 'ended']) audio.addEventListener(type, syncPlayback, options);
  }

  // Keep the existing select values/change events, but expose consistent radio choices.
  for (const select of document.querySelectorAll<HTMLSelectElement>('select')) {
    const group = document.createElement('div');
    group.className = 'choice-group';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', select.labels?.[0]?.querySelector('span')?.textContent ?? '表示設定');
    const choices: { option: HTMLOptionElement; button: HTMLButtonElement }[] = [];
    const sync = () => {
      for (const { option, button } of choices) {
        button.setAttribute('aria-checked', String(option.selected));
        button.hidden = option.hidden;
        button.disabled = select.disabled || option.disabled;
        button.tabIndex = option.selected && !button.hidden && !button.disabled ? 0 : -1;
      }
    };
    for (const option of select.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.text;
      button.dataset.value = option.value;
      button.setAttribute('role', 'radio');
      button.addEventListener('click', () => {
        if (select.disabled || option.disabled || option.hidden) return;
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
      }, options);
      choices.push({ option, button });
      group.append(button);
    }
    group.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...group.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const offset = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + offset + buttons.length) % buttons.length;
      buttons[index]?.click();
      buttons[index]?.focus();
    }, options);
    select.hidden = true;
    select.after(group);
    select.addEventListener('change', sync, options);
    const availabilityObserver = new MutationObserver(sync);
    availabilityObserver.observe(select, { attributes: true, subtree: true, attributeFilter: ['disabled', 'hidden'] });
    abort.signal.addEventListener('abort', () => availabilityObserver.disconnect(), { once: true });
    sync();
  }

  const detailToggle = document.querySelector<HTMLButtonElement>('#detail-summary-toggle');
  const detailContent = document.querySelector<HTMLElement>('#detail-summary-content');
  const setDetailExpanded = (expanded: boolean) => {
    if (!detailToggle || !detailContent) return;
    detailToggle.setAttribute('aria-expanded', String(expanded));
    detailToggle.setAttribute('aria-label', expanded ? '要約を閉じる' : '要約を表示');
    detailContent.hidden = !expanded;
  };
  detailToggle?.addEventListener('click', () => setDetailExpanded(detailContent?.hidden ?? true), options);
  detailContent?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    setDetailExpanded(false);
    detailToggle?.focus();
  }, options);

  const toastRegion = document.createElement('div');
  toastRegion.className = 'workspace-toasts';
  toastRegion.setAttribute('aria-label', '通知');
  document.body.append(toastRegion);
  const notifications = new Map<string, HTMLElement>();
  const previousMessages = new WeakMap<HTMLElement, string>();
  const sources = ['error-message', 'home-connection-error', 'buffer-warning', 'summary-warning', 'correction-warning', 'home-history-notification'];
  const syncToast = (source: HTMLElement) => {
    const message = source.hidden ? '' : source.textContent?.trim() ?? '';
    const previous = previousMessages.get(source);
    if (previous === message) return;
    previousMessages.set(source, message);
    if (previous && !sources.some(id => {
      const other = document.getElementById(id);
      return other && !other.hidden && other.textContent?.trim() === previous;
    })) {
      notifications.get(previous)?.remove();
      notifications.delete(previous);
    }
    if (!message || notifications.has(message)) return;
    const toast = document.createElement('div');
    toast.className = 'workspace-toast';
    toast.setAttribute('role', 'status');
    const body = document.createElement('p');
    body.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', '通知を閉じる');
    close.addEventListener('click', () => {
      toast.remove();
      notifications.delete(message);
      hideTooltip();
    }, options);
    decorateWorkspaceButton(close);
    toast.append(body, close);
    toastRegion.append(toast);
    notifications.set(message, toast);
  };
  for (const id of sources) document.getElementById(id)?.classList.add('sr-only');

  const decorate = (root: ParentNode) => {
    if (root instanceof HTMLButtonElement) decorateWorkspaceButton(root);
    for (const button of root.querySelectorAll<HTMLButtonElement>('button')) decorateWorkspaceButton(button);
    for (const trigger of root.querySelectorAll('.history-entry__actions > summary')) {
      if (!trigger.querySelector('svg')) trigger.replaceChildren(createWorkspaceIcon('more'));
    }
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const button = target?.closest('button');
      if (button instanceof HTMLButtonElement) decorateWorkspaceButton(button);
      for (const node of record.addedNodes) if (node instanceof Element) decorate(node);
    }
    for (const id of sources) {
      const source = document.getElementById(id);
      if (source) syncToast(source);
    }
    syncMobileSidebar();
    if (audio && playback.hidden !== audio.hidden) playback.hidden = audio.hidden;
  });
  decorate(document);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'hidden'] });
  return () => { observer.disconnect(); abort.abort(); tooltip.remove(); toastRegion.remove(); };
}
