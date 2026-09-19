import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import { removeSimpleMovedText } from '../src/services/pdfDirectTextEdit.js';
import { buildPdfWithTextEdits } from '../src/services/pdfOverlayConvertService.js';

const fontBytes = Buffer.from(readFileSync(new URL('../public/fonts/NotoSansKR-Regular.base64.txt', import.meta.url), 'utf8').trim(), 'base64');
const fontOptions = { standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname };
async function inspect(bytes, pageNumber = 1, render = false) {
  const task = getDocument({ data: Uint8Array.from(bytes), ...fontOptions });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(pageNumber);
    const { items } = await page.getTextContent();
    let canvas;
    if (render) {
      const viewport = page.getViewport({ scale: 1 });
      canvas = createCanvas(viewport.width, viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    return { items: items.filter((item) => item.str?.trim()), canvas };
  } finally { await task.destroy(); }
}

async function fixture(texts = ['Move me', 'Keep me'], setup) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawRectangle({ x: 0, y: 0, width: 600, height: 800, color: rgb(0.8, 0.9, 1) });
  texts.forEach((text, i) => page.drawText(text, { x: 60, y: 700 - i * 60, size: 20, font }));
  await setup?.(doc, page, font);
  return doc.save();
}

function move(item, pageNumber = 1) {
  return {
    id: 'move-1', type: 'movable-text', pageNumber, text: item.str,
    sourceSelection: { wholeItem: true, text: item.str, transform: item.transform },
    sourcePageWidth: 600, sourcePageHeight: 800,
    coverX: item.transform[4], coverY: 800 - item.transform[5] - 20,
    coverWidth: item.width, coverHeight: 25,
    textX: 250, textY: 280, baseline: 300, fontSize: 20,
    // White would visibly destroy the blue background if direct removal used a cover.
    backgroundColor: [255, 255, 255], textColor: [0, 0, 0]
  };
}

test('save/reopen removes original text, keeps other text and background, inserts only moved text', async () => {
  const sourceBytes = await fixture();
  const { items } = await inspect(sourceBytes);
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [move(items[0])] });
  assert.equal(result.directEditCount, 1);
  assert.equal(result.fallbackCount, 0);
  const { items: saved, canvas } = await inspect(result.outputBytes, 1, true);
  assert.equal(saved.filter((item) => item.str === 'Move me').length, 1);
  assert.equal(saved.find((item) => item.str === 'Move me').transform[4], 250);
  assert.equal(saved.find((item) => item.str === 'Move me').transform[5], 500);
  assert.equal(saved.find((item) => item.str === 'Keep me').transform[5], 640);
  const pixels = canvas.getContext('2d').getImageData(61, 81, 80, 18).data;
  for (let i = 0; i < pixels.length; i += 4) {
    assert.ok(Math.abs(pixels[i] - 204) <= 1 && Math.abs(pixels[i + 1] - 230) <= 1 && pixels[i + 2] === 255);
  }
});

test('same text at a different position is not removed', async () => {
  const bytes = await fixture(['Same', 'Same']);
  const { items } = await inspect(bytes);
  const doc = await PDFDocument.load(bytes);
  const item = move(items[1]);
  assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, true);
  const saved = (await inspect(await doc.save())).items;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].transform[5], 700);
});

test('shared stream is cloned and other page remains unchanged', async () => {
  const bytes = await fixture(['Shared'], (doc, page) => {
    const second = doc.addPage([600, 800]);
    second.node.set(PDFName.of('Contents'), page.node.get(PDFName.of('Contents')));
    second.node.set(PDFName.of('Resources'), page.node.Resources());
  });
  const item = move((await inspect(bytes)).items[0]);
  const doc = await PDFDocument.load(bytes);
  assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, true);
  const saved = await doc.save();
  assert.equal((await inspect(saved)).items.length, 0);
  assert.equal((await inspect(saved, 2)).items[0].str, 'Shared');
});

test('retired unshared original streams are not serialized as orphan objects', async () => {
  const bytes = await fixture(['UniqueSecret']);
  const doc = await PDFDocument.load(bytes);
  const item = move((await inspect(bytes)).items[0]);
  assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, true);
  const saved = await PDFDocument.load(await doc.save());
  const hex = Buffer.from('UniqueSecret').toString('hex').toUpperCase();
  for (const [, object] of saved.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      const source = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
      assert.ok(!source.includes(hex) && !source.includes('UniqueSecret'));
    }
  }
});

