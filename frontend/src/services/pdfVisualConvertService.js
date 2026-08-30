import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { loadPdfDocument } from './pdfService';
import { isPdfFile } from '../utils/fileUtils';

const RENDER_SCALE = 2;
const LINE_Y_TOLERANCE = 5;
const COVER_PADDING_X = 1.5;
const COVER_PADDING_TOP = 1;
const COVER_PADDING_BOTTOM = 1;
const DEBUG_HTML_EXPORT = true;
const DEBUG_HTML_EXPORT_ROOT_ID = 'converted-preview-root';
const DEBUG_CAPTURED_CANVAS_ROOT_ID = 'debug-captured-canvas-root';

function round(value, precision = 3) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function waitForNextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function cleanupDebugNode(nodeId) {
  const existingNode = document.getElementById(nodeId);

  if (existingNode?.parentNode) {
    existingNode.parentNode.removeChild(existingNode);
  }
}

function createExportRoot() {
  cleanupDebugNode(DEBUG_HTML_EXPORT_ROOT_ID);

  const container = document.createElement('div');
  container.id = DEBUG_HTML_EXPORT_ROOT_ID;
  container.className = DEBUG_HTML_EXPORT ? 'converted-preview-root' : 'converted-pdf-export-root';

  document.body.appendChild(container);

  return container;
}

function createCapturedCanvasRoot() {
  cleanupDebugNode(DEBUG_CAPTURED_CANVAS_ROOT_ID);

  const container = document.createElement('div');
  container.id = DEBUG_CAPTURED_CANVAS_ROOT_ID;
  container.className = 'debug-captured-canvas-root';
  document.body.appendChild(container);

  return container;
}

function buildTextLayerLineGroups(spans) {
  const lineGroups = [];

  spans.forEach((span) => {
    const rect = span.getBoundingClientRect();

    if (!rect.width && !rect.height) {
      return;
    }

    const lineGroup = lineGroups.find((line) => Math.abs(rect.top - line.top) <= LINE_Y_TOLERANCE);

    if (lineGroup) {
      lineGroup.spans.push({ span, rect, text: span.textContent || '' });
      return;
    }

    lineGroups.push({
      top: rect.top,
      spans: [{ span, rect, text: span.textContent || '' }]
    });
  });

  lineGroups.forEach((line) => {
    line.spans.sort((a, b) => a.rect.left - b.rect.left);
    line.text = line.spans.map((entry) => entry.text).join('');
  });

  return lineGroups;
}

function mergeLineRects(rects, pageElement) {
  if (!rects.length) {
    return null;
  }

  const pageRect = pageElement.getBoundingClientRect();
  const bounds = rects.reduce(
    (acc, rect) => ({
      left: Math.min(acc.left, rect.left),
      top: Math.min(acc.top, rect.top),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom)
    }),
    {
      left: Infinity,
      top: Infinity,
      right: -Infinity,
      bottom: -Infinity
    }
  );

  return {
    x: round(bounds.left - pageRect.left),
    y: round(bounds.top - pageRect.top),
    width: round(bounds.right - bounds.left),
    height: round(bounds.bottom - bounds.top)
  };
}

function findSourceSpan(spans, firstRect) {
  if (!firstRect) {
    return null;
  }

  return spans.find(({ rect }) => (
    rect.left - 1 <= firstRect.left &&
    rect.right + 1 >= firstRect.left &&
    Math.abs(rect.top - firstRect.top) <= 3
  ))?.span || null;
}

function countOpaquePixels(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) {
    return 0;
  }

  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let opaquePixelCount = 0;

  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) {
      opaquePixelCount += 1;
    }
  }

  return opaquePixelCount;
}

export async function renderPdfPagesToImages(file) {
  if (!file || !isPdfFile(file)) {
    throw new Error('먼저 PDF 파일을 선택해주세요.');
  }

  const { pdf } = await loadPdfDocument(file);
  const renderedPages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const renderViewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    canvas.width = Math.ceil(renderViewport.width);
    canvas.height = Math.ceil(renderViewport.height);

    await page.render({
      canvasContext: context,
      viewport: renderViewport
    }).promise;

    renderedPages.push({
      pageNumber,
      width: round(viewport.width),
      height: round(viewport.height),
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      imageDataUrl: canvas.toDataURL('image/png')
    });
  }

  return renderedPages;
}

