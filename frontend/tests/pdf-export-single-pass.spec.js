import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

for (const spacing of [-0.358086, 0, 1]) {
  test(`bundled text is searchable and painted once with spacing ${spacing}`, async ({ page }) => {
    const doc = await PDFDocument.create();
    doc.addPage([610, 342]);
    await page.goto('/');
    const result = await page.evaluate(async ({ source, spacing, constructPath }) => {
      const { buildPdfWithTextEdits } = await import('/src/services/pdfOverlayConvertService.js');
      const { loadPdfDocument } = await import('/src/services/pdfService.js');
      const text = '문서 검색 및 편집 지원 프로그램';
      const replacement = { id: 'title', type: 'added-text', pageNumber: 1, text,
        sourcePageWidth: 610, sourcePageHeight: 342, coverX: 20, coverY: 60, coverWidth: 550, coverHeight: 45,
        textX: 20, textY: 60, baseline: 90, fontSize: 24, textBoxWidth: 550,
        textColor: [0, 75, 135], letterSpacing: spacing, preserveFontSize: true, textAlign: 'right' };
      const reports = [];
      // Exercise both plain replacements and rich-run exports.
      for (const rich of [false, true]) {
        const r = { ...replacement, fontRuns: rich ? [{ text, fontSize: 24, letterSpacing: spacing,
          fontWeight: 'bold', preferBoldFont: true, fontStyle: 'italic', color: '#004b87' }] : [] };
        const saved = await buildPdfWithTextEdits({ sourceBytes: new Uint8Array(source), replacements: [r] });
        const { pdf, loadingTask } = await loadPdfDocument(saved.outputBytes.slice().buffer);
        try {
          const p = await pdf.getPage(1), content = await p.getTextContent(), ops = await p.getOperatorList();
          const canvas = document.createElement('canvas'), viewport = p.getViewport({ scale: 2 });
          canvas.width = viewport.width; canvas.height = viewport.height;
          const ctx = canvas.getContext('2d'); await p.render({ canvasContext: ctx, viewport }).promise;
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 150) ink++;
          const right = Math.max(...content.items.filter(i => i.str?.trim()).map(i => i.transform[4] + i.width));
          reports.push({ text: content.items.map(i => i.str).join(''), paths: ops.fnArray.filter(op => op === constructPath).length, ink, right });
        } finally { await loadingTask.destroy(); }
      }
      return reports;
    }, { source: Array.from(await doc.save()), spacing, constructPath: OPS.constructPath });
    for (const r of result) {
      expect(r.text.replace(/\s/g, '')).toBe('문서검색및편집지원프로그램');
      expect(r.paths).toBe(0);
      expect(r.ink).toBeGreaterThan(1000);
      expect(r.right).toBeCloseTo(570, 1);
    }
  });
}
