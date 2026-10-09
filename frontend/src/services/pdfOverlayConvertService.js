import fontkit from '@pdf-lib/fontkit';
// Keep these classes from the same public module instance as PDFDocument;
// importing internal CommonJS classes makes PDFPage reject them at save time.
import { PDFDocument, PDFOperator, PDFOperatorNames, PDFNumber, degrees, rgb } from 'pdf-lib';
import {
  capturePageDrawingStream, insertDrawingCommandsAtContentAnchors,
  moveTextWithOriginalFont, removeSimpleMovedText, replacePdfTextInContentStream, resetPageDrawingStream
} from './pdfDirectTextEdit.js';
import { loadPdfDocument } from './pdfService.js';
import { describePdfTextFonts } from './pdfFontPreview.js';
import { writePdfTables } from './pdfTableService.js';

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

function drawPdfTextWithLetterSpacing(page, text, options, letterSpacing = 0, horizontalScale = 1) {
  const spacing = Number(letterSpacing) || 0;
  const squeeze = Math.min(2, Math.max(0.01, Number(horizontalScale) || 1));
  const scaled = Math.abs(squeeze - 1) > 0.0001;
  if (scaled) {
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.PushGraphicsState),
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(squeeze * 100)]),
      PDFOperator.of(PDFOperatorNames.EndText)
    );
  }
  // pdf-lib's drawText API has no character-spacing option. For horizontal
  // text, draw each Unicode character at its measured advance so the saved
  // PDF matches the editor's CSS letter-spacing setting.
  if (!spacing || options.rotate?.angle) {
    page.drawText(text, options);
    if (scaled) page.pushOperators(PDFOperator.of(PDFOperatorNames.PopGraphicsState));
    return;
  }
  let cursorX = options.x;
  const characters = Array.from(String(text || ''));
  characters.forEach((character, index) => {
    page.drawText(character, { ...options, x: cursorX });
    cursorX += options.font.widthOfTextAtSize(character, options.size) * squeeze;
    if (index < characters.length - 1) cursorX += spacing * squeeze;
  });
  if (scaled) page.pushOperators(PDFOperator.of(PDFOperatorNames.PopGraphicsState));
}

function getRichRunLines(fontRuns = []) {
  const lines = [[]];
  fontRuns.forEach((run) => {
    String(run.text || '').split('\n').forEach((part, index, parts) => {
      if (part) lines[lines.length - 1].push({ ...run, text: part });
      if (index < parts.length - 1) lines.push([]);
    });
  });
  return lines;
}

function wrapAddedTextLines(lines, maxWidth, measureRun) {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return lines;
  return lines.flatMap((line) => {
    const wrapped = [[]];
    let lineWidth = 0;
    line.forEach((run) => {
      Array.from(run.text || '').forEach((character) => {
        const currentLine = wrapped[wrapped.length - 1];
        const last = currentLine[currentLine.length - 1];
        const metrics = measureRun({ ...run, text: character });
        const advance = metrics.width + (last?._sourceRun === run ? metrics.spacing : 0);
        if (lineWidth > 0 && lineWidth + advance > maxWidth) {
          wrapped.push([]);
          lineWidth = 0;
        }
        const destination = wrapped[wrapped.length - 1];
        const previous = destination[destination.length - 1];
        if (previous?._sourceRun === run) previous.text += character;
        else destination.push({ ...run, text: character, _sourceRun: run });
        lineWidth += metrics.width + (previous?._sourceRun === run ? metrics.spacing : 0);
      });
    });
    return wrapped;
  });
}

function getTextAdvanceVector(rotation, distance) {
  if (rotation === 90) return { x: 0, y: distance };
  if (rotation === 180) return { x: -distance, y: 0 };
  if (rotation === 270) return { x: 0, y: -distance };
  return { x: distance, y: 0 };
}

function getNextLineVector(rotation, distance) {
  if (rotation === 90) return { x: distance, y: 0 };
  if (rotation === 180) return { x: 0, y: distance };
  if (rotation === 270) return { x: -distance, y: 0 };
  return { x: 0, y: -distance };
}

