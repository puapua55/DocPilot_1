import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import { EXPERIMENTAL_UNSAFE_DIRECT_EDIT, removeSimpleMovedText } from '../src/services/pdfDirectTextEdit.js';
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

async function inspectFontMetadata(bytes, pageNumber = 1) {
  const document = await PDFDocument.load(bytes);
  const page = document.getPage(pageNumber - 1);
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  return fonts ? Array.from(fonts.entries()).map(([resource, ref]) => {
    const font = document.context.lookup(ref, PDFDict);
    return {
      resourceName: resource.decodeText(),
      baseFont: font.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText() || '',
      subtype: font.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() || '',
      hasToUnicode: Boolean(font.lookup(PDFName.of('ToUnicode'))),
      hasDescendants: Boolean(font.lookup(PDFName.of('DescendantFonts')))
    };
  }) : [];
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
  assert.equal(result.originalFontReuseCount, 1);
  assert.equal(result.fallbackCount, 0);
  assert.equal(result.failedCount, 0);
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

test('saved replacement is inserted into the visual line reading order for standard PDF selection', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  // Intentionally write the right-hand word first, as commonly happens after
  // a prior overlay save, then replace the visually preceding word.
  page.drawText('and tail', { x: 125, y: 700, size: 20, font });
  page.drawText('Alpha', { x: 60, y: 700, size: 20, font });
  const sourceBytes = await doc.save();
  const alpha = (await inspect(sourceBytes)).items.find((item) => item.str === 'Alpha');
  const result = await buildPdfWithTextEdits({
    sourceBytes,
    fontBytes,
    replacements: [{
      id: 'replace-alpha', type: 'pdf', pageNumber: 1, sourceText: 'Alpha', originalText: 'Alpha',
      replacementText: 'Omega', text: 'Omega', forceUnicodeFallback: true,
      sourcePageWidth: 600, sourcePageHeight: 800,
      coverX: alpha.transform[4], coverY: 800 - alpha.transform[5] - 20,
      coverWidth: alpha.width, coverHeight: 24,
      textX: alpha.transform[4], textY: 80, baseline: 100, fontSize: 20,
      fontCandidates: []
    }]
  });
  const saved = (await inspect(result.outputBytes)).items.map((item) => item.str);
  assert.deepEqual(saved.slice(0, 2), ['Omega', 'and tail'], JSON.stringify(result.replacementResults));
  assert.equal(saved.includes('Alpha'), false);
});

test('bold and italic Type1 resource is reused at the moved location', async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.TimesRomanBoldItalic);
  document.addPage([600, 800]).drawText('Bold italic', { x: 60, y: 700, size: 20, font, color: rgb(0.1, 0.2, 0.6) });
  const sourceBytes = await document.save();
  const beforeFonts = await inspectFontMetadata(sourceBytes);
  const { items } = await inspect(sourceBytes);
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [move(items[0])] });
  const afterFonts = await inspectFontMetadata(result.outputBytes);
  assert.equal(result.originalFontReuseCount, 1);
  assert.equal(result.textMoveResults[0].sourceFont.baseFont, 'Times-BoldItalic');
  assert.equal(result.textMoveResults[0].sourceFont.subtype, 'Type1');
  assert.deepEqual(afterFonts, beforeFonts);
  const { items: saved } = await inspect(result.outputBytes);
  assert.equal(saved.filter((item) => item.str === 'Bold italic').length, 1);
  assert.equal(saved[0].transform[4], 250);
  assert.equal(saved[0].transform[5], 500);
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

test('repeated text moves only the selected position while preserving the original font', async () => {
  const sourceBytes = await fixture(['Same', 'Same']);
  const { items } = await inspect(sourceBytes);
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [move(items[1])] });
  const saved = (await inspect(result.outputBytes)).items.filter((item) => item.str === 'Same');
  assert.equal(result.originalFontReuseCount, 1);
  assert.equal(saved.length, 2);
  assert.ok(saved.some((item) => item.transform[4] === 60 && item.transform[5] === 700));
  assert.ok(saved.some((item) => item.transform[4] === 250 && item.transform[5] === 500));
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
    const expectedDirect = EXPERIMENTAL_UNSAFE_DIRECT_EDIT
      && ['duplicate', 'overlap'].includes(variant);
    assert.equal(result.direct, expectedDirect);
    if (!expectedDirect) {
      assert.ok(result.reason);
      assert.equal(page.node.get(PDFName.of('Contents')), originalContents);
    }
  });
}

