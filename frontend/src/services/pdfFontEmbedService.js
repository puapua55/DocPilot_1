import fontkit from '@pdf-lib/fontkit';
import { fixTrueTypeSubset } from './pdfTrueTypeSubset.js';

// Materialize variable TrueType glyphs before subsetting. Copying their raw
// (potentially odd-length) glyf buffers can produce invalid short loca offsets
// in fontkit's subset encoder. It also leaves this bundled font at Thin/100.
export function createPdfFont(bytes, { bold = false } = {}) {
  const font = fontkit.create(bytes);
  const instance = font.variationAxes?.wght
    ? font.getVariation({ wght: bold ? 700 : 400 }) : font;
  return fixTrueTypeSubset(instance);
}

export async function embedPdfFont(pdfDocument, bytes, options = {}) {
  // PDFDocument creates its embedder during embedFont(), so each font captures
  // its own weight even when text and table fonts share the same document.
  pdfDocument.registerFontkit({ create: (data) => createPdfFont(data, options) });
  return pdfDocument.embedFont(bytes, { subset: true });
}