export function findReplacementRectsFromCurrentViewer(originalText, newText) {
  const target = String(originalText ?? '').trim();
  const replacementText = String(newText ?? '');

  if (!target) {
    return [];
  }

  const pageElements = Array.from(document.querySelectorAll('.pdf-page[data-page-number]'));
  const replacements = [];

  pageElements.forEach((pageElement) => {
    const textLayer = pageElement.querySelector('.textLayer');

    if (!textLayer) {
      return;
    }

    const pageNumber = Number(pageElement.dataset.pageNumber) || 0;
    const pageWidth = pageElement.clientWidth || pageElement.getBoundingClientRect().width || 0;
    const pageHeight = pageElement.clientHeight || pageElement.getBoundingClientRect().height || 0;
    const spans = Array.from(textLayer.querySelectorAll('span')).filter(
      (span) => (span.textContent || '').length > 0
    );
    const lineGroups = buildTextLayerLineGroups(spans);
    const loweredKeyword = target.toLowerCase();

    lineGroups.forEach((lineGroup) => {
      const lineText = lineGroup.text || '';
      const loweredText = lineText.toLowerCase();
      let startIndex = 0;

      while (true) {
        const foundIndex = loweredText.indexOf(loweredKeyword, startIndex);

        if (foundIndex === -1) {
          break;
        }

        const endIndex = foundIndex + target.length;
        const matchedRects = [];
        let cursor = 0;

        lineGroup.spans.forEach(({ span, text }) => {
          const spanStart = cursor;
          const spanEnd = cursor + text.length;
          const overlapStart = Math.max(foundIndex, spanStart);
          const overlapEnd = Math.min(endIndex, spanEnd);

          cursor = spanEnd;

          if (overlapStart >= overlapEnd) {
            return;
          }

          const textNode = Array.from(span.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);

          if (!textNode) {
            return;
          }

          const range = document.createRange();
          range.setStart(textNode, overlapStart - spanStart);
          range.setEnd(textNode, overlapEnd - spanStart);
          matchedRects.push(...Array.from(range.getClientRects()));
          range.detach?.();
        });

        const lineBox = mergeLineRects(matchedRects, pageElement);

        if (lineBox) {
          const sourceSpan = findSourceSpan(lineGroup.spans, matchedRects[0]);
          const computedStyle = sourceSpan ? window.getComputedStyle(sourceSpan) : null;
          const fontSize = Number.parseFloat(computedStyle?.fontSize || '') || lineBox.height;

          replacements.push({
            page: pageNumber,
            originalText: target,
            newText: replacementText,
            x: round(lineBox.x),
            y: round(lineBox.y),
            width: round(lineBox.width),
            height: round(lineBox.height),
            fontSize: round(fontSize),
            sourcePageWidth: round(pageWidth),
            sourcePageHeight: round(pageHeight)
          });
        }

        startIndex = foundIndex + target.length;
      }
    });
  });

  return replacements;
}

function normalizeReplacementsForRenderedPages(renderedPages, replacements) {
  return replacements.map((replacement) => {
    const renderedPage = renderedPages.find((page) => page.pageNumber === replacement.page);

    if (!renderedPage) {
      return null;
    }

    const scaleX = renderedPage.width / Math.max(replacement.sourcePageWidth || renderedPage.width, 1);
    const scaleY = renderedPage.height / Math.max(replacement.sourcePageHeight || renderedPage.height, 1);

    return {
      ...replacement,
      x: round(replacement.x * scaleX),
      y: round(replacement.y * scaleY),
      width: round(replacement.width * scaleX),
      height: round(replacement.height * scaleY),
      fontSize: round(replacement.fontSize * scaleY)
    };
  }).filter(Boolean);
}

