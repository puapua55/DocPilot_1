import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFDict, PDFName, decodePDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createPdfFont, embedPdfFont } from '../src/services/pdfFontEmbedService.js';
import { readPdfTables, writePdfTables } from '../src/services/pdfTableService.js';

const base64 = readFileSync(new URL('../public/fonts/NotoSansKR-Regular.base64.txt', import.meta.url), 'utf8').trim();
const bytes = Buffer.from(base64, 'base64');

async function embeddedFonts(saved) {
  const doc = await PDFDocument.load(saved);
  const fonts = doc.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict);
  return fonts.entries().map(([, ref]) => {
    const font = doc.context.lookup(ref);
    const cid = doc.context.lookup(font.lookup(PDFName.of('DescendantFonts')).get(0));
    const descriptor = cid.lookup(PDFName.of('FontDescriptor'));
    return fontkit.create(Buffer.from(decodePDFRawStream(descriptor.lookup(PDFName.of('FontFile2'))).decode()));
  });
}

test('regular and bold variable-font subsets contain valid R/1/C/2/3 glyphs after serialization', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 200]);
  const regular = await embedPdfFont(doc, bytes);
  const bold = await embedPdfFont(doc, bytes, { bold: true });
  const mixed = 'DocPilot 텍스트 추가 테스트 R1C2R3';
  page.drawText(mixed, { x: 20, y: 120, size: 10, font: regular });
  page.drawText(mixed, { x: 20, y: 80, size: 18, font: bold });
  // Later consumers may register another fontkit before deferred PDF save.
  doc.registerFontkit(fontkit);
  const saved = await doc.save();
  const fonts = await embeddedFonts(saved);
  assert.equal(fonts.length, 2);
  for (const font of fonts) {
    for (let id = 0; id < font.numGlyphs; id++) {
      assert.ok(font.loca.offsets[id] % 2 === 0, `unaligned glyph ${id}`);
      // Empty space glyphs are valid; all nonempty buffers must decode.
      if (font.loca.offsets[id + 1] > font.loca.offsets[id]) {
        assert.ok(font.getGlyph(id).path.commands.length > 0, `missing glyph ${id}`);
        assert.ok(Number.isFinite(font.getGlyph(id).bbox.minX), `invalid glyph ${id}`);
      }
    }
    assert.equal(font.loca.offsets.at(-1), font.directory.tables.glyf.length);
  }
  assert.ok(fonts[1].getGlyph(1).advanceWidth > fonts[0].getGlyph(1).advanceWidth);
  const task = getDocument({ data: saved.slice() });
  try {
    const p = await (await task.promise).getPage(1), viewport = p.getViewport({ scale: 4 });
    const canvas = createCanvas(viewport.width, viewport.height), ctx = canvas.getContext('2d');
    await p.render({ canvasContext: ctx, viewport }).promise;
    for (const [prefix, letter] of [['', 'D'], ['Doc', 'P']]) {
      const x = 20 + regular.widthOfTextAtSize(prefix, 10);
      const width = regular.widthOfTextAtSize(letter, 10);
      const pixels = ctx.getImageData(Math.ceil(x * 4), 280, Math.floor(width * 4) - 1, 48).data;
      let ink = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100) ink++;
      assert.ok(ink > 20, `${letter} must be visible, not just extractable`);
    }
  } finally { await task.destroy(); }
});

test('bundled font instances use requested weight rather than the Thin default', () => {
  const raw = fontkit.create(bytes);
  const regular = createPdfFont(bytes);
  const bold = createPdfFont(bytes, { bold: true });
  assert.equal(raw.variationAxes.wght.default, 100);
  assert.deepEqual(regular.variationCoords, [400]);
  assert.deepEqual(bold.variationCoords, [700]);
});

test('mixed regular/bold table cells retain valid glyphs, point size and text after repeated save', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(base64));
  const doc = await PDFDocument.create();
  doc.addPage([500, 400]);
  const table = { id: 'table', pageNumber: 1, sourcePageWidth: 500, sourcePageHeight: 400,
    currentRect: { x: 30, y: 30, width: 300, height: 108 }, rows: 3, columns: 3, fontSize: 10,
    cells: Array.from({ length: 9 }, (_, i) => `R${Math.floor(i / 3) + 1}C${i % 3 + 1}`),
    cellStyles: Array.from({ length: 9 }, (_, i) => ({ bold: i === 8, fontSize: i === 8 ? 18 : 10, color: '#14203a' })) };
  await writePdfTables(doc, [table]);
  let saved = await doc.save();
  const reopened = await PDFDocument.load(saved);
  const tables = await readPdfTables({ arrayBuffer: async () => saved });
  await writePdfTables(reopened, tables);
  saved = await reopened.save();
  for (const font of await embeddedFonts(saved)) {
    for (let id = 0; id < font.numGlyphs; id++) assert.ok(font.getGlyph(id).path.commands.length > 0);
  }
  const task = getDocument({ data: saved.slice() });
  try {
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(i => i.str?.trim());
    assert.deepEqual(items.map(i => i.str), table.cells);
    assert.deepEqual(items.map(i => i.height), [10, 10, 10, 10, 10, 10, 10, 10, 18]);
  } finally { await task.destroy(); }
  const finalTables = await readPdfTables({ arrayBuffer: async () => saved });
  assert.equal(finalTables.length, 1);
  assert.deepEqual(finalTables[0].cells, table.cells);
});
