import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { loadPdfDocument } from './pdfService';
import { isPdfFile } from '../utils/fileUtils';

const RENDER_SCALE = 2;
const LINE_Y_TOLERANCE = 5;
const COVER_PADDING_X = 1.5;
const COVER_PADDING_TOP = 1;
const COVER_PADDING_BOTTOM = 1;
const DEBUG_HTML_EXPORT = false;
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

function removeNode(node) {
  if (node?.parentNode) {
    node.parentNode.removeChild(node);
  }
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

function quantizeColor(red, green, blue) {
  const quantize = (value) => Math.min(255, Math.max(0, Math.round(value / 16) * 16));
  return [quantize(red), quantize(green), quantize(blue)];
}

function colorDistance(first, second) {
  return Math.sqrt(
    (first[0] - second[0]) ** 2
    + (first[1] - second[1]) ** 2
    + (first[2] - second[2]) ** 2
  );
}

function findDominantColor(pixels, excludedColor = null) {
  const counts = new Map();

  pixels.forEach((pixel) => {
    const color = quantizeColor(pixel[0], pixel[1], pixel[2]);
    if (excludedColor && colorDistance(color, excludedColor) < 56) return;
    const key = color.join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const dominant = Array.from(counts.entries()).sort((first, second) => second[1] - first[1])[0];
  return dominant ? dominant[0].split(',').map(Number) : null;
}

function sampleReplacementColors(page, replacement) {
  const canvas = page.renderCanvas;
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!canvas || !context) return replacement;

  const scaleX = canvas.width / Math.max(page.width, 1);
  const scaleY = canvas.height / Math.max(page.height, 1);
  const left = Math.max(0, Math.floor(replacement.coverX * scaleX));
  const top = Math.max(0, Math.floor(replacement.coverY * scaleY));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(replacement.coverWidth * scaleX)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(replacement.coverHeight * scaleY)));
  if (left >= canvas.width || top >= canvas.height || width <= 0 || height <= 0) return replacement;

  const { data } = context.getImageData(left, top, width, height);
  const pixels = [];
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] > 0) pixels.push([data[index], data[index + 1], data[index + 2]]);
  }

  const background = findDominantColor(pixels);
  const foreground = background ? findDominantColor(pixels, background) : null;
  const toCssColor = (color) => color ? `rgb(${color.join(', ')})` : null;

  return {
    ...replacement,
    backgroundColor: toCssColor(background) || replacement.backgroundColor,
    color: toCssColor(foreground) || replacement.color
  };
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
      imageDataUrl: canvas.toDataURL('image/png'),
      renderCanvas: canvas
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
            fontFamily: computedStyle?.fontFamily || 'sans-serif',
            fontWeight: computedStyle?.fontWeight || '400',
            fontStyle: computedStyle?.fontStyle || 'normal',
            letterSpacing: computedStyle?.letterSpacing || 'normal',
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

