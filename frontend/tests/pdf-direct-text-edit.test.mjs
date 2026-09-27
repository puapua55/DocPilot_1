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

test('table PDF deletes only the selected split glyph commands before moving text', async () => {
  const sourceBytes = readFileSync(new URL('../../테스트표.pdf', import.meta.url));
  const { items } = await inspect(sourceBytes);
  const original = items.find((item) => item.str === '테스트1');
  const item = {
    id: 'table-partial', type: 'movable-text', pageNumber: 1,
    text: '테스트', displayText: '테스트', forceUnicodeFallback: true,
    sourceSelection: { wholeItem: false, partialSelection: true, selectedText: '테스트', text: original.str, transform: original.transform },
    sourcePageWidth: 595.3, sourcePageHeight: 841.9,
    coverX: original.transform[4], coverY: 841.9 - original.transform[5] - original.height,
    coverWidth: 30, coverHeight: original.height,
    textX: 150, textY: 100, baseline: 108, fontSize: 10,
    backgroundColor: [255, 255, 255], textColor: [0, 0, 0]
  };
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [item] });
  assert.equal(result.directDeleteCount, 1);
  assert.equal(result.fallbackOverlayCount, 0);
  assert.equal(result.textMoveResults[0].method, 'direct-remove-overlay');
  const saved = (await inspect(result.outputBytes)).items.map((entry) => entry.str);
  assert.ok(saved.includes('1'));
  assert.ok(saved.includes('테스트3'));
  assert.ok(saved.includes('테스트색O'));
  assert.ok(saved.includes('테스트'));
});

test('NEW PDF removes only the selected DocPilot run while retaining its background', async () => {
  const sourceBytes = readFileSync(new URL('../../NEW.pdf', import.meta.url));
  const { items } = await inspect(sourceBytes);
  const original = items.find((item) => item.str === 'DocPilot');
  const item = {
    id: 'new-docpilot', type: 'movable-text', pageNumber: 1,
    text: 'DocPilot', displayText: 'DocPilot', forceUnicodeFallback: true,
    sourceSelection: { wholeItem: true, text: original.str, transform: original.transform },
    sourcePageWidth: 610, sourcePageHeight: 342,
    coverX: original.transform[4], coverY: 342 - original.transform[5] - original.height,
    coverWidth: original.width, coverHeight: original.height,
    textX: 200, textY: 100, baseline: 125, fontSize: original.height,
    backgroundColor: [255, 255, 255], textColor: [24, 80, 121]
  };
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [item] });
  assert.equal(result.directDeleteCount, 1);
  assert.equal(result.textMoveResults[0].method, 'direct-remove-overlay');
  const saved = (await inspect(result.outputBytes)).items.map((entry) => entry.str);
  assert.equal(saved.filter((text) => text === 'DocPilot').length, 1);
  assert.ok(saved.includes('문서 검색 및 편집 지원 프로그램'));
  assert.ok(saved.includes('팀명'));
});

test('NEW PDF removes the long Korean range while retaining DocPilot and team text', async () => {
  const sourceBytes = readFileSync(new URL('../../NEW.pdf', import.meta.url));
  const { items } = await inspect(sourceBytes);
  const original = items.find((item) => item.str.includes('문서 검색'));
  const item = {
    id: 'new-korean-range', type: 'movable-text', pageNumber: 1,
    text: original.str, displayText: original.str, forceUnicodeFallback: true,
    sourceSelection: { wholeItem: true, text: original.str, transform: original.transform },
    sourcePageWidth: 610, sourcePageHeight: 342,
    coverX: original.transform[4], coverY: 342 - original.transform[5] - original.height,
    coverWidth: original.width, coverHeight: original.height,
    textX: 100, textY: 50, baseline: 75, fontSize: original.height,
    backgroundColor: [255, 255, 255], textColor: [24, 80, 121]
  };
  const result = await buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: [item] });
  assert.equal(result.directDeleteCount, 1);
  assert.equal(result.rangeDeleteCount, 1);
  assert.equal(result.textMoveResults[0].deleteMode, 'range-group');
  assert.ok(result.textMoveResults[0].deletedCommandCount > 1);
  const saved = (await inspect(result.outputBytes)).items.map((entry) => entry.str);
  assert.equal(saved.filter((text) => text === original.str).length, 1);
  assert.ok(saved.includes('DocPilot'));
  assert.ok(saved.includes('팀명'));
});