function drawPdfFontRuns(page, replacement, mapped) {
  if (replacement.fitToBoxByLetterSpacing && replacement.fontRuns?.length === 1
    && !String(replacement.text || '').includes('\n')) {
    const run = replacement.fontRuns[0];
    const glyphGaps = Math.max(0, [...String(run.text || '')].length - 1);
    const runSize = mapped.fontSize * (Number(run.fontSize) || replacement.fontSize)
      / Math.max(1, Number(replacement.fontSize) || 1);
    // Letter-spaced text is drawn one glyph at a time, so measure those same
    // glyph advances rather than the font's possibly kerned whole-string width.
    const naturalWidth = [...String(run.text || '')].reduce((width, character) => (
      width + (measurePdfText(run.replacementFont, character, runSize) || 0)
    ), 0);
    if (glyphGaps > 0 && naturalWidth != null && mapped.textBoxWidth > naturalWidth) {
      run.letterSpacing = (mapped.textBoxWidth - naturalWidth) / glyphGaps;
      run.autoLetterSpacing = true;
    }
  }
  const measureRun = (run) => {
    const size = mapped.fontSize * (Number(run.fontSize) || replacement.fontSize) / Math.max(1, Number(replacement.fontSize) || 1);
    const spacing = (Number(run.letterSpacing) || 0) * mapped.fontSize / Math.max(1, Number(replacement.fontSize) || 1);
    const width = run.autoLetterSpacing
      ? [...String(run.text || '')].reduce((sum, character) => (
        sum + (measurePdfText(run.replacementFont, character, size) || 0)
      ), 0)
      : measurePdfText(run.replacementFont, run.text, size);
    return { size, spacing, width: width == null ? 0 : width + spacing * Math.max(0, [...run.text].length - 1) };
  };
  const sourceLines = getRichRunLines(replacement.fontRuns || []);
  const lines = replacement.type === 'added-text'
    ? wrapAddedTextLines(sourceLines, mapped.textBoxWidth, measureRun)
    : sourceLines;
  const nonEmptyLines = replacement.type === 'added-text'
    ? lines : lines.filter((line) => line.some((run) => run.text));
  if (!nonEmptyLines.some((line) => line.some((run) => run.text))) return null;
  const lineWidths = nonEmptyLines.map((line) => line.reduce((sum, run) => sum + measureRun(run).width, 0));
  const lineHeights = nonEmptyLines.map((line) => Math.max(
    mapped.fontSize,
    ...line.map((run) => measureRun(run).size)
  ) * 1.2);
  const lineOffsets = [];
  lineHeights.forEach((height, index) => {
    lineOffsets[index] = lineHeights.slice(0, index).reduce((sum, lineHeight) => sum + lineHeight, 0);
  });
  const maxLineWidth = Math.max(0, ...lineWidths);
  const sourceAdvance = Number(replacement.sourceAdvanceWidth) * page.getWidth()
    / Math.max(1, Number(replacement.sourcePageWidth));
  const sourceScale = sourceAdvance > 0 && maxLineWidth > 0 ? sourceAdvance / maxLineWidth : 0;
  const horizontalScale = sourceScale >= 0.8 && sourceScale <= 1.25
    ? sourceScale
    : !replacement.preserveFontSize && maxLineWidth > mapped.textBoxWidth && mapped.textBoxWidth > 0
      ? mapped.textBoxWidth / maxLineWidth : 1;
  const fittedWidth = maxLineWidth * horizontalScale;
  replacement.renderBounds = {
    x: mapped.textX,
    y: mapped.textY,
    width: Math.max(fittedWidth, mapped.fontSize * 0.25),
    height: lineHeights.reduce((sum, lineHeight) => sum + lineHeight, 0),
    fontSize: mapped.fontSize
  };

  nonEmptyLines.forEach((line, lineIndex) => {
    const lineWidth = line.reduce((sum, run) => sum + measureRun(run).width, 0) * horizontalScale;
    const lineOffset = getNextLineVector(mapped.rotation, lineOffsets[lineIndex] || 0);
    const aligned = applyTextAlignment({
      ...mapped,
      textX: mapped.textX + lineOffset.x,
      textY: mapped.textY + lineOffset.y,
      rectX: mapped.rectX,
      rectY: mapped.rectY
    }, replacement, lineWidth);
    let cursorX = aligned.textX;
    let cursorY = aligned.textY;
    line.forEach((run) => {
      const metrics = measureRun(run);
      const runColor = toPdfColor(parseCssColor(run.color, replacement.textColor));
      const runMapped = { ...mapped, textX: cursorX, textY: cursorY, fontSize: metrics.size };
      drawPdfTextWithLetterSpacing(page, run.text, {
        x: cursorX,
        y: cursorY,
        size: metrics.size,
        font: run.replacementFont,
        color: runColor,
        rotate: getTextRotation(mapped.rotation),
        ySkew: run.fontStyle === 'italic' ? degrees(12) : degrees(0)
      }, metrics.spacing, horizontalScale);
      if (run.fontSource?.source !== 'local') {
        drawFallbackTextOutlines(page, run.replacementOutlineFont, run.text, runMapped, runColor,
          metrics.spacing, horizontalScale, run.fontStyle === 'italic');
      }
      const decoration = run.textDecoration || replacement.textDecoration || 'none';
      if (decoration === 'underline' || decoration === 'line-through') {
        const distance = decoration === 'underline' ? metrics.size * 0.12 : -metrics.size * 0.32;
        const offset = getNextLineVector(mapped.rotation, distance);
        const decoratedAdvance = getTextAdvanceVector(mapped.rotation, metrics.width * horizontalScale);
        page.drawLine({
          start: { x: cursorX + offset.x, y: cursorY + offset.y },
          end: { x: cursorX + offset.x + decoratedAdvance.x, y: cursorY + offset.y + decoratedAdvance.y },
          thickness: Math.max(0.5, metrics.size * 0.055),
          color: runColor
        });
      }
      const advance = getTextAdvanceVector(mapped.rotation, metrics.width * horizontalScale);
      cursorX += advance.x;
      cursorY += advance.y;
    });
  });
  return { width: fittedWidth, horizontalScale };
}

function glyphPathToSvg(path, horizontalScale = 1, italic = false) {
  const number = (value) => Number(value.toFixed(3));
  return path.commands.map(({ command, args }) => {
    const x = (value, y) => number((value + (italic ? Math.tan(Math.PI / 15) * y : 0)) * horizontalScale);
    if (command === 'moveTo') return `M ${x(args[0], args[1])} ${number(-args[1])}`;
    if (command === 'lineTo') return `L ${x(args[0], args[1])} ${number(-args[1])}`;
    if (command === 'quadraticCurveTo') return `Q ${x(args[0], args[1])} ${number(-args[1])} ${x(args[2], args[3])} ${number(-args[3])}`;
    if (command === 'bezierCurveTo') return `C ${x(args[0], args[1])} ${number(-args[1])} ${x(args[2], args[3])} ${number(-args[3])} ${x(args[4], args[5])} ${number(-args[5])}`;
    return command === 'closePath' ? 'Z' : '';
  }).join(' ');
}