export function findAppliedReplacementRectsFromCurrentViewer() {
  const replacements = [];
  const pageElements = Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]'));

  pageElements.forEach((pageElement) => {
    const pageNumber = Number(pageElement.dataset.pageNumber) || 0;
    const pageWidth = pageElement.clientWidth || pageElement.getBoundingClientRect().width || 0;
    const pageHeight = pageElement.clientHeight || pageElement.getBoundingClientRect().height || 0;

    pageElement.querySelectorAll('.replacement-layer > div').forEach((replacementElement) => {
      const coverElement = replacementElement.querySelector('.replacement-cover');
      const textElement = replacementElement.querySelector('.replacement-text');

      if (!coverElement || !textElement) return;

      const coverStyle = window.getComputedStyle(coverElement);
      const textStyle = window.getComputedStyle(textElement);
      const x = Number.parseFloat(textElement.style.left || textStyle.left);
      const y = Number.parseFloat(textElement.style.top || textStyle.top);
      const coverX = Number.parseFloat(coverElement.style.left || coverStyle.left);
      const coverY = Number.parseFloat(coverElement.style.top || coverStyle.top);
      const coverWidth = Number.parseFloat(coverElement.style.width || coverStyle.width);
      const coverHeight = Number.parseFloat(coverElement.style.height || coverStyle.height);
      const fontSize = Number.parseFloat(textElement.style.fontSize || textStyle.fontSize);

      if (![x, y, coverX, coverY, coverWidth, coverHeight, fontSize].every(Number.isFinite)) return;

      replacements.push({
        page: pageNumber,
        newText: textElement.textContent || '',
        x: round(x),
        y: round(y),
        width: round(Math.max(coverWidth - COVER_PADDING_X * 2, 1)),
        height: round(Math.max(coverHeight - COVER_PADDING_TOP - COVER_PADDING_BOTTOM, 1)),
        coverX: round(coverX),
        coverY: round(coverY),
        coverWidth: round(coverWidth),
        coverHeight: round(coverHeight),
        fontSize: round(fontSize),
        fontFamily: textStyle.fontFamily || 'sans-serif',
        fontWeight: textStyle.fontWeight || '400',
        fontStyle: textStyle.fontStyle || 'normal',
        letterSpacing: textStyle.letterSpacing || 'normal',
        color: textStyle.color || '#111111',
        backgroundColor: coverStyle.backgroundColor || '#ffffff',
        sourcePageWidth: round(pageWidth),
        sourcePageHeight: round(pageHeight)
      });
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
      coverX: round((replacement.coverX ?? replacement.x - COVER_PADDING_X) * scaleX),
      coverY: round((replacement.coverY ?? replacement.y - COVER_PADDING_TOP) * scaleY),
      coverWidth: round((replacement.coverWidth ?? replacement.width + COVER_PADDING_X * 2) * scaleX),
      coverHeight: round((replacement.coverHeight ?? replacement.height + COVER_PADDING_TOP + COVER_PADDING_BOTTOM) * scaleY),
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
      coverBox.style.left = `${replacement.coverX}px`;
      coverBox.style.top = `${replacement.coverY}px`;
      coverBox.style.width = `${replacement.coverWidth}px`;
      coverBox.style.height = `${replacement.coverHeight}px`;
      coverBox.style.background = replacement.backgroundColor || '#ffffff';

      const textEl = document.createElement('div');
      textEl.className = 'converted-new-text';
      textEl.style.position = 'absolute';
      textEl.style.left = `${replacement.x}px`;
      textEl.style.top = `${replacement.y}px`;
      textEl.style.fontSize = `${replacement.fontSize}px`;
      textEl.style.color = replacement.color || '#111111';
      textEl.style.fontFamily = replacement.fontFamily || 'sans-serif';
      textEl.style.fontWeight = replacement.fontWeight || '400';
      textEl.style.fontStyle = replacement.fontStyle || 'normal';
      textEl.style.letterSpacing = replacement.letterSpacing || 'normal';
      textEl.style.whiteSpace = 'pre';
      textEl.style.lineHeight = '1';
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
    logging: false
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

function createPdfFromCapturedCanvases(capturedPages, renderedPages, outputFileName) {
  let pdf = null;

  capturedPages.forEach(({ pageNumber, canvas }, index) => {
    const page = renderedPages.find((entry) => entry.pageNumber === pageNumber);
    const width = page?.width || canvas.width;
    const height = page?.height || canvas.height;
    const orientation = width > height ? 'landscape' : 'portrait';
    const imageData = canvas.toDataURL('image/png');

    if (index === 0) {
      pdf = new jsPDF({
        unit: 'pt',
        format: [width, height],
        orientation,
        compress: true
      });
    } else {
      pdf.addPage([width, height], orientation);
    }

    pdf.addImage(imageData, 'PNG', 0, 0, width, height, undefined, 'FAST');

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
  const replacementText = String(newText ?? '');

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
  await waitForNextFrame();

  const appliedReplacements = findAppliedReplacementRectsFromCurrentViewer();
  const viewerReplacements = appliedReplacements.length > 0
    ? appliedReplacements
    : findReplacementRectsFromCurrentViewer(target, replacementText);

  console.log('[VisualConvert] originalText:', target);
  console.log('[VisualConvert] newText:', replacementText);
  console.log('[VisualConvert] replacements:', viewerReplacements);

  if (!viewerReplacements.length) {
    throw new Error('교체할 텍스트를 찾을 수 없습니다.');
  }

  const renderedPages = await renderPdfPagesToImages(file);
  const replacements = normalizeReplacementsForRenderedPages(renderedPages, viewerReplacements).map((replacement) => {
    const page = renderedPages.find((entry) => entry.pageNumber === replacement.page);
    return page ? sampleReplacementColors(page, replacement) : replacement;
  });
  renderedPages.forEach((page) => { delete page.renderCanvas; });
  const previewRoot = buildVisualConvertedHtml(renderedPages, replacements);

  try {
    await waitForImages(previewRoot);
    await document.fonts.ready;
    await waitForNextFrame();

    const debugCanvasRoot = DEBUG_HTML_EXPORT ? createCapturedCanvasRoot() : null;
    const capturedPages = [];

    for (const page of renderedPages) {
      const pageElement = previewRoot.querySelector(`.converted-pdf-page[data-page-number="${page.pageNumber}"]`);
      if (!pageElement) continue;

      const canvas = await capturePageToCanvas(pageElement);
      if (debugCanvasRoot) appendDebugCanvas(debugCanvasRoot, page.pageNumber, canvas);
      capturedPages.push({ pageNumber: page.pageNumber, canvas });
    }

    if (!capturedPages.length) throw new Error('html2canvas 캡처 결과가 비어 있습니다.');
    if (capturedPages.some(({ canvas }) => countOpaquePixels(canvas) === 0)) {
      throw new Error('캡처된 canvas가 백지입니다.');
    }

    const outputFileName = makeVisualConvertedFileName(file.name);
    createPdfFromCapturedCanvases(capturedPages, renderedPages, outputFileName);

    return {
      success: true,
      outputFileName,
      fileName: outputFileName,
      replaceCount: replacements.length,
      pages: renderedPages.length
    };
  } finally {
    if (!DEBUG_HTML_EXPORT) {
      removeNode(previewRoot);
      cleanupDebugNode(DEBUG_CAPTURED_CANVAS_ROOT_ID);
    }
  }
}