test('partial selection rewrites one Tj command without a background cover', async () => {
  const sourceBytes = await fixture(['Document and editing']);
  const original = (await inspect(sourceBytes)).items[0];
  const item = move(original);
  item.text = 'or';
  item.displayText = 'or';
  item.forceUnicodeFallback = true;
  item.coverSourceOnFallback = true;
  item.sourceText = 'and';
  item.originalText = 'and';
  item.sourceSelection = {
    wholeItem: false,
    partialSelection: true,
    text: original.str,
    selectedText: 'and',
    startOffset: original.str.indexOf('and'),
    endOffset: original.str.indexOf('and') + 3,
    transform: original.transform
  };
  item.coverX = original.transform[4] + 96;
  item.coverWidth = 34;
  item.textX = item.coverX;
  item.textY = 80;
  item.baseline = 100;
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [item] });
  assert.equal(result.directDeleteCount, 1);
  assert.equal(result.fallbackOverlayCount, 0);
  assert.equal(result.textMoveResults[0].deleteMode, 'partial-string');
  assert.equal(result.textMoveResults[0].shouldApplyCover, false);
  const text = (await inspect(result.outputBytes)).items.map((entry) => entry.str).join(' ');
  assert.equal(text, 'Document or editing');
});

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

test('multiple shows in one text object remain untouched', async () => {
  const bytes = await streamFixture('BT /F1 20 Tf 60 700 Td (Move me) Tj 0 -60 Td (Keep me) Tj ET');
  const item = move((await inspect(bytes)).items[0]);
  const doc = await PDFDocument.load(bytes);
  assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, false);
  assert.ok((await inspect(await doc.save())).items.length > 0);
});

test('nonzero Tc and TJ adjustments are removable as one complete text object', async () => {
  const bytes = await streamFixture('BT /F1 20 Tf -0.0663 Tc 60 700 Td [(Move) -200 ( me)] TJ ET');
  const item = move((await inspect(bytes)).items[0]);
  const doc = await PDFDocument.load(bytes);
  assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, true);
  assert.equal((await inspect(await doc.save())).items.length, 0);
});

test('marked content surrounding a text object does not block direct deletion', async () => {
  const bytes = await streamFixture('/Document /MC0 BDC BT /F1 20 Tf -0.0663 Tc 60 700 Td [(Move) -200 ( me)] TJ ET EMC');
  const item = move((await inspect(bytes)).items[0]);
  const doc = await PDFDocument.load(bytes);
  assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, true);
  assert.equal((await inspect(await doc.save())).items.length, 0);
});

test('ambiguous overprinted text follows the configured direct-edit mode', async () => {
  const bytes = await streamFixture('BT /F1 20 Tf 60 700 Td (Move me) Tj ET BT /F1 20 Tf 60 700 Td (Move me) Tj ET');
  const item = move((await inspect(bytes)).items[0]);
  const doc = await PDFDocument.load(bytes);
  assert.equal(removeSimpleMovedText(doc, [item]).get(item).direct, EXPERIMENTAL_UNSAFE_DIRECT_EDIT);
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
  assert.equal(result.noCoverUnresolvedCount, 1);
  assert.equal(result.textMoveResults[1].method, 'no-cover-fallback');
  const { items: saved } = await inspect(result.outputBytes);
  assert.equal(saved.filter((item) => item.str === 'Direct').length, 1);
  assert.equal(saved.filter((item) => item.str === 'Fallback').length, 2);
  assert.ok(saved.some((item) => item.str === '교체'));
});