function drawFallbackTextOutlines(page, font, text, mapped, color, letterSpacing = 0, horizontalScale = 1, italic = false) {
  if (!font || !text) return;
  const scale = mapped.fontSize / font.unitsPerEm;
  if (!Number.isFinite(scale) || scale <= 0) return;
  const layout = font.layout(text);
  let cursorX = mapped.textX;
  let cursorY = mapped.textY;
  layout.glyphs.forEach((glyph, index) => {
    const position = layout.positions[index];
    const path = glyphPathToSvg(glyph.path, horizontalScale, italic);
    if (path) {
      page.drawSvgPath(path, {
        x: cursorX + position.xOffset * scale * horizontalScale,
        y: cursorY + position.yOffset * scale,
        scale,
        color,
        rotate: getTextRotation(mapped.rotation)
      });
    }
    cursorX += position.xAdvance * scale * horizontalScale;
    // The selectable text is drawn one character at a time when a user sets
    // letter spacing. The bold outline pass must advance by the same amount;
    // otherwise both passes begin at different positions and overlap.
    if (index < layout.glyphs.length - 1) cursorX += (Number(letterSpacing) || 0) * horizontalScale;
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
    .map(({ item, text }) => {
      const coverPadding = Number.isFinite(Number(item.coverPadding))
        ? Number(item.coverPadding)
        : Math.max(1, Number(item.fontSize) * 0.06);
      return {
      id: item.id,
      sourceSelection: item.sourceSelection,
      sourceText: item.type === 'addedText' ? ''
        : String(item.sourceSelection?.selectedText || item.sourceText || item.originalText || item.originalUnicodeText || text).trim(),
      originalText: item.type === 'addedText' ? ''
        : String(item.sourceSelection?.selectedText || item.originalText || item.sourceText || item.originalUnicodeText || text).trim(),
      // All UI movable objects originate in PDF.js Unicode selection text.
      // Keep direct source-font replay out of the deletion plan even for
      // objects created before the explicit flag was introduced.
      forceUnicodeFallback: true,
      sourceFont: item.sourceFont || null,
      // An explicit selection in the editor is an instruction, not merely a
      // preview preference.  Export only that candidate; adding the original
      // PDF font here allowed the IPC resolver to choose either exact match
      // and caused saved PDFs to revert to HCRDotum.
      fontCandidates: typeof item.selectedFontFamily === 'string' && item.selectedFontFamily.trim()
        ? [item.selectedFontFamily.trim()]
        // With no explicit selection, retain every original-font hint for
        // best-effort preservation of the PDF's source appearance.
        : [...new Set([
          ...(Array.isArray(item.fontCandidates) ? item.fontCandidates : []),
          ...(Array.isArray(item.sourceFont?.fontCandidates) ? item.sourceFont.fontCandidates : []),
          ...(Array.isArray(item.sourceSelection?.sourceFont?.fontCandidates)
            ? item.sourceSelection.sourceFont.fontCandidates : [])
        ].filter((candidate) => typeof candidate === 'string' && candidate.trim()))],
      fontRuns: Array.isArray(item.fontRuns) && item.fontRuns.length > 0
        ? item.fontRuns.map((run) => ({
          ...run,
          text: String(run.text || ''),
          fontSize: (Number(run.fontSize) || Number(item.autoFitBaseFontSize || item.fontSize))
            * (Number(item.fontSize) || 1) / Math.max(1, Number(item.autoFitBaseFontSize || item.fontSize) || 1),
          letterSpacing: Number.isFinite(Number(run.letterSpacing))
            ? Number(run.letterSpacing) : (Number(item.letterSpacing) || 0),
          fontCandidates: typeof item.selectedFontFamily === 'string' && item.selectedFontFamily.trim()
            ? [item.selectedFontFamily.trim()]
            : [...new Set((Array.isArray(run.fontCandidates) ? run.fontCandidates : [])
              .filter((candidate) => typeof candidate === 'string' && candidate.trim()))],
          preferBoldFont: typeof item.selectedFontFamily === 'string' && item.selectedFontFamily.trim()
            ? item.preferBoldFont === true
            : run.preferBoldFont === true || run.fontWeight === 'bold' || Number(run.fontWeight) >= 600
        }))
        : [],
      originalGlyphText: item.originalGlyphText || item.sourceFont?.glyphText || null,
      originalEncodedText: item.originalEncodedText || null,
      fontAnalysis: item.fontAnalysis || null,
      pageNumber: Number(item.pageNumber),
      sourcePageWidth: Number(item.sourcePageWidth),
      sourcePageHeight: Number(item.sourcePageHeight),
      coverX: Number(item.originalRect.x) - coverPadding,
      coverY: Number(item.originalRect.y) - coverPadding,
      coverWidth: Number(item.originalRect.width) + coverPadding * 2,
      coverHeight: Number(item.originalRect.height) + coverPadding * 2,
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
      preserveFontSize: item.manualFontSize === true,
      displayText: text,
      text,
      fontWeight: item.fontWeight || 'normal',
      fontStyle: item.fontStyle || 'normal',
      preferBoldFont: item.preferBoldFont === true,
      textDecoration: item.textDecoration || 'none',
      letterSpacing: Number(item.letterSpacing) || 0,
      fitToBoxByLetterSpacing: item.fitToBoxByLetterSpacing === true,
      textAlign: item.textAlign || 'left',
      textBoxWidth: Number(item.fitTextWidth || item.originalRect?.width || item.currentRect?.width || 0),
      sourceAdvanceWidth: item.manuallyResized ? null : Number(item.sourceAdvanceWidth) || null,
      backgroundColor: parseCssColor(item.backgroundColor, [255, 255, 255]),
      textColor: parseCssColor(item.color, [17, 17, 17]),
      type: item.type === 'addedText' ? 'added-text' : 'movable-text',
      canDirectEdit: false,
      fallbackReason: '저장 시 원본 content stream을 확인합니다.'
    };
    });
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
        letterSpacing: Number.parseFloat(textStyle.letterSpacing) || 0,
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

function dataUrlToBytes(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  if (!match) throw new Error('첨부 이미지 형식을 읽지 못했습니다.');
  return { format: match[1].toLowerCase(), bytes: base64ToBytes(match[2]) };
}

function fontSupportsText(fontBytes, text) {
  try {
    const font = fontkit.create(fontBytes);
    return Array.from(String(text || '')).every((character) => {
      // Whitespace and control characters do not need a drawable glyph.
      if (/\s/u.test(character)) return true;
      const codePoint = character.codePointAt(0);
      return Number.isFinite(codePoint) && font.hasGlyphForCodePoint(codePoint);
    });
  } catch {
    return false;
  }
}

async function loadReplacementFont(fontCandidates = [], options = {}) {
  const replacementText = String(options.text || '');
  if (!options.skipLocal) {
    const localFont = await window.docPilotFonts?.resolve?.({
      candidates: fontCandidates,
      preferBold: options.preferBold === true
    });
    if (localFont?.found && typeof localFont.base64 === 'string' && localFont.base64.trim()) {
      const localBytes = base64ToBytes(localFont.base64);
      // A matching family name alone is not enough. For example, a previously
      // selected Arial face can be embedded successfully but has no Korean
      // glyphs; pdf-lib then writes .notdef/NUL glyphs into the output PDF.
      if (fontSupportsText(localBytes, replacementText)) {
        return { bytes: localBytes, source: 'local', family: localFont.family || '' };
      }
    }
  }
  const injected = window.__DOC_PILOT_KOREAN_FONT_BASE64__;
  if (typeof injected === 'string' && injected.trim()) {
    const injectedBytes = base64ToBytes(injected);
    if (fontSupportsText(injectedBytes, replacementText)) {
      return { bytes: injectedBytes, source: 'injected', family: '' };
    }
  }

  const response = await fetch(FONT_URL);
  if (!response.ok) throw new Error('교체 텍스트용 글꼴을 불러오지 못했습니다.');
  const bundledBytes = base64ToBytes(await response.text());
  if (!fontSupportsText(bundledBytes, replacementText)) {
    // Do not generate a downloadable but visually corrupted PDF. A clear
    // error is safer than silently storing missing-glyph boxes or NUL text.
    throw new Error('변경할 텍스트를 표시할 수 있는 글꼴을 찾지 못했습니다. 다른 글꼴을 선택해주세요.');
  }
  return { bytes: bundledBytes, source: 'bundled', family: 'Noto Sans KR' };
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
    textBoxWidth: round(Number(replacement.textBoxWidth || replacement.coverWidth) * scaleX),
    textX: round(baseline.x),
    textY: round(baseline.y),
    fontSize: round(replacement.fontSize * scaleY)
  };
}

function applyTextAlignment(mapped, replacement, textWidth) {
  const align = replacement.textAlign || 'left';
  if (align !== 'center' && align !== 'right') return mapped;
  const pageBoxWidth = Number(replacement.textBoxWidth || replacement.coverWidth || 0)
    * (mapped.rectWidth / Math.max(Number(replacement.coverWidth) || 1, 1));
  const remaining = Math.max(0, pageBoxWidth - Math.max(0, textWidth || 0));
  const offset = align === 'center' ? remaining / 2 : remaining;
  if (!offset) return mapped;
  if (mapped.rotation === 0) mapped.textX += offset;
  else if (mapped.rotation === 180) mapped.textX -= offset;
  else if (mapped.rotation === 90) mapped.textY += offset;
  else if (mapped.rotation === 270) mapped.textY -= offset;
  return mapped;
}

function mapImageToPage(attachment, page) {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const rotation = normalizeRotation(page.getRotation()?.angle);
  const display = getDisplaySize(pageWidth, pageHeight, rotation);
  const rect = attachment.currentRect || {};
  const scaleX = display.width / Math.max(Number(attachment.sourcePageWidth) || 1, 1);
  const scaleY = display.height / Math.max(Number(attachment.sourcePageHeight) || 1, 1);
  const first = displayPointToPdf(rect.x * scaleX, rect.y * scaleY, pageWidth, pageHeight, rotation);
  const last = displayPointToPdf((rect.x + rect.width) * scaleX, (rect.y + rect.height) * scaleY, pageWidth, pageHeight, rotation);
  return { x: round(Math.min(first.x, last.x)), y: round(Math.min(first.y, last.y)), width: round(Math.abs(last.x - first.x)), height: round(Math.abs(last.y - first.y)) };
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

function matchesRenderedTextColor(red, green, blue, expected) {
  const [targetRed, targetGreen, targetBlue] = (expected || [0, 0, 0]).map(Number);
  const distance = Math.hypot(red - targetRed, green - targetGreen, blue - targetBlue);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  // Paper-like PDF backgrounds are usually bright and low-saturation. Count
  // only pixels that are plausibly part of the requested text colour.
  return distance < 145 && (max - min > 18 || min < 150);
}

async function findNonRenderingLocalReplacementIds(outputBytes, replacements) {
  const targets = replacements.filter((item) => item.fontSource?.source === 'local' && item.renderBounds);
  if (!targets.length || typeof document === 'undefined') return [];
  let loaded;
  try {
    const data = outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength);
    loaded = await loadPdfDocument(data);
    if (!loaded?.pdf) return [];
    const failedIds = [];
    for (const target of targets) {
      const page = await loaded.pdf.getPage(target.pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: context, viewport }).promise;
      const [baselineX, baselineY] = viewport.convertToViewportPoint(target.renderBounds.x, target.renderBounds.y);
      const fontPixels = Math.max(2, target.renderBounds.fontSize * viewport.scale);
      const left = Math.max(0, Math.floor(baselineX - 3));
      const top = Math.max(0, Math.floor(baselineY - fontPixels * 1.25));
      const width = Math.min(canvas.width - left, Math.ceil(target.renderBounds.width * viewport.scale + 8));
      const height = Math.min(canvas.height - top, Math.ceil(fontPixels * 1.55 + 8));
      if (width <= 0 || height <= 0) continue;
      const pixels = context.getImageData(left, top, width, height).data;
      let glyphPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] > 24 && matchesRenderedTextColor(
          pixels[offset], pixels[offset + 1], pixels[offset + 2], target.textColor
        )) glyphPixels += 1;
      }
      // A genuine rendered string contains substantially more than a few
      // anti-aliased edge pixels. This catches the selectable-but-invisible
      // glyph issue while avoiding normal short-text false positives.
      if (glyphPixels < Math.max(8, Array.from(String(target.text || '')).length * 2)) {
        failedIds.push(target.id);
      }
    }
    return failedIds;
  } catch (error) {
    console.warn('Saved PDF local-font render validation was skipped.', error);
    return [];
  } finally {
    await loaded?.loadingTask?.destroy?.();
  }
}

