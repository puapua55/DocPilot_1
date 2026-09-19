import JSZip from 'jszip';

const PDF_MIME = 'application/pdf';
const CSS_DPI = 96;
const EMU_PER_INCH = 914400;
const POINTS_PER_INCH = 72;
const CAPTURE_SCALE = 2;

function makeFileName(fileName = 'document.docx') {
  return `${String(fileName).replace(/\.docx?$/i, '')}_converted.pdf`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getVisiblePages(root) {
  const renderedSections = Array.from(root.querySelectorAll('section.docx'));
  const candidates = renderedSections.length
    ? renderedSections
    : Array.from(root.querySelectorAll('.word-document'));
  const pages = [];
  candidates.forEach((candidate) => {
    if (candidate.hidden || candidate.closest('[hidden]') || pages.some((page) => page.contains(candidate))) return;
    pages.push(candidate);
  });
  return pages;
}

function getVisualElements(page) {
  const elements = Array.from(page.querySelectorAll('img, svg, canvas, [style*="background-image"]'));
  const drawingElements = Array.from(page.querySelectorAll('*')).filter((element) => (
    ['svg', 'canvas', 'image', 'oval', 'roundrect', 'arc', 'shape'].includes(String(element.localName || '').toLowerCase())
  ));
  const computedVisuals = Array.from(page.querySelectorAll('*')).filter((element) => {
    const style = window.getComputedStyle(element);
    const hasShape = style.position === 'absolute' && (
      style.borderRadius.includes('%') || style.borderRadius !== '0px' ||
      style.clipPath !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)'
    );
    return hasShape && !element.textContent?.trim() && element.getBoundingClientRect().width > 2 && element.getBoundingClientRect().height > 2;
  });
  return [...new Set([...elements, ...drawingElements, ...computedVisuals])].filter((element) => (
    !element.closest('[hidden]') && !element.parentElement?.closest('img, svg, canvas')
  )).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
}

function getElementsByLocalName(root, name) {
  if (!root) return [];
  return Array.from(root.getElementsByTagName('*')).filter((element) => element.localName === name);
}

function getFirstByLocalName(root, name) {
  return getElementsByLocalName(root, name)[0] || null;
}

function emuToCssPixels(value) {
  const emu = Number.parseFloat(value);
  return Number.isFinite(emu) ? emu / EMU_PER_INCH * CSS_DPI : 0;
}

function pointsToCssPixels(value) {
  const points = Number.parseFloat(value);
  return Number.isFinite(points) ? points / POINTS_PER_INCH * CSS_DPI : 0;
}

function getPosition(anchor, axis) {
  const position = getFirstByLocalName(anchor, axis === 'x' ? 'positionH' : 'positionV');
  return {
    relativeFrom: position?.getAttribute('relativeFrom') || (axis === 'x' ? 'column' : 'paragraph'),
    offset: emuToCssPixels(getFirstByLocalName(position || anchor, 'posOffset')?.textContent)
  };
}

function getDrawingColor(root, fallback) {
  const color = getFirstByLocalName(root, 'srgbClr')?.getAttribute('val');
  return color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : fallback;
}

function getXmlParagraphText(paragraph) {
  return getElementsByLocalName(paragraph, 't').map((node) => node.textContent || '').join('').replace(/\s+/g, ' ').trim();
}