for (const variant of ['partial', 'wrong-position', 'duplicate', 'rotation', 'unsupported', 'overlap']) {
  test(`${variant} falls back without mutating original page`, async () => {
    const bytes = await fixture(['Move me']);
    const item = move((await inspect(bytes)).items[0]);
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    let replacements = [item];
    if (variant === 'partial') { item.text = 'Move'; item.sourceSelection.wholeItem = false; }
    if (variant === 'wrong-position') item.sourceSelection.transform[4] += 10;
    if (variant === 'duplicate') replacements.push({ ...item, id: 'move-2' });
    if (variant === 'rotation') page.node.set(PDFName.of('Rotate'), doc.context.obj(90));
    if (variant === 'unsupported') page.node.addContentStream(doc.context.register(doc.context.flateStream('/Image Do')));
    if (variant === 'overlap') replacements.push({ ...item, type: 'replacement', text: 'New' });
    const originalContents = page.node.get(PDFName.of('Contents'));
    const result = removeSimpleMovedText(doc, replacements).get(item);
    assert.equal(result.direct, false);
    assert.ok(result.reason);
    assert.equal(page.node.get(PDFName.of('Contents')), originalContents);
  });
}

async function streamFixture(content) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  return doc.save();
}

test('literal escapes, comments, zero-adjustment TJ and compressed streams are parsed', async () => {
  for (const show of ['(Move \\(me\\)) Tj', '[(Move ) 0 (\\050me\\051)] TJ']) {
    const bytes = await streamFixture(`% (unclosed string in comment\nBT /F1 20 Tf 60 700 Td ${show} ET`);
    const item = move((await inspect(bytes)).items[0]);
    assert.equal(item.text, 'Move (me)');
    const doc = await PDFDocument.load(bytes);
    assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, true);
    assert.equal((await inspect(await doc.save())).items.length, 0);
  }
});

test('multiple shows in one text object and nonzero kerning remain untouched', async () => {
  for (const show of ['(Move me) Tj 0 -60 Td (Keep me) Tj', '[(Move) -200 (me)] TJ']) {
    const bytes = await streamFixture(`BT /F1 20 Tf 60 700 Td ${show} ET`);
    const item = move((await inspect(bytes)).items[0]);
    const doc = await PDFDocument.load(bytes);
    assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, false);
    assert.ok((await inspect(await doc.save())).items.length > 0);
  }
});

test('ambiguous overprinted text remains untouched', async () => {
  const bytes = await streamFixture('BT /F1 20 Tf 60 700 Td (Move me) Tj ET BT /F1 20 Tf 60 700 Td (Move me) Tj ET');
  const item = move((await inspect(bytes)).items[0]);
  const doc = await PDFDocument.load(bytes);
  assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, false);
});

test('hybrid save supports direct move, overlay move and normal replacement together', async () => {
  const sourceBytes = await fixture(['Direct', 'Fallback', 'Replace']);
  const { items } = await inspect(sourceBytes);
  const direct = move(items[0]);
  const fallback = { ...move(items[1]), id: 'fallback', sourceSelection: null, textY: 380, baseline: 400 };
  const replacement = { ...move(items[2]), type: 'replacement', text: '교체', textY: 480, baseline: 500 };
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [direct, fallback, replacement] });
  assert.equal(result.directEditCount, 1);
  assert.equal(result.fallbackCount, 1);
  assert.equal(result.textMoveResults[1].method, 'overlay');
  const { items: saved } = await inspect(result.outputBytes);
  assert.equal(saved.filter((item) => item.str === 'Direct').length, 1);
  assert.equal(saved.filter((item) => item.str === 'Fallback').length, 2);
  assert.ok(saved.some((item) => item.str === '교체'));
});

test('all fallback covers are painted before moved text at another source position', async () => {
  const sourceBytes = await fixture(['First', 'Second']);
  const { items } = await inspect(sourceBytes);
  const first = { ...move(items[0]), sourceSelection: null, textX: 60, textY: 140, baseline: 157 };
  const second = { ...move(items[1]), sourceSelection: null, id: 'second' };
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [first, second] });
  const { canvas } = await inspect(result.outputBytes, 1, true);
  const pixels = canvas.getContext('2d').getImageData(60, 140, 50, 20).data;
  let dark = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80) dark++;
  assert.ok(dark > 20);
});

test('embedded Korean font uses overlay even when the whole text item is selected', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  doc.addPage([600, 800]).drawText('한글 이동', { x: 60, y: 700, size: 20, font });
  const sourceBytes = await doc.save();
  const item = move((await inspect(sourceBytes)).items[0]);
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [item] });
  assert.equal(result.directEditCount, 0);
  assert.equal(result.fallbackCount, 1);
  const { items } = await inspect(result.outputBytes);
  assert.equal(items.filter((entry) => entry.str === '한글 이동').length, 2);
});
