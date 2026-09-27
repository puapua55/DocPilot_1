import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { isPdfFile } from '../utils/fileUtils';

// PDF.js 6 uses the new Map helper while rendering optional-content
// configuration. Electron 38 ships Chromium 140, which does not provide it
// yet, so otherwise valid PDFs fail at page.render() with
// "getOrInsertComputed is not a function".
if (typeof Map.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    configurable: true,
    value(key, computeValue) {
      if (this.has(key)) return this.get(key);
      const value = computeValue(key);
      this.set(key, value);
      return value;
    }
  });
}

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// PDF.js only needs these files for some fonts and CJK encodings. They must be
// bundled explicitly because the packaged Electron app runs from file:// and
// does not serve pdfjs-dist/node_modules as a web server would.
const pdfJsAssetBaseUrl = new URL('../pdfjs/', import.meta.url).toString();
const cMapUrl = new URL('cmaps/', pdfJsAssetBaseUrl).toString();
const standardFontDataUrl = new URL('standard_fonts/', pdfJsAssetBaseUrl).toString();

export function createPdfObjectUrl(file) {
  return URL.createObjectURL(file);
}

export function revokePdfObjectUrl(objectUrl) {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }
}

export function isPdfDocument(documentFile) {
  return isPdfFile(documentFile?.file);
}

export function getPdfPreviewModel(documentFile) {
  return {
    type: 'pdf',
    file: documentFile.file,
    fileName: documentFile.name,
    fileSize: documentFile.size
  };
}

export async function loadPdfDocument(source, { onLoadingTask } = {}) {
  if (!(source instanceof ArrayBuffer) && (!source || !isPdfFile(source))) {
    return null;
  }
  const data = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl
  });
  try {
    onLoadingTask?.(loadingTask);
    return { loadingTask, pdf: await loadingTask.promise };
  } catch (error) {
    if (typeof loadingTask.destroy === 'function') {
      await loadingTask.destroy().catch(() => {});
    }
    throw error;
  }
}

function normalizePdfLines(textItems) {
  const groupedLines = [];

  textItems.forEach((item) => {
    // Do not trim individual PDF text items: punctuation and its following
    // whitespace are commonly stored as separate items.
    const value = String(item?.str || '');

    if (!value) {
      return;
    }

    const y = Array.isArray(item.transform) ? item.transform[5] : 0;
    const lastLine = groupedLines[groupedLines.length - 1];

    if (lastLine && Math.abs(lastLine.y - y) < 4) {
      lastLine.parts.push(value);
      return;
    }

    groupedLines.push({
      y,
      parts: [value]
    });
  });

  return groupedLines
    .map((lineGroup) => lineGroup.parts.join('').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export async function extractPdfTextByPages(file) {
  if (!file || !isPdfFile(file)) {
    return [];
  }

  const { pdf } = await loadPdfDocument(file);
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = normalizePdfLines(textContent.items);

    console.log(`[PDF text extracted] page ${pageNumber}`, lines);

    pages.push({
      page: pageNumber,
      lines
    });
  }

  return pages;
}

export async function getPdfDocumentInfo(file) {
  if (!file || !isPdfFile(file)) {
    return {
      type: 'pdf',
      pageCount: 0,
      widthMm: 0,
      heightMm: 0,
      widthPt: 0,
      heightPt: 0,
      widthPx: 0,
      heightPx: 0,
      orientation: 'unknown'
    };
  }

  const { pdf } = await loadPdfDocument(file);
  const firstPage = await pdf.getPage(1);
  const viewport = firstPage.getViewport({ scale: 1 });
  const widthPt = Number(viewport.width || 0);
  const heightPt = Number(viewport.height || 0);
  const widthMm = Number((widthPt * 25.4 / 72).toFixed(2));
  const heightMm = Number((heightPt * 25.4 / 72).toFixed(2));
  const orientation = widthPt >= heightPt ? 'landscape' : 'portrait';

  return {
    type: 'pdf',
    pageCount: Number(pdf.numPages || 0),
    widthMm,
    heightMm,
    widthPt,
    heightPt,
    widthPx: Number(widthPt.toFixed(2)),
    heightPx: Number(heightPt.toFixed(2)),
    orientation
  };
}