test('instant replacement preserves adjacent glyph objects in DOCX-style split Korean text', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const page = doc.addPage([600, 800]);
  // DOCX-to-PDF output can emit each character as its own BT/ET object.
  // The digits must remain when only the preceding "시험" range is replaced.
  for (const [text, x] of [['시', 60], ['험', 80], ['1', 100], ['시', 180], ['험', 200], ['2', 220]]) {
    page.drawText(text, { x, y: 700, size: 20, font });
  }
  const sourceBytes = await doc.save();
  const { items } = await inspect(sourceBytes);
  const at = (x) => items.find((item) => Math.abs(item.transform[4] - x) < 0.1);
  const replacement = (id, first) => ({
    id,
    type: 'pdf',
    pageNumber: 1,
    sourcePageWidth: 600,
    sourcePageHeight: 800,
    coverX: first.transform[4],
    coverY: 800 - first.transform[5] - 20,
    coverWidth: 40,
    coverHeight: 20,
    textX: first.transform[4],
    textY: 800 - first.transform[5] - 20,
    baseline: 800 - first.transform[5],
    fontSize: 20,
    sourceText: '시험',
    sourceFullText: '',
    originalText: '시험',
    replacementText: '테스트',
    newText: '테스트',
    text: '테스트',
    textColor: [0, 0, 0],
    backgroundColor: [255, 255, 255],
    forceUnicodeFallback: true
  });
  const result = await buildPdfWithTextEdits({
    sourceBytes,
    fontBytes,
    replacements: [replacement('first', at(60)), replacement('second', at(180))]
  });
  assert.equal(result.pdfDirectReplaceCount, 2);
  assert.equal(result.pdfOverlayFallbackCount, 0);
  const { items: saved } = await inspect(result.outputBytes);
  assert.equal(saved.filter((item) => item.str === '시험').length, 0);
  assert.equal(saved.filter((item) => item.str === '테스트').length, 2);
  assert.deepEqual(saved.filter((item) => /^[12]$/.test(item.str)).map((item) => item.str).sort(), ['1', '2']);
});

test('instant replacement does not rewrite unrelated text in one source object', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  doc.addPage([600, 800]).drawText('앞부분 시험1 뒷부분', { x: 60, y: 700, size: 20, font });
  const sourceBytes = await doc.save();
  const source = (await inspect(sourceBytes)).items[0];
  const result = await buildPdfWithTextEdits({
    sourceBytes,
    fontBytes,
    replacements: [{
      id: 'partial-object', type: 'pdf', pageNumber: 1,
      sourcePageWidth: 600, sourcePageHeight: 800,
      coverX: source.transform[4], coverY: 80, coverWidth: source.width, coverHeight: 20,
      textX: source.transform[4], textY: 80, baseline: 100, fontSize: 20,
      sourceText: '시험', sourceFullText: source.str, originalText: '시험',
      replacementText: '테스트', newText: '테스트', text: '테스트',
      textColor: [0, 0, 0], backgroundColor: [255, 255, 255], forceUnicodeFallback: true
    }]
  });
  assert.equal(result.pdfDirectReplaceCount, 0);
  assert.equal(result.pdfFullObjectRewriteCount, 0);
  assert.equal(result.pdfOverlayFallbackCount, 1);
  const { items } = await inspect(result.outputBytes);
  assert.ok(items.some((item) => item.str === '앞부분 시험1 뒷부분'));
  assert.ok(items.some((item) => item.str === '테스트'));
});

test('glyph preview movable text always saves the complete Unicode displayText', async () => {
  const sourceBytes = await fixture(['DocPilot']);
  const item = move((await inspect(sourceBytes)).items[0]);
  item.displayText = 'DocPilot';
  item.forceUnicodeFallback = true;
  item.originalGlyphText = '\u0001\u0002\u0003';
  item.sourceFont = { glyphText: item.originalGlyphText };
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [item] });
  const debug = result.textMoveResults[0];
  assert.equal(result.originalFontReuseCount, 0);
  assert.equal(result.fallbackOverlayCount, 0);
  assert.equal(debug.displayText, 'DocPilot');
  assert.equal(debug.drawnText, 'DocPilot');
  assert.equal(debug.drawnTextLength, 8);
  assert.equal(debug.fallbackUsed, false);
  assert.match(debug.reason, /Unicode/);
  assert.equal(debug.directRemoval, true);
  const saved = (await inspect(result.outputBytes)).items;
  assert.equal(saved.filter((entry) => entry.str === 'DocPilot').length, 1);
});

