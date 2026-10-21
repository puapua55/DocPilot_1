import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';

const key = (name) => PDFName.of(name);
const decode = (value) => value?.decodeText?.() ?? value?.asString?.();
function namedDestination(doc, name) {
  if (typeof name !== 'string' || !name) return null;
  const direct = doc.catalog.lookup(key('Dests'));
  if (direct instanceof PDFDict) {
    const value = direct.lookup(key(name));
    if (value) return value;
  }
  const visit = (node) => {
    if (!(node instanceof PDFDict)) return null;
    const names = node.lookup(key('Names'));
    if (names instanceof PDFArray) for (let i = 0; i + 1 < names.size(); i += 2) {
      if (decode(names.lookup(i)) === name) return names.lookup(i + 1);
    }
    const kids = node.lookup(key('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i += 1) {
      const found = visit(kids.lookup(i));
      if (found) return found;
    }
    return null;
  };
  return visit(doc.catalog.lookup(key('Names'))?.lookup?.(key('Dests')));
}

export function readInternalDestination(doc, annotation) {
  let value = annotation.lookup(key('Dest'));
  const action = annotation.lookup(key('A'));
  if (!value && action instanceof PDFDict && action.get(key('S')) === key('GoTo')) value = action.lookup(key('D'));
  if (!value) return null;
  if (!(value instanceof PDFArray)) value = namedDestination(doc, decode(value));
  if (value instanceof PDFDict) value = value.lookup(key('D'));
  if (!(value instanceof PDFArray)) return null;
  const first = value.get(0);
  const pages = doc.getPages();
  const index = first instanceof PDFNumber ? first.asNumber()
    : pages.findIndex((page) => first instanceof PDFRef && page.ref.toString() === first.toString());
  return index >= 0 && index < pages.length ? { index, values: value.asArray().slice(1) } : null;
}

// Convert named/numeric destinations to the actual output page references.
// Missing target pages lose their link annotation instead of pointing elsewhere.
export function remapInternalLinks(source, output, sourceIndices, outputPages) {
  const mapping = new Map(sourceIndices.map((index, i) => [index, outputPages[i].ref]));
  sourceIndices.forEach((sourceIndex, i) => {
    const original = source.getPage(sourceIndex).node.Annots();
    const target = outputPages[i].node.Annots();
    if (!original || !target) return;
    for (let j = original.size() - 1; j >= 0; j -= 1) {
      const annotation = source.context.lookup(original.get(j));
      if (!(annotation instanceof PDFDict)) continue;
      const destination = readInternalDestination(source, annotation);
      if (!destination) continue;
      const ref = mapping.get(destination.index);
      if (!ref) { target.remove(j); continue; }
      const copy = output.context.lookup(target.get(j));
      copy.set(key('Dest'), output.context.obj([ref, ...destination.values]));
      copy.delete(key('A'));
    }
  });
}

export async function applyInternalLinkEdits(bytes, edits) {
  if (!edits?.length) return bytes;
  const doc = await PDFDocument.load(bytes);
  for (const edit of edits) {
    const page = doc.getPages()[edit.pageNumber - 1];
    if (!page) continue;
    const annots = page.node.Annots();
    if (annots) for (let i = annots.size() - 1; i >= 0; i -= 1) {
      const ref = annots.get(i);
      const annotation = doc.context.lookup(ref);
      const name = annotation?.get?.(key('NM'))?.decodeText?.();
      const pdfJsId = ref instanceof PDFRef ? `${ref.objectNumber}R${ref.generationNumber || ''}` : '';
      const directRect = !(ref instanceof PDFRef) && edit.sourceId && annotation instanceof PDFDict
        && readInternalDestination(doc, annotation) ? annotation.lookup(key('Rect')) : null;
      const sameDirectRect = directRect instanceof PDFArray && directRect.size() === 4
        && edit.rect.every((value, index) => Math.abs(Number(directRect.lookup(index)?.asNumber?.()) - value) < 0.01);
      if (name === edit.id || (edit.sourceId && pdfJsId === edit.sourceId) || sameDirectRect) annots.remove(i);
    }
    if (edit.deleted) continue;
    const target = doc.getPages()[edit.destination.pageNumber - 1];
    if (!target) continue;
    const destination = edit.destination;
    const explicit = destination.explicit;
    const values = Array.isArray(explicit) && explicit[1]?.name
      ? [target.ref, key(explicit[1].name), ...explicit.slice(2)]
      : [target.ref, key('XYZ'), destination.x ?? null, destination.y ?? null, destination.zoom ?? null];
    const annotation = doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: edit.rect, Border: [0, 0, 0],
      NM: PDFString.of(edit.id),
      Dest: values
    });
    page.node.addAnnot(doc.context.register(annotation));
  }
  return doc.save();
}

export async function resolvePdfJsDestination(pdf, destination) {
  const explicit = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
  if (!Array.isArray(explicit)) return null;
  const index = typeof explicit[0] === 'number' ? explicit[0] : await pdf.getPageIndex(explicit[0]);
  if (index < 0 || index >= pdf.numPages) return null;
  return { pageNumber: index + 1, explicit };
}
