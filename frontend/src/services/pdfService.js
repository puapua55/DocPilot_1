import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { isPdfFile } from '../utils/fileUtils';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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

export async function loadPdfDocument(source) {
  let loadingTask = null;

  if (source instanceof ArrayBuffer) {
    loadingTask = pdfjsLib.getDocument({ data: source });
    return {
      loadingTask,
      pdf: await loadingTask.promise
    };
  }

  if (!source || !isPdfFile(source)) {
    return null;
  }

  const arrayBuffer = await source.arrayBuffer();

  loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });

  return {
    loadingTask,
    pdf: await loadingTask.promise
  };
}

function normalizePdfLines(textItems) {
  const groupedLines = [];

  textItems.forEach((item) => {
    const value = String(item?.str || '').trim();

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
    .map((lineGroup) => lineGroup.parts.join(' ').replace(/\s+/g, ' ').trim())
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
