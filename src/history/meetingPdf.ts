import type { MeetingRecord } from './meetingRecord';
import { createMeetingSummaryHtml } from './meetingSummaryHtml';

export async function createMeetingPdf(record: MeetingRecord): Promise<Uint8Array> {
  const content = createMeetingSummaryHtml(record);
  if ((content.textContent?.length ?? 0) > 100_000) {
    throw new Error('最終要約が長すぎるためPDFにできません。');
  }
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;';
  host.append(content);
  document.body.append(host);
  let overlay: HTMLElement | undefined;
  try {
    await document.fonts.ready;
    if (content.scrollHeight > 14_000) throw new Error('最終要約のページ数が上限を超えています。');
    const { default: html2pdf } = await import('html2pdf.js');
    const options = {
      margin: 10,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, backgroundColor: '#ffffff', logging: false },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const, compress: true },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['h1', 'h2', 'li', '.todo'] },
    };
    const worker = html2pdf().set(options).from(content).toContainer();
    overlay = await worker.get('overlay');
    const buffer = await worker.outputPdf('arraybuffer');
    return new Uint8Array(buffer);
  } finally {
    overlay?.remove();
    host.remove();
  }
}
