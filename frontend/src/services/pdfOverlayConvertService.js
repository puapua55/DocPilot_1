import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { moveTextWithOriginalFont, removeSimpleMovedText, replacePdfTextInContentStream } from './pdfDirectTextEdit.js';

const FONT_URL = '/fonts/NotoSansKR-Regular.base64.txt';
const TEXT_BASELINE_RATIO = 0.84;

function round(value, precision = 3) {
  const factor = 10 ** precision;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : 0;
}

function parseCssColor(value, fallback = [0, 0, 0]) {
  const hex = String(value || '').trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const expanded = hex[1].length === 3
      ? hex[1].split('').map((channel) => `${channel}${channel}`).join('')
      : hex[1];
    return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
  }
  const channels = String(value || '').match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length < 3 || channels.some((channel) => !Number.isFinite(channel))) {
    return fallback;
  }
  return channels.map((channel) => Math.min(255, Math.max(0, channel)));
}

function parseHighlightPaint(value) {
  const channels = String(value || '').match(/[\d.]+/g)?.map(Number) || [255, 235, 59, 0.35];
  const rgbChannels = channels.slice(0, 3).map((channel) => channel > 1 ? channel / 255 : channel);
  return {
    color: rgb(rgbChannels[0], rgbChannels[1], rgbChannels[2]),
    opacity: channels.length >= 4 ? Math.min(1, Math.max(0, channels[3])) : 0.35
  };
}

