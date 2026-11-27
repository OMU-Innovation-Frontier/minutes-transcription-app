import { downloadMeetingFile, meetingExportTitle } from './meetingExport';
import type { MeetingRecord } from './meetingRecord';

export function initializeMeetingShareDialog(elements: {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  download: HTMLButtonElement;
  nativeShare: HTMLButtonElement;
  status: HTMLElement;
}) {
  let active: { record: MeetingRecord; file?: File } | null = null;
  let preparation = Promise.resolve();

  elements.dialog.addEventListener('close', () => {
    if (elements.dialog.open) return;
    active = null;
    elements.title.textContent = '';
  });

  function prepare(request: NonNullable<typeof active>): void {
    elements.download.disabled = true;
    elements.download.textContent = 'PDFを保存';
    elements.nativeShare.hidden = true;
    elements.status.textContent = 'PDFを作成しています。';

    preparation = preparation.then(async () => {
      if (active !== request || !elements.dialog.open) return;
      try {
        const { createMeetingPdfFile } = await import('./meetingPdf');
        const file = await createMeetingPdfFile(request.record);
        if (active !== request || !elements.dialog.open) return;
        request.file = file;
        elements.nativeShare.disabled = false;
        elements.nativeShare.hidden = typeof navigator.share !== 'function'
          || !navigator.canShare?.({ files: [file] });
        elements.status.textContent = '';
      } catch {
        if (active !== request || !elements.dialog.open) return;
        elements.download.textContent = 'PDFを再作成';
        elements.status.textContent = 'PDFを作成できませんでした。';
      } finally {
        if (active === request && elements.dialog.open) elements.download.disabled = false;
      }
    });
  }

  elements.download.addEventListener('click', () => {
    if (!active || elements.download.disabled) return;
    if (!active.file) { prepare(active); return; }
    try {
      downloadMeetingFile(active.file, active.file.name);
      elements.status.textContent = 'PDFのダウンロードを開始しました。送り先で添付してください。';
    } catch {
      elements.status.textContent = 'PDFを保存できませんでした。もう一度お試しください。';
    }
  });

  elements.nativeShare.addEventListener('click', async () => {
    const request = active;
    if (!request?.file || elements.nativeShare.disabled) return;
    elements.nativeShare.disabled = true;
    try {
      await navigator.share({ files: [request.file] });
      if (active === request && elements.dialog.open) elements.status.textContent = 'PDFを共有メニューに渡しました。';
    } catch (error) {
      if (active !== request || !elements.dialog.open) return;
      elements.status.textContent = error instanceof DOMException && error.name === 'AbortError'
        ? '共有をキャンセルしました。'
        : '共有メニューを使えませんでした。PDFを保存して添付してください。';
    } finally {
      if (active === request && elements.dialog.open) elements.nativeShare.disabled = false;
    }
  });

  return {
    open(record: MeetingRecord): void {
      if (elements.dialog.open) return;
      active = { record };
      elements.title.textContent = meetingExportTitle(record);
      elements.dialog.showModal();
      prepare(active);
    },
  };
}
