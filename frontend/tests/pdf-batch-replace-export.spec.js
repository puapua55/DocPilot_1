import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');
const fontPath = 'C:/Windows/Fonts/arial.ttf';

test('equal-length batch replacement keeps source position and advance after page extraction', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(sourcePath) || !existsSync(fontPath), 'The supplied PDF or test font is unavailable');
  await page.goto('/');
  const result = await page.evaluate(async ({ source, font }) => {
    const { buildPdfWithTextEdits } = await import('/src/services/pdfOverlayConvertService.js');
    const { extractPdfPages } = await import('/src/services/pdfPageExtract.js');
    const { loadPdfDocument } = await import('/src/services/pdfService.js');
    const bytes = (base64) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const replacement = {
      id: 'page-two-pdf-to-txt', type: 'movable-text', pageNumber: 2,
      sourceText: 'PDF', originalText: 'PDF', text: 'TXT', displayText: 'TXT',
      sourcePageWidth: 610, sourcePageHeight: 342,
      coverX: 455.4, coverY: 93, coverWidth: 14.2992, coverHeight: 8,
      textX: 455.4, textY: 93, baseline: 101.28, fontSize: 6.72,
      textBoxWidth: 14.2992, sourceAdvanceWidth: 14.2992,
      textColor: [0, 45, 83], backgroundColor: [255, 255, 255],
      fontRuns: [{ text: 'TXT', fontSize: 6.72, letterSpacing: 0, fontCandidates: ['Arial'] }],
      sourceSelection: { selectedText: 'PDF', partialSelection: true },
      forceUnicodeFallback: true
    };
    const output = await buildPdfWithTextEdits({ sourceBytes: bytes(source), fontBytes: bytes(font),
      replacements: [replacement], skipRenderValidation: true });
    const extracted = await extractPdfPages(output.outputBytes, [2]);
    const { pdf, loadingTask } = await loadPdfDocument(extracted.buffer.slice(
      extracted.byteOffset, extracted.byteOffset + extracted.byteLength));
    try {
      const content = await (await pdf.getPage(1)).getTextContent();
      const items = content.items.filter((item) => typeof item.str === 'string');
      const index = items.findIndex((item) => item.str === 'TXT' && Math.abs(item.transform[4] - 455.4) < 2);
      const next = items.slice(index + 1).find((item) => item.str.trim());
      return { direct: output.textMoveResults?.[0]?.directDeleteSucceeded,
        text: items[index]?.str, next: next?.str, x: items[index]?.transform[4], width: items[index]?.width,
        baselineGap: Math.abs((items[index]?.transform[5] ?? -1000) - (next?.transform[5] ?? 1000)) };
    } finally {
      await loadingTask.destroy();
    }
  }, { source: readFileSync(sourcePath).toString('base64'), font: readFileSync(fontPath).toString('base64') });
  expect(result.direct).toBe(true);
  expect(result.text).toBe('TXT');
  expect(result.x).toBeCloseTo(455.4, 1);
  expect(result.width).toBeCloseTo(14.2992, 1);
  expect(result.next).toMatch(/^와/);
  expect(result.baselineGap).toBeLessThan(0.1);
});
