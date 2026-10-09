import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { deletePdfPages, extractPdfPages, insertPdfPages, parsePdfPageSelection } from '../src/services/pdfPageExtract.js';

test('single pages and ranges preserve the entered order', () => {
  assert.deepEqual(parsePdfPageSelection('3-5, 2, 8', 10), [3, 4, 5, 2, 8]);
  assert.deepEqual(parsePdfPageSelection('2', 10), [2]);
});

test('invalid and overlapping page selections are rejected', () => {
  for (const input of ['', '1-', '2,,3', '0', '11', '5-3', '1-3, 3']) {
    assert.throws(() => parsePdfPageSelection(input, 10), Error, input);
  }
});

test('extracts only the selected PDF pages in the requested order', async () => {
  const source = await PDFDocument.create();
  source.addPage([201, 300]);
  source.addPage([202, 300]);
  source.addPage([203, 300]);
  const bytes = await extractPdfPages(await source.save(), [3, 1]);
  const result = await PDFDocument.load(bytes);
  assert.deepEqual(result.getPages().map((page) => page.getWidth()), [203, 201]);
});

test('deleted pages are removed and remaining pages are renumbered', async () => {
  const source = await PDFDocument.create();
  for (let page = 1; page <= 5; page += 1) source.addPage([200 + page, 300]);
  const firstDeletion = await deletePdfPages(await source.save(), [2, 4]);
  const remaining = await PDFDocument.load(firstDeletion);
  assert.deepEqual(remaining.getPages().map((page) => page.getWidth()), [201, 203, 205]);
  const secondDeletion = await deletePdfPages(firstDeletion, [2]);
  const finalPdf = await PDFDocument.load(secondDeletion);
  assert.deepEqual(finalPdf.getPages().map((page) => page.getWidth()), [201, 205]);
  await assert.rejects(() => deletePdfPages(secondDeletion, [1, 2]), /최소 한 페이지/);
});

test('inserts another PDF at the front, middle, and end in page order', async () => {
  const source = await PDFDocument.create();
  source.addPage([201, 300]);
  source.addPage([202, 300]);
  const additional = await PDFDocument.create();
  additional.addPage([301, 300]);
  additional.addPage([302, 300]);
  const originalBytes = await source.save();
  const additionalBytes = await additional.save();
  for (const [position, widths] of [
    [0, [301, 302, 201, 202]],
    [1, [201, 301, 302, 202]],
    [2, [201, 202, 301, 302]]
  ]) {
    const result = await insertPdfPages(originalBytes, additionalBytes, position);
    assert.equal(result.insertedPageCount, 2);
    const output = await PDFDocument.load(result.outputBytes);
    assert.deepEqual(output.getPages().map((page) => page.getWidth()), widths);
  }
  await assert.rejects(() => insertPdfPages(originalBytes, additionalBytes, 3), /삽입 위치/);
});