function extractAnchoredShapes(documentRoot) {
  const paragraphs = getElementsByLocalName(documentRoot, 'p');
  const shapes = [];

  paragraphs.forEach((paragraph, paragraphIndex) => {
    getElementsByLocalName(paragraph, 'anchor').forEach((anchor) => {
      const extent = getFirstByLocalName(anchor, 'extent');
      const presetGeometry = getFirstByLocalName(anchor, 'prstGeom');
      const shapeProperties = getFirstByLocalName(anchor, 'spPr');
      const line = shapeProperties ? getFirstByLocalName(shapeProperties, 'ln') : null;
      const vmlShape = getFirstByLocalName(paragraph, 'oval');
      const x = getPosition(anchor, 'x');
      const y = getPosition(anchor, 'y');
      const vmlStyle = vmlShape?.getAttribute('style') || '';
      const vmlWidth = /(?:^|;)\s*width\s*:\s*([\d.]+)pt/i.exec(vmlStyle);
      const vmlHeight = /(?:^|;)\s*height\s*:\s*([\d.]+)pt/i.exec(vmlStyle);
      const vmlLeft = /(?:^|;)\s*margin-left\s*:\s*(-?[\d.]+)pt/i.exec(vmlStyle);
      const vmlTop = /(?:^|;)\s*margin-top\s*:\s*(-?[\d.]+)pt/i.exec(vmlStyle);
      const strokeWidth = pointsToCssPixels(vmlShape?.getAttribute('strokeweight') || 0.75);

      shapes.push({
        paragraphIndex,
        precedingText: paragraphs.slice(0, paragraphIndex).reverse().map(getXmlParagraphText).find(Boolean) || '',
        type: vmlShape ? 'ellipse' : (presetGeometry?.getAttribute('prst') || 'rect'),
        fill: vmlShape
          ? parseShapeColor(vmlShape.getAttribute('fillcolor'), '#89B1E1')
          : getDrawingColor(shapeProperties, '#89B1E1'),
        stroke: vmlShape
          ? parseShapeColor(vmlShape.getAttribute('strokecolor'), '#3A70B1')
          : getDrawingColor(line, '#3A70B1'),
        strokeWidth: strokeWidth || 1,
        width: emuToCssPixels(extent?.getAttribute('cx')) || pointsToCssPixels(vmlWidth?.[1]),
        height: emuToCssPixels(extent?.getAttribute('cy')) || pointsToCssPixels(vmlHeight?.[1]),
        offsetX: x.offset || pointsToCssPixels(vmlLeft?.[1]),
        offsetY: y.offset || pointsToCssPixels(vmlTop?.[1]),
        relativeH: x.relativeFrom,
        relativeV: y.relativeFrom
      });
    });
  });

  return shapes;
}

function parseShapeColor(value, fallback) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

async function extractDocxDrawingAssets(file) {
  if (!file) return { images: [], shapes: [] };
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const relationshipsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
    if (!documentXml || !relationshipsXml) return { images: [], shapes: [] };
    const parser = new DOMParser();
    const documentRoot = parser.parseFromString(documentXml, 'application/xml');
    const relationshipsRoot = parser.parseFromString(relationshipsXml, 'application/xml');
    const relationships = new Map(getElementsByLocalName(relationshipsRoot, 'Relationship').map((relationship) => [
      relationship.getAttribute('Id'), relationship.getAttribute('Target')
    ]));
    const images = [];
    getElementsByLocalName(documentRoot, 'blip').forEach((blip) => {
      const target = relationships.get(blip.getAttribute('embed'));
      if (!target) return;
      const pathParts = `word/${target}`.split('/');
      const normalizedParts = [];
      pathParts.forEach((part) => {
        if (!part || part === '.') return;
        if (part === '..') normalizedParts.pop();
        else normalizedParts.push(part);
      });
      const path = normalizedParts.join('/');
      const entry = zip.file(path);
      if (entry) images.push({ path, blobPromise: entry.async('blob') });
    });
    const shapes = extractAnchoredShapes(documentRoot);
    return { images: await Promise.all(images.map(async (image) => ({ ...image, blob: await image.blobPromise }))), shapes };
  } catch (error) {
    console.warn('[DocxPdfConvert] original drawing extraction skipped:', error);
    return { images: [], shapes: [] };
  }
}

function drawExtractedShape(shape, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * CAPTURE_SCALE));
  canvas.height = Math.max(1, Math.round(height * CAPTURE_SCALE));
  const context = canvas.getContext('2d');
  context.scale(CAPTURE_SCALE, CAPTURE_SCALE);
  context.beginPath();
  if (shape.type === 'ellipse' || shape.type === 'oval') {
    context.ellipse(width / 2, height / 2, Math.max(0, width / 2 - shape.strokeWidth / 2), Math.max(0, height / 2 - shape.strokeWidth / 2), 0, 0, Math.PI * 2);
  } else {
    context.rect(shape.strokeWidth / 2, shape.strokeWidth / 2, width - shape.strokeWidth, height - shape.strokeWidth);
  }
  if (shape.fill !== 'none') { context.fillStyle = shape.fill; context.fill(); }
  if (shape.stroke !== 'none') { context.strokeStyle = shape.stroke; context.lineWidth = shape.strokeWidth; context.stroke(); }
  return canvas;
}