function sourceTextRect(item, viewport) {
  const [x, baselineY] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
  const fontSize = Math.max(1, Math.hypot(item.transform[2], item.transform[3]) * viewport.scale);
  return {
    x,
    baselineY,
    top: baselineY - fontSize * 1.08,
    width: Math.max(1, Number(item.width) * viewport.scale),
    height: Math.max(2, fontSize * 1.3),
    fontSize
  };
}

function hasVisibleSourceGlyphs(context, rect, textColor, text) {
  const canvas = context.canvas;
  const left = Math.max(0, Math.floor(rect.x - 2));
  const top = Math.max(0, Math.floor(rect.top - 2));
  const width = Math.min(canvas.width - left, Math.ceil(rect.width + 5));
  const height = Math.min(canvas.height - top, Math.ceil(rect.height + 5));
  if (width <= 0 || height <= 0) return true;
  const pixels = context.getImageData(left, top, width, height).data;
  let glyphPixels = 0;
  const expected = textColor || [17, 17, 17];
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] > 24 && matchesRenderedTextColor(
      pixels[offset], pixels[offset + 1], pixels[offset + 2], expected
    )) glyphPixels += 1;
  }
  return glyphPixels >= Math.max(8, Array.from(String(text || '')).length * 2);
}

// Some converted PDFs retain a Unicode mapping but embed a malformed font.
// The text can therefore be selected and copied while every glyph is blank.
// Before saving, detect those original source runs too and rewrite only the
// invisible runs with a resolvable local face (or Noto Sans KR fallback).
async function collectInvisibleSourceTextRepairs(sourceBytes, existingReplacements) {
  if (typeof document === 'undefined') return [];
  let loaded;
  try {
    // PDF.js transfers its input to the worker. Always pass a disposable
    // copy here: this repair scan runs before pdf-lib reads the same source
    // bytes to create the downloaded file.
    const data = sourceBytes instanceof ArrayBuffer ? sourceBytes.slice(0)
      : sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
    loaded = await loadPdfDocument(data);
    if (!loaded?.pdf) return [];
    const alreadyEdited = new Set(existingReplacements.map((item) => (
      `${Number(item.pageNumber)}\u0000${String(item.sourceText || item.originalText || '').replace(/\s+/g, '')}`
    )));
    const repairs = [];
    for (let pageNumber = 1; pageNumber <= loaded.pdf.numPages; pageNumber += 1) {
      const page = await loaded.pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const textContent = await page.getTextContent();
      const fontPreviews = await describePdfTextFonts(page, textContent);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: context, viewport }).promise;
      const textItems = textContent.items.filter((item) => typeof item.str === 'string');
      for (let index = 0; index < textItems.length; index += 1) {
        const item = textItems[index];
        const text = String(item.str || '').trim();
        const preview = fontPreviews[index];
        const key = `${pageNumber}\u0000${text.replace(/\s+/g, '')}`;
        if (!text || text.length < 2 || alreadyEdited.has(key) || !preview || textContent.styles[item.fontName]?.vertical) continue;
        const rect = sourceTextRect(item, viewport);
        const textColor = parseCssColor(preview.textColor, [17, 17, 17]);
        if (hasVisibleSourceGlyphs(context, rect, textColor, text)) continue;
        // Keep the original PDF coordinates as the source viewport. The
        // direct text editor can then remove the faulty source object rather
        // than painting a cover over it.
        const sourceViewport = page.getViewport({ scale: 1 });
        const sourceRect = sourceTextRect(item, sourceViewport);
        repairs.push({
          id: `invisible-source-font-${pageNumber}-${index}`,
          type: 'pdf',
          pageNumber,
          sourcePageWidth: sourceViewport.width,
          sourcePageHeight: sourceViewport.height,
          sourceText: text,
          originalText: text,
          sourceFullText: text,
          replacementText: text,
          newText: text,
          text,
          forceUnicodeFallback: true,
          fontCandidates: preview.fontCandidates || [],
          preferBoldFont: preview.preferBoldFont === true,
          fontWeight: preview.fontWeight || 'normal',
          fontStyle: preview.fontStyle || 'normal',
          textColor,
          backgroundColor: [255, 255, 255],
          coverX: sourceRect.x,
          coverY: sourceRect.top,
          coverWidth: sourceRect.width,
          coverHeight: sourceRect.height,
          textX: sourceRect.x,
          textY: sourceRect.top,
          baseline: sourceRect.baselineY,
          fontSize: sourceRect.fontSize
        });
      }
    }
    return repairs;
  } catch (error) {
    console.warn('Source text render repair detection was skipped.', error);
    return [];
  } finally {
    await loaded?.loadingTask?.destroy?.();
  }
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

