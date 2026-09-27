import { test, expect } from '@playwright/test';
import { jsPDF } from 'jspdf';
import { readFileSync } from 'node:fs';

test('교체 글자는 확대 비율을 따르고 저장 후 한글이 렌더링된다', async ({ page }) => {
  const pdf = new jsPDF({ unit: 'pt' });
  pdf.addFileToVFS('font.ttf', readFileSync(new URL('../public/fonts/NotoSansKR-Regular.base64.txt', import.meta.url), 'utf8').trim());
  pdf.addFont('font.ttf', 'Korean', 'normal');
  pdf.setFont('Korean'); pdf.setFontSize(20); pdf.text('테스트', 60, 100);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf.output('arraybuffer')) });
  for (const zoom of [100, 150, 200]) {
    while (parseInt(await page.locator('.zoom-value').innerText(), 10) < zoom) await page.getByRole('button', { name: '확대', exact: true }).click();
    await expect(page.locator('.textLayer').first()).toHaveAttribute('data-rendered', 'true');
    const result = await page.evaluate(async () => {
      const { createReplacementPreviewFromTextLayer } = await import('/src/services/highlightService.js');
      const el = document.querySelector('.pdf-page');
      const [item] = createReplacementPreviewFromTextLayer(el, { originalText: '테스트', newText: '변환자' });
      return item;
    });
    expect(result.text.fontSize).toBeCloseTo(20 * zoom / 100, 1);
    // Recreate the same export contract without depending on modal selection UI.
    await page.evaluate((item) => {
      document.querySelector('.replacement-layer')?.remove();
      const layer = document.createElement('div'); layer.className = 'replacement-layer';
      const entry = document.createElement('div');
      const cover = document.createElement('div'); cover.className = 'replacement-cover';
      Object.assign(cover.style, { left: `${item.cover.x}px`, top: `${item.cover.y}px`, width: `${item.cover.width}px`, height: `${item.cover.height}px` });
      const text = document.createElement('div'); text.className = 'replacement-text'; text.textContent = item.text.value;
      text.dataset.baseline = item.text.baseline;
      Object.assign(text.style, { left: `${item.text.x}px`, top: `${item.text.y}px`, fontSize: `${item.text.fontSize}px` });
      entry.append(cover, text); layer.append(entry); document.querySelector('.pdf-page').append(layer);
    }, result);
    const downloaded = page.waitForEvent('download');
    await page.evaluate(async (data) => {
      const { convertPdfWithOriginalOverlay } = await import('/src/services/pdfOverlayConvertService.js');
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      await convertPdfWithOriginalOverlay({ file: new File([bytes], 'sample.pdf', { type: 'application/pdf' }) });
    }, Buffer.from(pdf.output('arraybuffer')).toString('base64'));
    const bytes = readFileSync(await (await downloaded).path());
    const rendered = await page.evaluate(async (data) => {
      const { loadPdfDocument } = await import('/src/services/pdfService.js');
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const { pdf, loadingTask } = await loadPdfDocument(bytes.buffer);
      try {
        const p = await pdf.getPage(1); const content = await p.getTextContent();
        const canvas = document.createElement('canvas'); canvas.width = 595; canvas.height = 842;
        const ctx = canvas.getContext('2d'); await p.render({ canvasContext: ctx, viewport: p.getViewport({ scale: 1 }) }).promise;
        const pixels = ctx.getImageData(60, 75, 50, 30).data;
        let dark = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i+1] < 100 && pixels[i+2] < 100) dark++;
        return { dark, text: content.items.map((i) => i.str).join(' ') };
      } finally { await loadingTask.destroy(); }
    }, bytes.toString('base64'));
    expect(rendered.text).toContain('변환자');
    expect(rendered.dark).toBeGreaterThan(40);
  }
});