export function buildVisualConvertedHtml(renderedPages, replacements) {
  const container = createExportRoot();
  const replacementsByPage = replacements.reduce((acc, replacement) => {
    if (!acc[replacement.page]) {
      acc[replacement.page] = [];
    }

    acc[replacement.page].push(replacement);
    return acc;
  }, {});

  renderedPages.forEach((page) => {
    const pageEl = document.createElement('div');
    pageEl.className = 'converted-pdf-page';
    pageEl.dataset.pageNumber = String(page.pageNumber);
    pageEl.style.position = 'relative';
    pageEl.style.width = `${page.width}px`;
    pageEl.style.height = `${page.height}px`;
    pageEl.style.overflow = 'hidden';
    pageEl.style.background = '#ffffff';
    pageEl.style.pageBreakAfter = 'always';

    const imageEl = document.createElement('img');
    imageEl.className = 'converted-page-bg';
    imageEl.style.position = 'absolute';
    imageEl.style.left = '0';
    imageEl.style.top = '0';
    imageEl.style.width = `${page.width}px`;
    imageEl.style.height = `${page.height}px`;
    imageEl.style.display = 'block';
    imageEl.src = page.imageDataUrl;
    pageEl.appendChild(imageEl);

    const replacementLayer = document.createElement('div');
    replacementLayer.className = 'converted-replacement-layer';
    replacementLayer.style.position = 'absolute';
    replacementLayer.style.inset = '0';
    replacementLayer.style.pointerEvents = 'none';

    (replacementsByPage[page.pageNumber] || []).forEach((replacement) => {
      const coverBox = document.createElement('div');
      coverBox.className = 'converted-cover-box';
      coverBox.style.position = 'absolute';
      coverBox.style.left = `${replacement.x - COVER_PADDING_X}px`;
      coverBox.style.top = `${replacement.y - COVER_PADDING_TOP}px`;
      coverBox.style.width = `${replacement.width + COVER_PADDING_X * 2}px`;
      coverBox.style.height = `${replacement.height + COVER_PADDING_TOP + COVER_PADDING_BOTTOM}px`;
      coverBox.style.background = '#ffffff';

      const textEl = document.createElement('div');
      textEl.className = 'converted-new-text';
      textEl.style.position = 'absolute';
      textEl.style.left = `${replacement.x}px`;
      textEl.style.top = `${replacement.y}px`;
      textEl.style.fontSize = `${replacement.fontSize}px`;
      textEl.style.color = '#111827';
      textEl.style.whiteSpace = 'pre';
      textEl.style.lineHeight = '1';
      textEl.style.fontWeight = '400';
      textEl.textContent = replacement.newText;

      replacementLayer.appendChild(coverBox);
      replacementLayer.appendChild(textEl);
    });

    pageEl.appendChild(replacementLayer);
    container.appendChild(pageEl);
  });

  console.log('[VisualConvert] container rect:', container.getBoundingClientRect());
  console.log('[VisualConvert] page count:', container.querySelectorAll('.converted-pdf-page').length);
  console.log('[VisualConvert] image count:', container.querySelectorAll('img').length);

  container.querySelectorAll('.converted-pdf-page').forEach((pageEl, index) => {
    console.log('[VisualConvert] page rect', index + 1, pageEl.getBoundingClientRect());
  });

  container.querySelectorAll('img').forEach((imageEl, index) => {
    console.log('[VisualConvert] image', index + 1, {
      complete: imageEl.complete,
      naturalWidth: imageEl.naturalWidth,
      naturalHeight: imageEl.naturalHeight,
      srcLength: imageEl.src?.length
    });
  });

  return container;
}

export function waitForImages(root) {
  const images = Array.from(root.querySelectorAll('img'));

  return Promise.all(images.map((img) => {
    if (img.complete && img.naturalWidth > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
    });
  }));
}

async function capturePageToCanvas(pageElement) {
  const canvas = await html2canvas(pageElement, {
    scale: 2,
    backgroundColor: '#ffffff',
    useCORS: true,
    allowTaint: true,
    logging: true
  });

  return canvas;
}