test('NEW PDF independently deletes two moved objects on the same page', async () => {
  const sourceBytes = readFileSync(new URL('../../NEW.pdf', import.meta.url));
  const { items } = await inspect(sourceBytes);
  const docPilot = items.find((item) => item.str === 'DocPilot');
  const title = items.find((item) => item.str.includes('문서 검색'));
  const makeMove = (source, id, textX, textY) => ({
    id, type: 'movable-text', pageNumber: 1,
    text: source.str, displayText: source.str, forceUnicodeFallback: true,
    sourceSelection: { wholeItem: true, text: source.str, transform: source.transform },
    sourcePageWidth: 610, sourcePageHeight: 342,
    coverX: source.transform[4], coverY: 342 - source.transform[5] - source.height,
    coverWidth: source.width, coverHeight: source.height,
    textX, textY, baseline: textY + source.height * 0.84, fontSize: source.height,
    backgroundColor: [255, 255, 255], textColor: [24, 80, 121]
  });
  const result = await buildPdfWithTextEdits({
    sourceBytes, fontBytes,
    replacements: [makeMove(docPilot, 'doc', 200, 100), makeMove(title, 'title', 100, 50)]
  });
  assert.equal(result.movableTextCount, 2);
  assert.equal(result.directDeleteCount, 2);
  assert.equal(result.fallbackOverlayCount, 0);
  assert.ok(result.textMoveResults.every((entry) => entry.directDeleteSucceeded));
  assert.ok(result.textMoveResults.every((entry) => !entry.shouldApplyCover));
  const saved = (await inspect(result.outputBytes)).items.map((entry) => entry.str);
  assert.equal(saved.filter((text) => text === 'DocPilot').length, 1);
  assert.equal(saved.filter((text) => text === title.str).length, 1);
  assert.ok(saved.includes('팀명'));
});

test('NEW PDF deletes three UI moves even when sourceSelection evidence is absent', async () => {
  const sourceBytes = readFileSync(new URL('../../NEW.pdf', import.meta.url));
  const { items } = await inspect(sourceBytes);
  const docPilot = items.find((item) => item.str === 'DocPilot');
  const title = items.find((item) => item.str.includes('문서 검색'));
  const teamItems = items.filter((item) => ['팀명', ':', '올빼미'].includes(item.str));
  const team = {
    str: '팀명 : 올빼미', transform: teamItems[0].transform, height: teamItems[0].height,
    width: teamItems.reduce((total, item) => total + item.width, 0)
  };
  const makeMove = (source, id, textX, textY) => ({
    id, type: 'movable-text', pageNumber: 1,
    // The browser may display layout spaces even when the PDF source omits
    // them. Source text must remain the deletion key in that case.
    text: source.str === title.str ? '문서 검색 및 편집 지원 프로그램' : source.str,
    displayText: source.str === title.str ? '문서 검색 및 편집 지원 프로그램' : source.str,
    sourceText: source.str.replace(/\s+/g, ''),
    originalText: source.str.replace(/\s+/g, ''),
    // collectMovableTextReplacements normalizes every UI object to this route.
    forceUnicodeFallback: true,
    sourceSelection: null,
    sourcePageWidth: 610, sourcePageHeight: 342,
    originalRect: {
      x: source.transform[4], y: 342 - source.transform[5] - source.height,
      width: source.width, height: source.height
    },
    currentRect: { x: textX, y: textY, width: source.width, height: source.height },
    fontSize: source.height, backgroundColor: '#ffffff', color: '#185079'
  });
  // Use the same UI-shaped objects consumed by collectMovableTextReplacements.
  const result = await buildPdfWithTextEdits({
    sourceBytes, fontBytes,
    replacements: [
      // Browser line boxes are taller than the PDF glyph bounds, so these
      // adjacent source rectangles overlap. That must not suppress deletion
      // of independent content-stream commands.
      { ...makeMove(docPilot, 'doc', 295, 50), coverX: docPilot.transform[4], coverY: 342 - docPilot.transform[5] - docPilot.height, coverWidth: docPilot.width, coverHeight: docPilot.height + 14, textX: 295, textY: 50, baseline: 75, textColor: [24, 80, 121] },
      { ...makeMove(title, 'title', 20, 250), coverX: title.transform[4], coverY: 342 - title.transform[5] - title.height, coverWidth: title.width, coverHeight: title.height + 14, textX: 20, textY: 250, baseline: 275, textColor: [24, 80, 121] },
      { ...makeMove(team, 'team', 475, 150), coverX: team.transform[4], coverY: 342 - team.transform[5] - team.height, coverWidth: team.width, coverHeight: team.height, textX: 475, textY: 150, baseline: 164, textColor: [24, 80, 121] }
    ]
  });
  assert.equal(result.directDeleteCount, 3);
  assert.equal(result.fallbackOverlayCount, 0);
  assert.equal(result.directDeleteResults.length, 3);
  assert.equal(result.fallbackResults.length, 0);
  assert.ok(result.directDeleteResults.every((entry) => !entry.shouldApplyCover));
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
