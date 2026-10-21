import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { applyInternalLinkEdits, readInternalDestination } from '../src/services/pdfInternalLinks.js';
import { insertPdfPages, extractPdfPages, deletePdfPages } from '../src/services/pdfPageExtract.js';

const key = PDFName.of;
async function fixture() {
  const doc = await PDFDocument.create();
  const pages = [doc.addPage([500, 900]), doc.addPage([500, 900]), doc.addPage([500, 900])];
  doc.catalog.set(key('Names'), doc.context.obj({ Dests: { Names: [PDFString.of('chapter'), [pages[2].ref, key('XYZ'), 40, 500, null]] } }));
  pages[0].node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [30, 800, 180, 830], A: { S: 'GoTo', D: PDFString.of('chapter') } })));
  pages[1].node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [30, 800, 180, 830], A: { S: 'URI', URI: PDFString.of('https://example.com/') } })));
  pages[2].node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [30, 800, 180, 830], Dest: [pages[0].ref, key('Fit')] })));
  return doc.save();
}
const annotations = (doc, index) => doc.getPage(index).node.Annots()?.asArray().map((ref) => doc.context.lookup(ref)) || [];

test('insertion keeps both documents links attached to their real target pages', async () => {
  const source = await fixture();
  const { outputBytes } = await insertPdfPages(source, source, 1);
  const doc = await PDFDocument.load(outputBytes);
  assert.equal(readInternalDestination(doc, annotations(doc, 0)[0]).index, 5);
  assert.equal(readInternalDestination(doc, annotations(doc, 1)[0]).index, 3);
  assert.equal(readInternalDestination(doc, annotations(doc, 3)[0]).index, 1);
});
test('extraction remaps reordered pages and removes links to excluded targets', async () => {
  const source = await fixture();
  const reordered = await PDFDocument.load(await extractPdfPages(source, [3, 1]));
  assert.equal(readInternalDestination(reordered, annotations(reordered, 0)[0]).index, 1);
  assert.equal(readInternalDestination(reordered, annotations(reordered, 1)[0]).index, 0);
  const single = await PDFDocument.load(await extractPdfPages(source, [1]));
  assert.equal(annotations(single, 0).length, 0);
});
test('deleting a target removes its link and preserves external links', async () => {
  const doc = await PDFDocument.load(await deletePdfPages(await fixture(), [3]));
  assert.equal(annotations(doc, 0).length, 0);
  assert.equal(annotations(doc, 1)[0].lookup(key('A')).get(key('URI')).decodeText(), 'https://example.com/');
});
test('new links, target changes and removal persist with page reference destinations', async () => {
  const bytes = await fixture();
  const original = await PDFDocument.load(bytes);
  const ref = original.getPage(0).node.Annots().get(0);
  const edit = { id: 'DocPilotInternal:test', sourceId: `${ref.objectNumber}R`, pageNumber: 1, rect: [30, 800, 180, 830], destination: { pageNumber: 2, x: 20, y: 400 } };
  const output = await applyInternalLinkEdits(bytes, [edit]);
  const doc = await PDFDocument.load(output);
  assert.equal(annotations(doc, 0).length, 1);
  assert.equal(readInternalDestination(doc, annotations(doc, 0)[0]).index, 1);
  const removed = await PDFDocument.load(await applyInternalLinkEdits(output, [{ ...edit, deleted: true }]));
  assert.equal(annotations(removed, 0).length, 0);
  const fitted = await PDFDocument.load(await applyInternalLinkEdits(bytes, [{ ...edit,
    destination: { pageNumber: 2, explicit: [null, { name: 'FitR' }, 10, 20, 100, 200] }
  }]));
  const fittedDestination = readInternalDestination(fitted, annotations(fitted, 0)[0]);
  assert.equal(fittedDestination.values[0].decodeText(), 'FitR');
  assert.deepEqual(fittedDestination.values.slice(1).map((value) => value.asNumber()), [10, 20, 100, 200]);
});