async function captureOriginalImage(blob, width, height) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * CAPTURE_SCALE));
    canvas.height = Math.max(1, Math.round(height * CAPTURE_SCALE));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function buildShapePlacements(pages, shapes) {
  const renderedParagraphs = pages.flatMap((page, pageIndex) => (
    Array.from(page.querySelectorAll('p')).map((element) => ({ element, page, pageIndex }))
  ));

  return pages.map((page, pageIndex) => shapes.flatMap((shape) => {
    const precedingText = shape.precedingText.replace(/\s+/g, ' ').trim();
    const precedingSignature = precedingText.slice(-80);
    const precedingIndex = precedingSignature
      ? renderedParagraphs.findIndex(({ element }) => element.textContent.replace(/\s+/g, ' ').trim().endsWith(precedingSignature))
      : -1;
    const mappedIndex = precedingIndex >= 0 ? precedingIndex + 1 : shape.paragraphIndex;
    let paragraph = renderedParagraphs[mappedIndex];
    let placeAfterPrecedingParagraph = false;
    if (!paragraph && precedingIndex >= 0) {
      paragraph = renderedParagraphs[precedingIndex];
      placeAfterPrecedingParagraph = true;
    }
    if (!paragraph || paragraph.pageIndex !== pageIndex || !shape.width || !shape.height) return [];

    const pageRect = page.getBoundingClientRect();
    const paragraphRect = paragraph.element.getBoundingClientRect();
    const scaleX = page.offsetWidth ? pageRect.width / page.offsetWidth : 1;
    const scaleY = page.offsetHeight ? pageRect.height / page.offsetHeight : scaleX;
    const contentLeft = (paragraphRect.left - pageRect.left) / (scaleX || 1);
    const paragraphTop = (
      (placeAfterPrecedingParagraph ? paragraphRect.bottom : paragraphRect.top) - pageRect.top
    ) / (scaleY || 1);
    const left = ['page', 'margin'].includes(shape.relativeH) ? shape.offsetX : contentLeft + shape.offsetX;
    const top = ['page', 'margin'].includes(shape.relativeV) ? shape.offsetY : paragraphTop + shape.offsetY;

    return [{ ...shape, left, top }];
  }));
}

function isXmlShapeElement(element) {
  return ['oval', 'roundrect', 'arc', 'shape'].includes(String(element.localName || '').toLowerCase());
}

