import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { visibleTextItemIndices } from '../src/services/pdfTextVisibility.js';

test('a later replacement removes covered source text from the selectable layer', () => {
  const item = (str, x, width, y = 100) => ({ str, width, transform: [12, 0, 0, 12, x, y] });
  const indices = visibleTextItemIndices([
    item('original phrase', 10, 100), item('next row', 10, 80, 80),
    item('new', 10, 30), item('phrase', 41, 69)
  ]);
  assert.deepEqual(indices, [2, 3, 1]);
});

test('the supplied converted PDF retains one selectable copy of the replaced line', async (context) => {
  const source = new URL('../../DocPilot_문서 검색 및 편집 지원 프로그램_overlay_converted.pdf', import.meta.url);
  if (!existsSync(source)) return context.skip('Local PDF is unavailable');
  const task = getDocument({ data: new Uint8Array(readFileSync(source)), useSystemFonts: true });
  try {
    const page = await (await task.promise).getPage(2);
    const items = (await page.getTextContent()).items;
    const ordered = visibleTextItemIndices(items);
    const visible = new Set(ordered);
    const sourceLine = items.findIndex((item) => item.str.startsWith('찾고 수정해야'));
    const overlayLine = items.findIndex((item) => item.str.startsWith('찾고,'));
    assert.ok(sourceLine >= 0 && overlayLine > sourceLine);
    assert.equal(visible.has(sourceLine), false);
    assert.equal(visible.has(overlayLine), true);
    assert.equal(visible.has(items.findIndex((item) => item.str.startsWith('문서나 편집이'))), true);
    assert.ok(ordered.indexOf(overlayLine) < ordered.indexOf(items.findIndex((item) => item.str.startsWith('문서나 편집이'))));
  } finally { await task.destroy(); }
});