test('Korean fallback embeds the complete font and preserves every display character', async () => {
  const sourceBytes = await fixture(['Source']);
  const { items } = await inspect(sourceBytes);
  const fallbackText = '색·편집·저장 기능을 하나의 프로그램에서 제공하기 위해 추진됩니다.';
  const item = {
    ...move(items[0]), sourceSelection: null, text: fallbackText, displayText: fallbackText,
    textX: 20, textY: 280, baseline: 300
  };
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [item] });
  const debug = result.textMoveResults[0];
  assert.equal(debug.fallbackUsed, true);
  assert.equal(debug.drawnText, fallbackText);
  assert.equal(debug.drawnTextLength, [...fallbackText].length);
  const saved = (await inspect(result.outputBytes)).items;
  assert.ok(saved.some((entry) => entry.str === fallbackText));
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

test('embedded Type0 Korean font with ToUnicode reuses the original font and glyph bytes', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  doc.addPage([600, 800]).drawText('한글 이동', { x: 60, y: 700, size: 20, font });
  const sourceBytes = await doc.save();
  const beforeFonts = await inspectFontMetadata(sourceBytes);
  const item = move((await inspect(sourceBytes)).items[0]);
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [item] });
  assert.equal(result.directEditCount, 1);
  assert.equal(result.originalFontReuseCount, 1);
  assert.equal(result.fallbackCount, 0);
  assert.equal(result.textMoveResults[0].sourceFont.subtype, 'Type0');
  assert.equal(result.textMoveResults[0].sourceFont.embedded, true);
  assert.equal(result.textMoveResults[0].sourceFont.toUnicodeMapped, true);
  assert.deepEqual(await inspectFontMetadata(result.outputBytes), beforeFonts);
  const { items } = await inspect(result.outputBytes);
  assert.equal(items.filter((entry) => entry.str === '한글 이동').length, 1);
  assert.equal(items.find((entry) => entry.str === '한글 이동').transform[4], 250);
});

test('Type0 font without ToUnicode falls back without a cover and remains readable', async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  doc.addPage([600, 800]).drawText('한글 이동', { x: 60, y: 700, size: 20, font });
  const originalBytes = await doc.save();
  const item = move((await inspect(originalBytes)).items[0]);
  const source = await PDFDocument.load(originalBytes);
  const fonts = source.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict);
  for (const [, ref] of fonts.entries()) source.context.lookup(ref, PDFDict).delete(PDFName.of('ToUnicode'));
  const result = await buildPdfWithTextEdits({ sourceBytes: await source.save(), fontBytes, replacements: [item] });
  assert.equal(result.originalFontReuseCount, 0);
  assert.equal(result.fallbackOverlayCount, 0);
  assert.match(result.fallbackReasons[0].reason, /ToUnicode/);
  const { canvas } = await inspect(result.outputBytes, 1, true);
  assert.ok(canvas.width > 0 && canvas.height > 0);
});

test('table line and colored background remain when the original font is reused', async () => {
  const sourceBytes = await fixture(['Cell text'], async (_doc, page) => {
    page.drawLine({ start: { x: 50, y: 650 }, end: { x: 50, y: 750 }, thickness: 2, color: rgb(0, 0, 0) });
  });
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [move((await inspect(sourceBytes)).items[0])] });
  assert.equal(result.originalFontReuseCount, 1);
  const { canvas } = await inspect(result.outputBytes, 1, true);
  const line = canvas.getContext('2d').getImageData(50, 100, 1, 1).data;
  assert.ok(line[0] < 20 && line[1] < 20 && line[2] < 20);
  const background = canvas.getContext('2d').getImageData(61, 81, 1, 1).data;
  assert.ok(Math.abs(background[0] - 204) <= 1 && Math.abs(background[1] - 230) <= 1 && background[2] === 255);
});