async function capturePage(page, html2canvas, drawingAssets, imageCursor, xmlShapes) {
  const visualElements = getVisualElements(page);
  const captureMarker = `docx-pdf-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  page.setAttribute('data-docx-pdf-page', captureMarker);
  const ignoredElements = visualElements.map((element) => {
    const hadIgnoreAttribute = element.hasAttribute('data-html2canvas-ignore');
    const previousValue = element.getAttribute('data-html2canvas-ignore');
    element.setAttribute('data-html2canvas-ignore', 'true');
    return { element, hadIgnoreAttribute, previousValue };
  });
  try {
    const canvas = await html2canvas(page, {
      scale: CAPTURE_SCALE,
      backgroundColor: '#ffffff',
      useCORS: true,
      ignoreElements: (element) => element.tagName === 'IFRAME',
      onclone: (clonedDocument) => {
        const clonedPage = clonedDocument.querySelector(`[data-docx-pdf-page="${captureMarker}"]`);
        if (!clonedPage) return;
        clonedPage.style.transform = 'none';
        clonedPage.style.width = `${page.offsetWidth}px`;
        clonedPage.style.height = `${page.offsetHeight}px`;
        clonedPage.querySelectorAll('table, td, th').forEach((element) => {
          element.style.boxSizing = 'border-box';
        });
        let ancestor = clonedPage.parentElement;
        while (ancestor && ancestor !== clonedDocument.body) {
          ancestor.style.transform = 'none';
          ancestor = ancestor.parentElement;
        }
      },
    });
    const pageRect = page.getBoundingClientRect();
    const overlays = await Promise.all(visualElements.map(async (element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      let visualCanvas;
      try {
        const originalImage = element.tagName === 'IMG' ? drawingAssets.images[imageCursor.value++] : null;
        if (isXmlShapeElement(element) && xmlShapes.length) return null;
        visualCanvas = originalImage
          ? await captureOriginalImage(originalImage.blob, rect.width, rect.height)
          : await html2canvas(element, { scale: CAPTURE_SCALE, backgroundColor: null, useCORS: true, ignoreElements: (candidate) => candidate.tagName === 'IFRAME' });
      } catch (error) {
        console.warn('[DocxPdfConvert] visual element capture skipped:', error);
        return null;
      }
      return {
        canvas: visualCanvas,
        left: (rect.left - pageRect.left) / pageRect.width * page.offsetWidth,
        top: (rect.top - pageRect.top) / pageRect.height * page.offsetHeight,
        width: rect.width / pageRect.width * page.offsetWidth,
        height: rect.height / pageRect.height * page.offsetHeight
      };
    }));
    const xmlShapeOverlays = xmlShapes.map((shape) => ({
      canvas: drawExtractedShape(shape, shape.width, shape.height),
      left: shape.left,
      top: shape.top,
      width: shape.width,
      height: shape.height
    }));
    return {
      canvas,
      pageWidth: page.offsetWidth || canvas.width / CAPTURE_SCALE,
      pageHeight: page.offsetHeight || canvas.height / CAPTURE_SCALE,
      overlays: [...overlays.filter(Boolean), ...xmlShapeOverlays]
    };
  } finally {
    ignoredElements.forEach(({ element, hadIgnoreAttribute, previousValue }) => {
      if (hadIgnoreAttribute) element.setAttribute('data-html2canvas-ignore', previousValue);
      else element.removeAttribute('data-html2canvas-ignore');
    });
    page.removeAttribute('data-docx-pdf-page');
  }
}

export async function convertDocxDomToPdf({ root, fileName, file }) {
  if (!root) throw new Error('DOCX 뷰어가 아직 준비되지 않았습니다.');
  const pages = getVisiblePages(root);
  if (!pages.length) throw new Error('PDF로 변환할 DOCX 내용이 없습니다.');

  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf')
  ]);
  if (document.fonts?.ready) await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const drawingAssets = await extractDocxDrawingAssets(file);
  const shapePlacements = buildShapePlacements(pages, drawingAssets.shapes);
  const imageCursor = { value: 0 };
  const canvases = [];
  for (const [pageIndex, page] of pages.entries()) {
    canvases.push(await capturePage(page, html2canvas, drawingAssets, imageCursor, shapePlacements[pageIndex]));
  }
  if (!canvases.some(({ canvas }) => canvas.width > 0 && canvas.height > 0)) {
    throw new Error('DOCX 내용을 이미지로 변환하지 못했습니다.');
  }

  const first = canvases[0];
  const pdf = new jsPDF({ unit: 'px', format: [first.pageWidth, first.pageHeight], compress: true, hotfixes: ['px_scaling'] });
  canvases.forEach(({ canvas, pageWidth, pageHeight, overlays }, index) => {
    if (index > 0) pdf.addPage([pageWidth, pageHeight]);
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, pageHeight, undefined, 'FAST');
    overlays.forEach(({ canvas: overlay, left, top, width, height }) => {
      pdf.addImage(overlay.toDataURL('image/png'), 'PNG', left, top, width, height, undefined, 'FAST');
    });
  });
  const outputFileName = makeFileName(fileName);
  downloadBlob(pdf.output('blob', { type: PDF_MIME }), outputFileName);
  return { outputFileName, fileName: outputFileName, pages: canvases.length, separatedVisuals: canvases.reduce((count, page) => count + page.overlays.length, 0) };
}