function appendDebugCanvas(debugRoot, pageNumber, canvas) {
  const wrapper = document.createElement('div');
  wrapper.className = 'debug-captured-canvas';

  const title = document.createElement('div');
  title.className = 'debug-captured-canvas-title';
  title.textContent = `captured page ${pageNumber}`;

  wrapper.appendChild(title);
  wrapper.appendChild(canvas);
  debugRoot.appendChild(wrapper);
}

function createPdfFromCapturedCanvases(capturedPages, outputFileName) {
  let pdf = null;

  capturedPages.forEach(({ pageNumber, canvas }, index) => {
    const orientation = canvas.width > canvas.height ? 'landscape' : 'portrait';
    const imageData = canvas.toDataURL('image/jpeg', 0.98);

    if (index === 0) {
      pdf = new jsPDF({
        unit: 'px',
        format: [canvas.width, canvas.height],
        orientation
      });
    } else {
      pdf.addPage([canvas.width, canvas.height], orientation);
    }

    pdf.addImage(imageData, 'JPEG', 0, 0, canvas.width, canvas.height);

    console.log('[VisualConvert] captured canvas page:', pageNumber, {
      width: canvas.width,
      height: canvas.height,
      opaquePixels: countOpaquePixels(canvas)
    });
  });

  if (!pdf) {
    throw new Error('PDF를 생성할 캡처 결과가 없습니다.');
  }

  pdf.save(outputFileName);
}

export function makeVisualConvertedFileName(fileName = 'document.pdf') {
  return fileName.replace(/\.pdf$/i, '') + '_visual_converted.pdf';
}

export async function convertPdfToVisualPdf({ file, originalText, newText }) {
  const target = String(originalText ?? '').trim();
  const replacementText = String(newText ?? '').trim();

  if (!file || !isPdfFile(file)) {
    throw new Error('먼저 PDF 파일을 선택해주세요.');
  }

  if (!target) {
    throw new Error('기존 단어를 입력해주세요.');
  }

  if (!replacementText) {
    throw new Error('변경 단어를 입력해주세요.');
  }

  cleanupDebugNode(DEBUG_CAPTURED_CANVAS_ROOT_ID);

  const renderedPages = await renderPdfPagesToImages(file);
  const viewerReplacements = findReplacementRectsFromCurrentViewer(target, replacementText);

  console.log('[VisualConvert] originalText:', target);
  console.log('[VisualConvert] newText:', replacementText);
  console.log('[VisualConvert] rendered pages:', renderedPages);
  console.log('[VisualConvert] replacements:', viewerReplacements);

  if (!viewerReplacements.length) {
    throw new Error('교체할 텍스트를 찾을 수 없습니다.');
  }

  const replacements = normalizeReplacementsForRenderedPages(renderedPages, viewerReplacements);
  const previewRoot = buildVisualConvertedHtml(renderedPages, replacements);

  await waitForImages(previewRoot);
  await waitForNextFrame();
  await new Promise((resolve) => window.setTimeout(resolve, 100));

  const debugCanvasRoot = createCapturedCanvasRoot();
  const capturedPages = [];

  for (const page of renderedPages) {
    const pageElement = previewRoot.querySelector(`.converted-pdf-page[data-page-number="${page.pageNumber}"]`);

    if (!pageElement) {
      continue;
    }

    const canvas = await capturePageToCanvas(pageElement);
    appendDebugCanvas(debugCanvasRoot, page.pageNumber, canvas);
    capturedPages.push({
      pageNumber: page.pageNumber,
      canvas
    });
  }

  if (!capturedPages.length) {
    throw new Error('html2canvas 캡처 결과가 비어 있습니다.');
  }

  const blankPages = capturedPages.filter(({ canvas }) => countOpaquePixels(canvas) === 0);

  if (blankPages.length > 0) {
    throw new Error('캡처된 canvas가 백지입니다. preview HTML 표시 상태를 확인해주세요.');
  }

  const outputFileName = makeVisualConvertedFileName(file.name);

  console.log('[VisualConvert] output file:', outputFileName);

  createPdfFromCapturedCanvases(capturedPages, outputFileName);

  return {
    outputFileName,
    renderedPages,
    replacements,
    previewRoot,
    capturedPages
  };
}