function measurePdfText(font, text, size) {
  try {
    const width = font?.widthOfTextAtSize?.(text, size);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

function glyphPathToSvg(path) {
  const number = (value) => Number(value.toFixed(3));
  return path.commands.map(({ command, args }) => {
    if (command === 'moveTo') return `M ${number(args[0])} ${number(-args[1])}`;
    if (command === 'lineTo') return `L ${number(args[0])} ${number(-args[1])}`;
    if (command === 'quadraticCurveTo') return `Q ${number(args[0])} ${number(-args[1])} ${number(args[2])} ${number(-args[3])}`;
    if (command === 'bezierCurveTo') return `C ${number(args[0])} ${number(-args[1])} ${number(args[2])} ${number(-args[3])} ${number(args[4])} ${number(-args[5])}`;
    return command === 'closePath' ? 'Z' : '';
  }).join(' ');
}

function drawFallbackTextOutlines(page, font, text, mapped, color, bold = false) {
  if (!font || !text) return;
  const scale = mapped.fontSize / font.unitsPerEm;
  if (!Number.isFinite(scale) || scale <= 0) return;
  const layout = font.layout(text);
  let cursorX = mapped.textX;
  let cursorY = mapped.textY;
  layout.glyphs.forEach((glyph, index) => {
    const position = layout.positions[index];
    const path = glyphPathToSvg(glyph.path);
    if (path) {
      const draw = (offset = 0) => page.drawSvgPath(path, {
        x: cursorX + position.xOffset * scale + offset,
        y: cursorY + position.yOffset * scale,
        scale,
        color,
        rotate: getTextRotation(mapped.rotation)
      });
      draw();
      // The fallback font is intentionally regular. A small second glyph pass
      // gives the exported text a deterministic bold appearance without
      // changing the source PDF font resource.
      if (bold) draw(Math.max(0.25, mapped.fontSize * 0.025));
    }
    cursorX += position.xAdvance * scale;
    cursorY += position.yAdvance * scale;
  });
}

function collectMovableTextReplacements(movableTexts = []) {
  return movableTexts
    // An instant replacement has already been written to the reloaded PDF.
    // Keep its selected editor region out of later saves until the user moves
    // it or changes its text/style.
    .filter((item) => !item?.persistedToPdf || item?.hasChanges)
    .map((item) => ({ item, text: String(item?.displayText ?? item?.text ?? '').trim() }))
    .filter(({ item, text }) => (
      Number.isInteger(Number(item?.pageNumber)) && Number(item.pageNumber) > 0
      && Number.isFinite(Number(item?.sourcePageWidth)) && Number(item.sourcePageWidth) > 0
      && Number.isFinite(Number(item?.sourcePageHeight)) && Number(item.sourcePageHeight) > 0
      && Number.isFinite(Number(item?.originalRect?.x))
      && Number.isFinite(Number(item?.originalRect?.y))
      && Number.isFinite(Number(item?.originalRect?.width))
      && Number.isFinite(Number(item?.originalRect?.height))
      && Number.isFinite(Number(item?.currentRect?.x))
      && Number.isFinite(Number(item?.currentRect?.y))
      && Number.isFinite(Number(item?.fontSize))
      && Number(item.fontSize) > 0 && Number(item.originalRect.width) > 0 && Number(item.originalRect.height) > 0
      && text
    ))
    .map(({ item, text }) => ({
      id: item.id,
      sourceSelection: item.sourceSelection,
      sourceText: String(item.sourceSelection?.selectedText || item.sourceText || item.originalText || item.originalUnicodeText || text).trim(),
      originalText: String(item.sourceSelection?.selectedText || item.originalText || item.sourceText || item.originalUnicodeText || text).trim(),
      // All UI movable objects originate in PDF.js Unicode selection text.
      // Keep direct source-font replay out of the deletion plan even for
      // objects created before the explicit flag was introduced.
      forceUnicodeFallback: true,
      sourceFont: item.sourceFont || null,
      originalGlyphText: item.originalGlyphText || item.sourceFont?.glyphText || null,
      originalEncodedText: item.originalEncodedText || null,
      fontAnalysis: item.fontAnalysis || null,
      pageNumber: Number(item.pageNumber),
      sourcePageWidth: Number(item.sourcePageWidth),
      sourcePageHeight: Number(item.sourcePageHeight),
      coverX: Number(item.originalRect.x),
      coverY: Number(item.originalRect.y),
      coverWidth: Number(item.originalRect.width),
      coverHeight: Number(item.originalRect.height),
      textX: Number(item.currentRect.x),
      textY: Number(item.currentRect.y),
      baseline: Number(item.currentRect.y) + (
        Number.isFinite(Number(item.baselineOffset))
          ? Number(item.baselineOffset)
          : Number(item.fontSize) * TEXT_BASELINE_RATIO
      ),
      baselineOffset: Number.isFinite(Number(item.baselineOffset))
        ? Number(item.baselineOffset) : Number(item.fontSize) * TEXT_BASELINE_RATIO,
      fontSize: Number(item.fontSize),
      displayText: text,
      text,
      fontWeight: item.fontWeight || 'normal',
      fontStyle: item.fontStyle || 'normal',
      textDecoration: item.textDecoration || 'none',
      backgroundColor: parseCssColor(item.backgroundColor, [255, 255, 255]),
      textColor: parseCssColor(item.color, [17, 17, 17]),
      type: 'movable-text',
      canDirectEdit: false,
      fallbackReason: '저장 시 원본 content stream을 확인합니다.'
    }));
}

function toPdfColor(channels) {
  return rgb(channels[0] / 255, channels[1] / 255, channels[2] / 255);
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
  pixels.forEach(([red, green, blue]) => {
    const color = quantizeColor(red, green, blue);
    if (excludedColor && colorDistance(color, excludedColor) < 56) return;
    const key = color.join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dominant = Array.from(counts.entries()).sort((first, second) => second[1] - first[1])[0];
  return dominant ? dominant[0].split(',').map(Number) : null;
}

function sampleCanvasColors(pageElement, replacement) {
  const canvas = pageElement.querySelector('.pdf-canvas');
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!canvas || !context) return replacement;

  const scaleX = canvas.width / Math.max(pageElement.clientWidth, 1);
  const scaleY = canvas.height / Math.max(pageElement.clientHeight, 1);
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

  const backgroundColor = findDominantColor(pixels);
  // Anti-aliased glyph-edge pixels are not a reliable text-color source:
  // their gray value changes with the selected character's position. The
  // content-stream analyzer supplies the original fill when available; keep
  // the preview's declared text color otherwise.
  return {
    ...replacement,
    backgroundColor: backgroundColor || replacement.backgroundColor,
    textColor: replacement.textColor
  };
}

function collectAppliedReplacements(replaceState = {}) {
  const replacements = [];
  const pages = Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]'));

  pages.forEach((pageElement) => {
    const sourcePageWidth = pageElement.clientWidth || pageElement.getBoundingClientRect().width;
    const sourcePageHeight = pageElement.clientHeight || pageElement.getBoundingClientRect().height;

    pageElement.querySelectorAll('.replacement-layer > div').forEach((item) => {
      const cover = item.querySelector('.replacement-cover');
      const text = item.querySelector('.replacement-text');
      if (!cover || !text) return;

      const coverStyle = window.getComputedStyle(cover);
      const textStyle = window.getComputedStyle(text);
      const replacement = {
        pageNumber: Number(pageElement.dataset.pageNumber),
        sourcePageWidth,
        sourcePageHeight,
        coverX: Number.parseFloat(cover.style.left || coverStyle.left),
        coverY: Number.parseFloat(cover.style.top || coverStyle.top),
        coverWidth: Number.parseFloat(cover.style.width || coverStyle.width),
        coverHeight: Number.parseFloat(cover.style.height || coverStyle.height),
        textX: Number.parseFloat(text.style.left || textStyle.left),
        textY: Number.parseFloat(text.style.top || textStyle.top),
        baseline: Number(text.dataset.baseline),
        fontSize: Number.parseFloat(text.style.fontSize || textStyle.fontSize),
        text: text.textContent || '',
        fontWeight: textStyle.fontWeight || '400',
        fontStyle: textStyle.fontStyle || 'normal',
        textDecoration: textStyle.textDecoration || 'none',
        backgroundColor: parseCssColor(coverStyle.backgroundColor, [255, 255, 255]),
        textColor: parseCssColor(textStyle.color, [17, 17, 17])
      };
      const source = item.dataset.replacementSource ? JSON.parse(item.dataset.replacementSource) : {};
      Object.assign(replacement, {
        id: source.id,
        type: 'pdf',
        keyword: source.keyword || replaceState.originalText,
        lineNumber: Number(source.lineNumber),
        matchIndex: Number(source.matchIndex),
        originalText: source.originalText || replaceState.originalText,
        replacementText: source.replacementText || replacement.text,
        newText: replaceState.newText,
        sourceText: source.sourceText || source.keyword || replaceState.originalText,
        sourceFullText: source.sourceFullText || source.fullText || source.lineText || '',
        normalizedSourceText: String(source.sourceText || source.keyword || replaceState.originalText).replace(/\s+/g, '').trim(),
        normalizedTargetText: String(source.replacementText || replacement.text).replace(/\s+/g, '').trim(),
        textItemIndexes: source.textItemIndexes || [],
        originalRect: { x: replacement.coverX, y: replacement.coverY, width: replacement.coverWidth, height: replacement.coverHeight },
        matchRect: { x: replacement.coverX, y: replacement.coverY, width: replacement.coverWidth, height: replacement.coverHeight },
        fullTextRect: { x: replacement.coverX, y: replacement.coverY, width: replacement.coverWidth, height: replacement.coverHeight },
        replaceMode: 'overlay-fallback',
        canDirectReplace: true,
        canRewriteFullObject: true,
        // Immediate replacement follows the movable-text Unicode insertion
        // path so the fitted position/size is honored even when the source
        // font resource cannot safely encode the replacement.
        forceUnicodeFallback: true
      });

      const numericValues = [
        replacement.pageNumber, replacement.sourcePageWidth, replacement.sourcePageHeight,
        replacement.coverX, replacement.coverY, replacement.coverWidth, replacement.coverHeight,
        replacement.textX, replacement.textY, replacement.fontSize
      ];
      if (numericValues.every(Number.isFinite)) {
        replacements.push(sampleCanvasColors(pageElement, replacement));
      }
    });
  });

  return replacements;
}

function collectReplacementPlanFallback(replaceState = {}) {
  const targets = Array.isArray(replaceState?.selectedTargets)
    ? replaceState.selectedTargets : [];
  return targets.map((target, index) => {
    const raw = target?.raw || target || {};
    const sourceText = String(raw.originalText || raw.matchedText || replaceState.originalText || '').trim();
    const sourceFullText = String(raw.sourceFullText || raw.fullText || raw.text || sourceText).trim();
    return {
      id: raw.id || `replacement-plan-${raw.pageNumber || raw.page || 1}-${index}`,
      type: 'pdf',
      pageNumber: Number(raw.pageNumber ?? raw.page ?? 1),
      sourceText,
      originalText: sourceText,
      sourceFullText,
      replacementText: String(replaceState.newText ?? ''),
      newText: String(replaceState.newText ?? ''),
      text: String(replaceState.newText ?? ''),
      forceUnicodeFallback: true,
      backgroundColor: [255, 255, 255],
      textColor: [17, 17, 17]
    };
  }).filter((item) => item.pageNumber > 0 && item.sourceText && item.newText);
}

function base64ToBytes(base64) {
  const normalized = String(base64 || '').replace(/^data:.*?;base64,/, '').replace(/\s+/g, '');
  const binary = window.atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function loadReplacementFont() {
  const injected = window.__DOC_PILOT_KOREAN_FONT_BASE64__;
  if (typeof injected === 'string' && injected.trim()) return base64ToBytes(injected);

  const response = await fetch(FONT_URL);
  if (!response.ok) throw new Error('교체 텍스트용 글꼴을 불러오지 못했습니다.');
  return base64ToBytes(await response.text());
}

function normalizeRotation(angle) {
  return ((Number(angle) || 0) % 360 + 360) % 360;
}

function displayPointToPdf(x, y, pageWidth, pageHeight, rotation) {
  if (rotation === 90) return { x: y, y: x };
  if (rotation === 180) return { x: pageWidth - x, y };
  if (rotation === 270) return { x: pageWidth - y, y: pageHeight - x };
  return { x, y: pageHeight - y };
}

function getDisplaySize(pageWidth, pageHeight, rotation) {
  return rotation === 90 || rotation === 270
    ? { width: pageHeight, height: pageWidth }
    : { width: pageWidth, height: pageHeight };
}

function mapReplacementToPage(replacement, page) {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const rotation = normalizeRotation(page.getRotation()?.angle);
  const display = getDisplaySize(pageWidth, pageHeight, rotation);
  const scaleX = display.width / Math.max(replacement.sourcePageWidth, 1);
  const scaleY = display.height / Math.max(replacement.sourcePageHeight, 1);
  const coverLeft = replacement.coverX * scaleX;
  const coverTop = replacement.coverY * scaleY;
  const coverRight = (replacement.coverX + replacement.coverWidth) * scaleX;
  const coverBottom = (replacement.coverY + replacement.coverHeight) * scaleY;
  const corners = [
    displayPointToPdf(coverLeft, coverTop, pageWidth, pageHeight, rotation),
    displayPointToPdf(coverRight, coverTop, pageWidth, pageHeight, rotation),
    displayPointToPdf(coverLeft, coverBottom, pageWidth, pageHeight, rotation),
    displayPointToPdf(coverRight, coverBottom, pageWidth, pageHeight, rotation)
  ];
  const rectX = Math.min(...corners.map((point) => point.x));
  const rectY = Math.min(...corners.map((point) => point.y));
  const baseline = displayPointToPdf(
    replacement.textX * scaleX,
    (Number.isFinite(replacement.baseline) ? replacement.baseline : replacement.textY + replacement.fontSize * TEXT_BASELINE_RATIO) * scaleY,
    pageWidth,
    pageHeight,
    rotation
  );

  return {
    rotation,
    rectX: round(rectX),
    rectY: round(rectY),
    rectWidth: round(Math.max(...corners.map((point) => point.x)) - rectX),
    rectHeight: round(Math.max(...corners.map((point) => point.y)) - rectY),
    textX: round(baseline.x),
    textY: round(baseline.y),
    fontSize: round(replacement.fontSize * scaleY)
  };
}

function mapHighlightToPage(highlight, page) {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const rotation = normalizeRotation(page.getRotation()?.angle);
  const display = getDisplaySize(pageWidth, pageHeight, rotation);
  const scaleX = display.width / Math.max(Number(highlight.sourcePageWidth) || 1, 1);
  const scaleY = display.height / Math.max(Number(highlight.sourcePageHeight) || 1, 1);
  const left = Number(highlight.left) * scaleX;
  const top = Number(highlight.top) * scaleY;
  const right = (Number(highlight.left) + Number(highlight.width)) * scaleX;
  const bottom = (Number(highlight.top) + Number(highlight.height)) * scaleY;
  const corners = [
    displayPointToPdf(left, top, pageWidth, pageHeight, rotation),
    displayPointToPdf(right, top, pageWidth, pageHeight, rotation),
    displayPointToPdf(left, bottom, pageWidth, pageHeight, rotation),
    displayPointToPdf(right, bottom, pageWidth, pageHeight, rotation)
  ];
  const x = Math.min(...corners.map((point) => point.x));
  const y = Math.min(...corners.map((point) => point.y));
  return {
    x: round(x),
    y: round(y),
    width: round(Math.max(...corners.map((point) => point.x)) - x),
    height: round(Math.max(...corners.map((point) => point.y)) - y)
  };
}

function getTextRotation(rotation) {
  if (rotation === 90) return degrees(90);
  if (rotation === 180) return degrees(180);
  if (rotation === 270) return degrees(270);
  return degrees(0);
}

function downloadPdf(bytes, outputFileName) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = outputFileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

export function makeOverlayConvertedFileName(fileName = 'document.pdf') {
  return `${fileName.replace(/\.pdf$/i, '')}_overlay_converted.pdf`;
}

export async function convertPdfWithOriginalOverlay({ file, replacement = {}, movableTexts = [], highlights = [], download = true }) {
  const { isPdfFile } = await import('../utils/fileUtils.js');
  if (!file || !isPdfFile(file)) throw new Error('먼저 PDF 파일을 선택해주세요.');

  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  let replacements = [
    ...collectAppliedReplacements(replacement),
    ...collectMovableTextReplacements(movableTexts)
  ];
  if (!replacements.length) replacements = collectReplacementPlanFallback(replacement);
  if (!replacements.length && !highlights.length) throw new Error('먼저 텍스트 교체, 이동 또는 하이라이트를 화면에 적용해주세요.');

  const sourceBytes = await file.arrayBuffer();
  const { outputBytes, ...report } = await buildPdfWithTextEdits({ sourceBytes, replacements, highlights });
  const outputFileName = makeOverlayConvertedFileName(file.name);
  if (download) downloadPdf(outputBytes, outputFileName);
  return { ...report, outputFileName, fileName: outputFileName, outputBytes: download ? undefined : outputBytes };
}

// Keep byte generation separate from browser download so saved content can be
// reopened and verified independently of the editor DOM.
export async function buildPdfWithTextEdits({ sourceBytes, fontBytes, replacements: input = [], highlights: inputHighlights = [] }) {
  const replacements = input.map((item) => ({ ...item, canDirectEdit: false }));
  const highlights = inputHighlights.filter((item) => (
    Number.isFinite(Number(item?.pageNumber)) && Number(item.pageNumber) > 0
    && Number.isFinite(Number(item?.sourcePageWidth)) && Number(item.sourcePageWidth) > 0
    && Number.isFinite(Number(item?.sourcePageHeight)) && Number(item.sourcePageHeight) > 0
    && Number.isFinite(Number(item?.left)) && Number.isFinite(Number(item?.top))
    && Number.isFinite(Number(item?.width)) && Number(item.width) > 0
    && Number.isFinite(Number(item?.height)) && Number(item.height) > 0
  ));
  const pdfDocument = await PDFDocument.load(sourceBytes);
  const pages = pdfDocument.getPages();
  if (replacements.some((item) => !Number.isInteger(item.pageNumber) || !pages[item.pageNumber - 1])) {
    throw new Error('편집 대상 PDF 페이지를 찾을 수 없습니다.');
  }
  let replacementFont;
  let replacementOutlineFont;
  // Replacement text is always embedded before the direct planner runs. The
  // planner may still decline the operation and leave the item for overlay.
  if (replacements.some((item) => item.type === 'pdf' || !item.fontPreserved)) {
  const fallbackFontBytes = fontBytes || await loadReplacementFont();
  pdfDocument.registerFontkit({
    create: (bytes) => {
      const font = fontkit.create(bytes);
      return font.variationAxes?.wght ? font.getVariation({ wght: 400 }) : font;
    }
  });
    replacementFont = await pdfDocument.embedFont(fallbackFontBytes, { subset: true });
    const fallbackFont = fontkit.create(fallbackFontBytes);
    replacementOutlineFont = fallbackFont.variationAxes?.wght
      ? fallbackFont.getVariation({ wght: 400 }) : fallbackFont;
  }
  const directReplacementResults = replacePdfTextInContentStream(
    pdfDocument, replacements.filter((item) => item.type === 'pdf'), replacementFont, replacementOutlineFont
  );
  directReplacementResults.forEach((outcome, replacement) => {
    replacement.canDirectEdit = outcome.direct === true;
    replacement.directReplacement = outcome.directReplacement === true;
    replacement.replaceMode = outcome.replaceMode || (outcome.direct ? 'direct-replace' : 'overlay-fallback');
    replacement.canDirectReplace = outcome.direct === true && outcome.replaceMode === 'direct-replace';
    replacement.canRewriteFullObject = outcome.direct === true && outcome.replaceMode === 'full-object-rewrite';
    replacement.fallbackReason = outcome.reason;
    replacement.commandRange = outcome.commandRange || null;
    replacement.deletedCommandCount = outcome.deletedCommandCount || 0;
    replacement.fontPreserved = outcome.fontPreserved === true;
    replacement.canReuseOriginalFont = outcome.canReuseOriginalFont === true;
    replacement.drawingCommands = outcome.drawingCommands;
    if (Array.isArray(outcome.textColor) && outcome.textColor.length >= 3) replacement.textColor = outcome.textColor;
    replacement.sourceFullText = outcome.sourceFullText || replacement.sourceFullText;
    replacement.newFullText = outcome.newFullText || null;
    replacement.text = outcome.newFullText || replacement.text;
  });
  // UI-selected moves always use Unicode fallback for the new text, but can
  // still safely remove the matched original content command. This avoids a
  // white cover rectangle at the source position whenever evidence is exact.
  const unicodeMoves = replacements.filter((item) => item.type === 'movable-text' && item.forceUnicodeFallback === true);
  const unicodeRemovalResults = removeSimpleMovedText(pdfDocument, unicodeMoves);
  const reusableMoves = replacements.filter((item) => !unicodeMoves.includes(item));
  const reuseResults = moveTextWithOriginalFont(pdfDocument, reusableMoves);
  const removalResults = new Map([...unicodeRemovalResults, ...reuseResults]);
  removalResults.forEach((outcome, replacement) => {
    replacement.canDirectEdit = outcome.direct;
    replacement.directRemoval = outcome.directRemoval === true;
    replacement.deleteMode = outcome.deleteMode || null;
    replacement.deletedCommandCount = outcome.deletedCommandCount || 0;
    replacement.commandRange = outcome.commandRange || null;
    replacement.fallbackReason = outcome.reason;
    replacement.fontPreserved = outcome.fontPreserved === true;
    replacement.sourceFont = outcome.sourceFont;
    replacement.canReuseOriginalFont = outcome.canReuseOriginalFont === true;
    replacement.drawingCommands = outcome.drawingCommands;
  });
  // Draw viewer highlights after the original page content has been loaded,
  // but before replacement covers/text, so highlights stay behind edited text.
  highlights.forEach((highlight) => {
    const page = pages[Number(highlight.pageNumber) - 1];
    if (!page) return;
    const mapped = mapHighlightToPage(highlight, page);
    const paint = parseHighlightPaint(highlight.color);
    page.drawRectangle({ ...mapped, color: paint.color, opacity: paint.opacity });
  });
  replacements.forEach((replacement) => {
    const page = pages[replacement.pageNumber - 1];
    if (!page) return;
    const mapped = mapReplacementToPage(replacement, page);

    // Experimental no-cover mode for text movement: even when source
    // command matching fails, do not paint a background rectangle. The new
    // text is still inserted below; the report exposes unresolved items so
    // callers can detect that the original may remain in the PDF.
    if (!replacement.canDirectEdit && replacement.type !== 'movable-text'
      && Number(replacement.coverWidth) > 0 && Number(replacement.coverHeight) > 0) page.drawRectangle({
      x: mapped.rectX,
      y: mapped.rectY,
      width: mapped.rectWidth,
      height: mapped.rectHeight,
      color: toPdfColor(replacement.backgroundColor)
    });
  });

  // Cover every fallback source before drawing any new text, so a later cover
  // cannot erase a moved object placed over another object's old position.
  replacements.forEach((replacement) => {
    const page = pages[replacement.pageNumber - 1];
    if (!page) return;
    if (replacement.fontPreserved || replacement.directReplacement || replacement.replaceMode === 'full-object-rewrite') return;
    const mapped = mapReplacementToPage(replacement, page);
    if (![mapped.textX, mapped.textY, mapped.fontSize].every(Number.isFinite)) return;
    const measuredWidth = measurePdfText(replacementFont, replacement.text, mapped.fontSize);
    const textColor = toPdfColor(replacement.textColor);
    const isItalic = replacement.fontStyle === 'italic';
    page.drawText(replacement.text, {
      x: mapped.textX,
      y: mapped.textY,
      size: mapped.fontSize,
      font: replacementFont,
      color: textColor,
      rotate: getTextRotation(mapped.rotation),
      xSkew: isItalic ? degrees(-12) : degrees(0)
    });
    // Keep the selectable Unicode text above, then add deterministic glyph
    // outlines. Some external viewers retain ToUnicode but render a variable
    // font subset with blank glyphs; these paths remain visible regardless of
    // that font mapping.
    drawFallbackTextOutlines(page, replacementOutlineFont, replacement.text, mapped, textColor,
      replacement.fontWeight === 'bold');
    if (replacement.textDecoration === 'underline' || replacement.textDecoration === 'line-through') {
      const lineWidth = Math.max(1, mapped.fontSize * 0.06);
      const lineY = replacement.textDecoration === 'underline'
        ? mapped.textY - mapped.fontSize * 0.1
        : mapped.textY + mapped.fontSize * 0.35;
      page.drawLine({
        start: { x: mapped.textX, y: lineY },
        end: { x: mapped.textX + (measuredWidth || mapped.rectWidth), y: lineY },
        thickness: lineWidth,
        color: textColor,
        rotate: getTextRotation(mapped.rotation)
      });
    }
    replacement.measuredWidth = measuredWidth;
    replacement.usedMaxWidth = false;
  });

  // Replay the original font and encoded glyphs after all fallback covers.
  // Normalization isolates the original page graphics state with q/Q.
  replacements.filter((item) => item.fontPreserved && item.drawingCommands).forEach((item) => {
    const page = pages[item.pageNumber - 1];
    page.node.normalize();
    const stream = pdfDocument.context.flateStream(Uint8Array.from(item.drawingCommands, (char) => char.charCodeAt(0)));
    page.node.addContentStream(pdfDocument.context.register(stream));
  });

  const outputBytes = await pdfDocument.save({ useObjectStreams: true });
  const movableResults = replacements.filter((item) => item.type === 'movable-text');
  const pdfReplacementResults = replacements.filter((item) => item.type === 'pdf');
  const fallbackReasons = [...new Map(movableResults
    .filter((item) => !item.fontPreserved && item.fallbackReason)
    .map((item) => [item.fallbackReason, 0]))].map(([reason]) => ({
      reason,
      count: movableResults.filter((item) => !item.fontPreserved && item.fallbackReason === reason).length
    }));

  return {
    success: true,
    outputBytes,
    replaceCount: replacements.length,
    pages: pages.length,
    method: 'original-pdf-hybrid-text-edit',
    movableTextCount: movableResults.length,
    highlightCount: highlights.length,
    pagePlanCount: new Set(movableResults.map((item) => item.pageNumber)).size,
    directEditCount: replacements.filter((item) => item.canDirectEdit === true).length,
    pdfDirectReplaceCount: pdfReplacementResults.filter((item) => item.replaceMode === 'direct-replace').length,
    pdfFullObjectRewriteCount: pdfReplacementResults.filter((item) => item.replaceMode === 'full-object-rewrite').length,
    pdfOriginalFontReuseCount: pdfReplacementResults.filter((item) => item.canReuseOriginalFont === true).length,
    pdfOverlayFallbackCount: pdfReplacementResults.filter((item) => item.canDirectEdit !== true).length,
    replacementResults: pdfReplacementResults.map((item) => ({
      id: item.id, pageNumber: item.pageNumber, replaceMode: item.replaceMode,
      canDirectReplace: item.canDirectReplace === true,
      canRewriteFullObject: item.canRewriteFullObject === true,
      canReuseOriginalFont: item.canReuseOriginalFont === true,
      fontPreserved: item.fontPreserved === true,
      fallbackReason: item.fallbackReason || null,
      sourceFullText: item.sourceFullText || null,
      newFullText: item.newFullText || null
    })),
    directDeleteCount: movableResults.filter((item) => item.directRemoval === true).length,
    partialDeleteCount: movableResults.filter((item) => item.deleteMode === 'partial-string').length,
    fullObjectDeleteCount: movableResults.filter((item) => item.deleteMode === 'full-object').length,
    rangeDeleteCount: movableResults.filter((item) => item.deleteMode === 'range-group').length,
    directMovedCount: movableResults.filter((item) => item.canDirectEdit === true).length,
    fontPreservedCount: replacements.filter((item) => item.fontPreserved).length,
    originalFontReuseCount: movableResults.filter((item) => item.fontPreserved).length,
    // A Unicode fallback font at the new location is not an overlay fallback
    // at the source. Only a failed content-stream deletion needs a cover.
    fallbackCount: replacements.filter((item) => item.type !== 'movable-text' && item.canDirectEdit !== true).length,
    fallbackOverlayCount: replacements.filter((item) => item.type !== 'movable-text' && item.canDirectEdit !== true).length,
    noCoverUnresolvedCount: movableResults.filter((item) => item.canDirectEdit !== true).length,
    failedCount: 0,
    fallbackReasons,
    textMoveResults: movableResults.map((item) => ({
      id: item.id, pageNumber: item.pageNumber,
      method: item.fontPreserved ? 'direct' : item.canDirectEdit ? 'direct-remove-overlay' : 'no-cover-fallback', reason: item.fallbackReason,
      fontPreserved: item.fontPreserved === true,
      directRemoval: item.directRemoval === true,
      directDeleteAttempted: item.type === 'movable-text',
      directDeleteSucceeded: item.directRemoval === true,
      deletedText: item.directRemoval ? item.text : null,
      deleteMode: item.deleteMode || 'fallback',
      deletedCommandCount: item.deletedCommandCount || 0,
      matchedCommandCount: item.deletedCommandCount || 0,
      commandRange: item.commandRange || null,
      shouldApplyCover: false,
      canReuseOriginalFont: item.canReuseOriginalFont === true,
      sourceFont: item.sourceFont || null,
      displayText: item.displayText || item.text,
      originalGlyphText: item.originalGlyphText || item.sourceFont?.glyphText || null,
      drawnText: item.text,
      drawnTextLength: [...String(item.text || '')].length,
      measuredWidth: item.measuredWidth ?? null,
      movedRectWidth: Number(item.currentRect?.width || item.originalRect?.width || 0),
      usedMaxWidth: item.usedMaxWidth === true,
      fallbackUsed: item.canDirectEdit !== true,
      unicodeTextFallback: item.fontPreserved !== true
    })),
    directDeleteResults: movableResults.filter((item) => item.directRemoval).map((item) => ({
      objectId: item.id,
      displayText: item.displayText || item.text,
      pageNumber: item.pageNumber,
      directDeleteAttempted: true,
      directDeleteSucceeded: true,
      deleteMode: item.deleteMode,
      deletedCommandCount: item.deletedCommandCount || 0,
      matchedCommandCount: item.deletedCommandCount || 0,
      commandRange: item.commandRange || null,
      shouldApplyCover: false
    })),
    fallbackResults: movableResults.filter((item) => !item.directRemoval).map((item) => ({
      objectId: item.id,
      displayText: item.displayText || item.text,
      pageNumber: item.pageNumber,
      fallbackReason: item.fallbackReason,
      matchedCommandCount: item.deletedCommandCount || 0,
      commandRange: item.commandRange || null,
      shouldApplyCover: false
    }))
  };
}
