import { PDFDocument } from 'pdf-lib';

function isEncryptedPdfError(error) {
  return /Input document to `PDFDocument\.load` is encrypted/.test(error?.message || '');
}

async function renderSelectedPages(sourceBytes, pageSelection, { onProgress } = {}) {
  // pdf-lib's ignoreEncryption option only skips its safety check. It does not
  // decrypt page streams, and copying those streams creates an unreadable PDF.
  const { loadPdfDocument } = await import('./pdfService.js');
  const input = sourceBytes instanceof Uint8Array
    ? sourceBytes.slice()
    : new Uint8Array(sourceBytes).slice();
  const { loadingTask, pdf } = await loadPdfDocument(input.buffer);
  const output = await PDFDocument.create();
  try {
    const pageNumbers = typeof pageSelection === 'function'
      ? pageSelection(pdf.numPages)
      : pageSelection || Array.from({ length: pdf.numPages }, (_, index) => index + 1);
    if (!pageNumbers.length) throw new Error('PDF에는 최소 한 페이지가 남아 있어야 합니다.');
    for (const [index, pageNumber] of pageNumbers.entries()) {
      const sourcePage = await pdf.getPage(pageNumber);
      const original = sourcePage.getViewport({ scale: 1 });
      const renderScale = Math.min(pageNumbers.length > 20 ? 1.5 : 2, Math.sqrt(4_000_000 / (original.width * original.height)));
      const viewport = sourcePage.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      try {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await sourcePage.render({ canvasContext: context, viewport }).promise;
        const image = await new Promise((resolve, reject) => {
          canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PDF 페이지 이미지를 만들지 못했습니다.')), 'image/jpeg', 0.92);
        });
        const embedded = await output.embedJpg(await image.arrayBuffer());
        const outputPage = output.addPage([original.width, original.height]);
        outputPage.drawImage(embedded, { x: 0, y: 0, width: original.width, height: original.height });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        sourcePage.cleanup();
      }
      onProgress?.(index + 1, pageNumbers.length);
    }
    return output.save();
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export function parsePdfPageSelection(value, pageCount) {
  const input = String(value ?? '').trim();
  if (!input) throw new Error('추출할 페이지를 입력해주세요. 예: 1-5, 8, 11-13');
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF 페이지 수를 확인할 수 없습니다.');

  const pages = [];
  const seen = new Set();
  for (const part of input.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error('페이지는 1-5, 8, 11-13 형식으로 입력해주세요.');
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > pageCount) {
      throw new Error(`페이지는 1부터 ${pageCount}까지 입력해주세요.`);
    }
    if (start > end) throw new Error('페이지 범위의 시작 번호가 끝 번호보다 클 수 없습니다.');
    for (let page = start; page <= end; page += 1) {
      if (seen.has(page)) throw new Error(`${page}페이지가 중복으로 지정되었습니다.`);
      seen.add(page);
      pages.push(page);
    }
  }
  return pages;
}

export async function extractPdfPages(sourceBytes, pageNumbers, { onRasterized } = {}) {
  try {
    const source = await PDFDocument.load(sourceBytes);
    const output = await PDFDocument.create();
    const copied = await output.copyPages(source, pageNumbers.map((page) => page - 1));
    copied.forEach((page) => output.addPage(page));
    return output.save();
  } catch (error) {
    if (!isEncryptedPdfError(error)) throw error;
    const outputBytes = await renderSelectedPages(sourceBytes, pageNumbers);
    onRasterized?.();
    return outputBytes;
  }
}

export async function deletePdfPages(sourceBytes, pageNumbers, { onRasterized, onProgress } = {}) {
  try {
    const pdf = await PDFDocument.load(sourceBytes);
    if (pageNumbers.length >= pdf.getPageCount()) {
      throw new Error('PDF에는 최소 한 페이지가 남아 있어야 합니다.');
    }
    [...pageNumbers].sort((left, right) => right - left).forEach((page) => pdf.removePage(page - 1));
    return pdf.save();
  } catch (error) {
    if (!isEncryptedPdfError(error)) throw error;
    const removed = new Set(pageNumbers);
    const outputBytes = await renderSelectedPages(sourceBytes, (pageCount) => (
      Array.from({ length: pageCount }, (_, index) => index + 1).filter((page) => !removed.has(page))
    ), { onProgress });
    onRasterized?.();
    return outputBytes;
  }
}

export async function insertPdfPages(sourceBytes, insertedBytes, afterPage, { onRasterized, onProgress } = {}) {
  let pdf;
  try {
    pdf = await PDFDocument.load(sourceBytes);
  } catch (error) {
    if (!isEncryptedPdfError(error)) throw error;
    const imageBytes = await renderSelectedPages(sourceBytes, null, { onProgress });
    pdf = await PDFDocument.load(imageBytes);
    onRasterized?.('current');
  }
  if (!Number.isInteger(afterPage) || afterPage < 0 || afterPage > pdf.getPageCount()) {
    throw new Error(`삽입 위치는 0부터 ${pdf.getPageCount()}까지 입력해주세요.`);
  }
  let inserted;
  try {
    inserted = await PDFDocument.load(insertedBytes);
  } catch (error) {
    if (!isEncryptedPdfError(error)) throw error;
    const imageBytes = await renderSelectedPages(insertedBytes, null, { onProgress });
    inserted = await PDFDocument.load(imageBytes);
    onRasterized?.('inserted');
  }
  const pageCount = inserted.getPageCount();
  if (pageCount < 1) throw new Error('삽입할 PDF에 페이지가 없습니다.');
  const pages = await pdf.copyPages(inserted, Array.from({ length: pageCount }, (_, index) => index));
  pages.forEach((page, index) => pdf.insertPage(afterPage + index, page));
  return { outputBytes: await pdf.save(), insertedPageCount: pageCount };
}