export async function convertPdfWithOriginalOverlay({ file, replacement = {}, movableTexts = [], highlights = [], images = [], tables, tablesChanged = false, download = true }) {
  const { isPdfFile } = await import('../utils/fileUtils.js');
  if (!file || !isPdfFile(file)) throw new Error('먼저 PDF 파일을 선택해주세요.');

  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  let replacements = [
    ...collectAppliedReplacements(replacement),
    ...collectMovableTextReplacements(movableTexts)
  ];
  if (!replacements.length) replacements = collectReplacementPlanFallback(replacement);
  if (!replacements.length && !highlights.length && !images.length && !tables?.length && !tablesChanged) throw new Error('먼저 텍스트, 이미지, 표 또는 하이라이트를 화면에 적용해주세요.');

  const sourceBytes = await file.arrayBuffer();
  const { outputBytes, ...report } = await buildPdfWithTextEdits({ sourceBytes, replacements, highlights, images, tables });
  const outputFileName = makeOverlayConvertedFileName(file.name);
  if (download) downloadPdf(outputBytes, outputFileName);
  return { ...report, outputFileName, fileName: outputFileName, outputBytes: download ? undefined : outputBytes };
}

// Keep byte generation separate from browser download so saved content can be
// reopened and verified independently of the editor DOM.
export async function buildPdfWithTextEdits({
  sourceBytes, fontBytes, replacements: input = [], highlights: inputHighlights = [], images: inputImages = [], tables: inputTables,
  forceBundledFontIds = [], skipRenderValidation = false
}) {
  const sourceFontRepairs = await collectInvisibleSourceTextRepairs(sourceBytes, input);
  const replacements = [...input, ...sourceFontRepairs].map((item) => ({ ...item, canDirectEdit: false }));
  const forcedBundledFontIds = new Set(forceBundledFontIds);
  const highlights = inputHighlights.filter((item) => (
    Number.isFinite(Number(item?.pageNumber)) && Number(item.pageNumber) > 0
    && Number.isFinite(Number(item?.sourcePageWidth)) && Number(item.sourcePageWidth) > 0
    && Number.isFinite(Number(item?.sourcePageHeight)) && Number(item.sourcePageHeight) > 0
    && Number.isFinite(Number(item?.left)) && Number.isFinite(Number(item?.top))
    && Number.isFinite(Number(item?.width)) && Number(item.width) > 0
    && Number.isFinite(Number(item?.height)) && Number(item.height) > 0
  ));
  const images = inputImages.filter((item) => (
    Number.isInteger(Number(item?.pageNumber)) && Number(item.pageNumber) > 0
    && Number.isFinite(Number(item?.sourcePageWidth)) && Number(item.sourcePageWidth) > 0
    && Number.isFinite(Number(item?.sourcePageHeight)) && Number(item.sourcePageHeight) > 0
    && Number.isFinite(Number(item?.currentRect?.x)) && Number.isFinite(Number(item?.currentRect?.y))
    && Number(item?.currentRect?.width) > 0 && Number(item?.currentRect?.height) > 0
    && /^data:image\/(png|jpe?g);base64,/i.test(String(item?.dataUrl || ''))
  ));
  // Keep PDF.js/font-repair probes and pdf-lib isolated. Some PDF.js worker
  // configurations detach the ArrayBuffer they receive, which previously
  // caused saving a highlight-only document to fail with a detached buffer.
  const pdfSourceBytes = sourceBytes instanceof ArrayBuffer
    ? sourceBytes.slice(0)
    : sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
  const pdfDocument = await PDFDocument.load(pdfSourceBytes);
  const pages = pdfDocument.getPages();
  if (replacements.some((item) => !Number.isInteger(item.pageNumber) || !pages[item.pageNumber - 1])) {
    throw new Error('편집 대상 PDF 페이지를 찾을 수 없습니다.');
  }
  let replacementFont;
  let replacementOutlineFont;
  let fontSource = { source: 'none', family: '' };
  const replacementFontAssets = new Map();
  // Each replacement can originate from a different font. Sharing the first
  // resolved font across the whole document makes a later Korean replacement
  // disappear when an earlier English edit selected Arial, for example.
  // Cache only identical candidate sets, then bind the resulting embedded
  // font to the individual replacement.
  if (replacements.some((item) => item.type === 'pdf' || !item.fontPreserved)) {
    pdfDocument.registerFontkit({
      create: (bytes) => {
        const font = fontkit.create(bytes);
        return font.variationAxes?.wght ? font.getVariation({ wght: 400 }) : font;
      }
    });
    const assignFontAsset = async (target, candidates, preferBold, text) => {
      // Font coverage differs by replacement text. Do not reuse an earlier
      // ASCII-only local font asset for a later Korean replacement that has
      // the same selected family name.
      const coverageKey = [...new Set(Array.from(String(text || '')).map((character) => character.codePointAt(0)))].sort((a, b) => a - b).join(',');
      const useBundledFallback = forcedBundledFontIds.has(target.id);
      const cacheKey = fontBytes
        ? '__provided-font__'
        : `${useBundledFallback ? 'forced-bundled' : (preferBold ? 'bold' : 'normal')}\u0000${candidates.join('\u0000') || '__bundled-font__'}\u0000${coverageKey}`;
      let asset = replacementFontAssets.get(cacheKey);
      if (!asset) {
        if (fontBytes && !fontSupportsText(fontBytes, text)) {
          throw new Error('지정된 교체 글꼴이 변경할 텍스트를 지원하지 않습니다. 다른 글꼴을 선택해주세요.');
        }
        const source = fontBytes
          ? { bytes: fontBytes, source: 'provided', family: '' }
          : await loadReplacementFont(candidates, {
            preferBold,
            text,
            skipLocal: useBundledFallback
          });
        const embeddedFont = await pdfDocument.embedFont(source.bytes, { subset: true });
        const outlineSource = fontkit.create(source.bytes);
        asset = {
          font: embeddedFont,
          outlineFont: outlineSource.variationAxes?.wght
            ? outlineSource.getVariation({ wght: 400 }) : outlineSource,
          source
        };
        replacementFontAssets.set(cacheKey, asset);
      }
      target.replacementFont = asset.font;
      target.replacementOutlineFont = asset.outlineFont;
      target.fontSource = asset.source;
    };
    for (const item of replacements.filter((entry) => entry.type === 'pdf' || !entry.fontPreserved)) {
      if (item.type !== 'pdf' && item.fontRuns?.length > 0) {
        for (const run of item.fontRuns) {
          const candidates = [...new Set((run.fontCandidates || []).filter((candidate) => typeof candidate === 'string' && candidate.trim()))];
          await assignFontAsset(run, candidates, run.preferBoldFont === true, run.text);
        }
        item.replacementFont = item.fontRuns[0].replacementFont;
        item.replacementOutlineFont = item.fontRuns[0].replacementOutlineFont;
        item.fontSource = item.fontRuns[0].fontSource;
      } else {
        const candidates = [...new Set((item.fontCandidates || []).filter((candidate) => typeof candidate === 'string' && candidate.trim()))];
        await assignFontAsset(item, candidates, item.preferBoldFont === true, item.text);
      }
    }
    const firstAsset = replacementFontAssets.values().next().value;
    replacementFont = firstAsset?.font;
    replacementOutlineFont = firstAsset?.outlineFont;
    fontSource = firstAsset?.source || fontSource;
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
    replacement.contentOrderAnchor = outcome.contentOrderAnchor || null;
    replacement.contentOrderCtm = outcome.contentOrderCtm || null;
    if (replacement.contentOrderAnchor && replacement.drawingCommands) replacement.anchoredDrawingCommands = replacement.drawingCommands;
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
  const reusableMoves = replacements.filter((item) => item.type !== 'added-text' && !unicodeMoves.includes(item));
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
    replacement.contentOrderAnchor = outcome.contentOrderAnchor || null;
    replacement.contentOrderCtm = outcome.contentOrderCtm || null;
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
  for (const attachment of images) {
    const page = pages[Number(attachment.pageNumber) - 1];
    if (!page) continue;
    const { format, bytes } = dataUrlToBytes(attachment.dataUrl);
    const image = format === 'png' ? await pdfDocument.embedPng(bytes) : await pdfDocument.embedJpg(bytes);
    page.drawImage(image, mapImageToPage(attachment, page));
  }
  replacements.forEach((replacement) => {
    const page = pages[replacement.pageNumber - 1];
    if (!page) return;
    const mapped = mapReplacementToPage(replacement, page);

    // Experimental no-cover mode for text movement: even when source
    // command matching fails, do not paint a background rectangle. The new
    // text is still inserted below; the report exposes unresolved items so
    // callers can detect that the original may remain in the PDF.
    if (!replacement.canDirectEdit && replacement.type !== 'movable-text' && replacement.type !== 'added-text'
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
    const itemReplacementFont = replacement.replacementFont || replacementFont;
    const itemReplacementOutlineFont = replacement.replacementOutlineFont || replacementOutlineFont;
    const itemFontSource = replacement.fontSource || fontSource;
    if (!itemReplacementFont) return;
    if (replacement.fontRuns?.length > 0) {
      if (replacement.contentOrderAnchor) resetPageDrawingStream(page);
      drawPdfFontRuns(page, replacement, mapped);
      if (replacement.contentOrderAnchor) replacement.anchoredDrawingCommands = capturePageDrawingStream(page);
      return;
    }
    const pdfLetterSpacing = Number(replacement.letterSpacing) && Number(replacement.fontSize)
      ? Number(replacement.letterSpacing) * mapped.fontSize / Number(replacement.fontSize)
      : 0;
    const baseMeasuredWidth = measurePdfText(itemReplacementFont, replacement.text, mapped.fontSize);
    const measuredWidth = baseMeasuredWidth == null ? null
      : baseMeasuredWidth + pdfLetterSpacing * Math.max(0, Array.from(String(replacement.text || '')).length - 1);
    // Canvas metrics used by the editor can differ from the embedded PDF font
    // metrics. Fit the final PDF glyph advances to the selected source box at
    // export time, preserving vertical size and baseline.
    const sourceAdvance = Number(replacement.sourceAdvanceWidth) * page.getWidth()
      / Math.max(1, Number(replacement.sourcePageWidth));
    const sourceScale = sourceAdvance > 0 && measuredWidth > 0 ? sourceAdvance / measuredWidth : 0;
    const horizontalScale = sourceScale >= 0.8 && sourceScale <= 1.25
      ? sourceScale
      : !replacement.preserveFontSize && measuredWidth > mapped.textBoxWidth && mapped.textBoxWidth > 0
        ? mapped.textBoxWidth / measuredWidth : 1;
    const fittedWidth = measuredWidth == null ? null : measuredWidth * horizontalScale;
    applyTextAlignment(mapped, replacement, fittedWidth);
    const textColor = toPdfColor(replacement.textColor);
    replacement.renderBounds = {
      x: mapped.textX,
      y: mapped.textY,
      width: Math.max(fittedWidth || 0, mapped.fontSize * Math.max(1, Array.from(String(replacement.text || '')).length) * 0.25 * horizontalScale),
      fontSize: mapped.fontSize
    };
    const isItalic = replacement.fontStyle === 'italic';
    if (replacement.contentOrderAnchor) resetPageDrawingStream(page);
    drawPdfTextWithLetterSpacing(page, replacement.text, {
      x: mapped.textX,
      y: mapped.textY,
      size: mapped.fontSize,
      font: itemReplacementFont,
      color: textColor,
      rotate: getTextRotation(mapped.rotation),
      // In PDF coordinates xSkew changes the baseline's Y progression,
      // which makes successive glyphs climb or fall over one another.
      // Italic needs a Y-axis skew so only the glyph outline leans right.
      ySkew: isItalic ? degrees(12) : degrees(0)
    }, pdfLetterSpacing, horizontalScale);
    if (itemFontSource.source !== 'local') {
      drawFallbackTextOutlines(page, itemReplacementOutlineFont, replacement.text, mapped, textColor,
        pdfLetterSpacing, horizontalScale, isItalic);
    }
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
    if (replacement.contentOrderAnchor) replacement.anchoredDrawingCommands = capturePageDrawingStream(page);
  });

  // Replay the original font and encoded glyphs after all fallback covers.
  // Normalization isolates the original page graphics state with q/Q.
  replacements.filter((item) => item.fontPreserved && item.drawingCommands && !item.contentOrderAnchor).forEach((item) => {
    const page = pages[item.pageNumber - 1];
    page.node.normalize();
    const stream = pdfDocument.context.flateStream(Uint8Array.from(item.drawingCommands, (char) => char.charCodeAt(0)));
    page.node.addContentStream(pdfDocument.context.register(stream));
  });

  insertDrawingCommandsAtContentAnchors(pdfDocument, replacements);

  const tableCount = inputTables ? await writePdfTables(pdfDocument, inputTables) : 0;
  const outputBytes = await pdfDocument.save({ useObjectStreams: true });
  const localFontRenderFallbackIds = skipRenderValidation
    ? [] : await findNonRenderingLocalReplacementIds(outputBytes, replacements);
  if (localFontRenderFallbackIds.length) {
    const retry = await buildPdfWithTextEdits({
      sourceBytes,
      fontBytes,
      replacements: input,
      highlights: inputHighlights,
      images: inputImages,
      tables: inputTables,
      forceBundledFontIds: [...new Set([...forcedBundledFontIds, ...localFontRenderFallbackIds])],
      skipRenderValidation: true
    });
    return {
      ...retry,
      localFontRenderFallbackCount: localFontRenderFallbackIds.length,
      localFontRenderFallbackIds
    };
  }
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
    imageCount: images.length,
    tableCount,
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
    // `fontPreservedCount` below means the original embedded PDF resource was
    // replayed byte-for-byte. A selected Unicode replacement normally cannot
    // use that subset safely, even when the equivalent Windows font was found
    // and embedded. Report that successful local-font path separately.
    replacementFontSource: fontSource.source,
    replacementFontFamily: fontSource.family || '',
    localFontAppliedCount: replacements.filter((item) => (
      item.fontPreserved !== true && item.fontSource?.source === 'local'
    )).length,
    localFontRenderFallbackCount: 0,
    localFontRenderFallbackIds: [],
    invisibleSourceFontRepairCount: sourceFontRepairs.length,
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
