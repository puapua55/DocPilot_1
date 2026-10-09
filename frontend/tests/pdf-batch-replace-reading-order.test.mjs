import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  capturePageDrawingStream, insertDrawingCommandsAtContentAnchors,
  removeSimpleMovedText, resetPageDrawingStream
} from '../src/services/pdfDirectTextEdit.js';
import { extractPdfPages } from '../src/services/pdfPageExtract.js';

const sourcePath = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');

test('replaced text stays in the source line after page extraction', async (context) => {
  let sourceBytes;
  try { sourceBytes = await readFile(sourcePath); }
  catch { context.skip('The supplied PDF is unavailable'); return; }

  const document = await PDFDocument.load(sourceBytes);
  const page = document.getPage(1);
  const replacement = {
    type: 'movable-text', pageNumber: 2,
    sourceText: 'PDF', originalText: 'PDF', text: 'tex', displayText: 'tex',
    sourcePageWidth: page.getWidth(), sourcePageHeight: page.getHeight(),
    coverX: 382.5, coverY: 173, coverWidth: 15.5, coverHeight: 12,
    textX: 383.16, textY: 173, fontSize: 10,
    sourceSelection: { selectedText: 'PDF', partialSelection: true },
    forceUnicodeFallback: true
  };
  const result = removeSimpleMovedText(document, [replacement]).get(replacement);
  assert.equal(result?.direct, true, result?.reason);
  assert.ok(result.contentOrderAnchor);

  replacement.contentOrderAnchor = result.contentOrderAnchor;
  replacement.contentOrderCtm = result.contentOrderCtm;
  resetPageDrawingStream(page);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('tex', { x: 383.16, y: 158.88, size: 10, font, color: rgb(0, 0.3, 0.5) });
  replacement.anchoredDrawingCommands = capturePageDrawingStream(page);
  insertDrawingCommandsAtContentAnchors(document, [replacement]);

  const extracted = await extractPdfPages(await document.save(), [2]);
  const loadingTask = getDocument({ data: new Uint8Array(extracted) });
  try {
    const pdf = await loadingTask.promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    const items = content.items.filter((item) => typeof item.str === 'string');
    const index = items.findIndex((item) => item.str === 'tex' && Math.abs(item.transform[4] - 383.16) < 2);
    assert.ok(index >= 0, 'the extracted page includes the replacement');
    const next = items.slice(index + 1).find((item) => item.str.trim());
    assert.ok(next?.str.startsWith('로 변환되었거나'), 'the next text item continues the same line');
    assert.ok(Math.abs(items[index].transform[5] - next.transform[5]) < 0.1,
      'the replacement shares the line baseline');
  } finally {
    await loadingTask.destroy();
  }
});
