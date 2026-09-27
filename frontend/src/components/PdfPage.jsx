import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import HighlightLayer from './HighlightLayer';
import PdfTextLayer from './PdfTextLayer';
import { ensureReplacementFont, resolveReplacementPreviewFont } from '../services/pdfReplacementFont';
import { describePdfTextFonts } from '../services/pdfFontPreview';
import {
  calculateHighlightBoxes,
  calculateFindBoxesFromPdfText,
  createHighlightBoxesFromTextLayer,
  createReplacementPreviewFromTextLayer
} from '../services/highlightService';

function quantizeChannel(value) {
  return Math.min(255, Math.max(0, Math.round(value / 16) * 16));
}

function sampleReplacementBackground(canvas, pageSize, cover) {
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!context || !pageSize.width || !pageSize.height) {
    return '#ffffff';
  }

  const scaleX = canvas.width / pageSize.width;
  const scaleY = canvas.height / pageSize.height;
  const left = Math.max(0, Math.floor(cover.x * scaleX));
  const top = Math.max(0, Math.floor(cover.y * scaleY));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(cover.width * scaleX)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(cover.height * scaleY)));

  if (left >= canvas.width || top >= canvas.height || width <= 0 || height <= 0) {
    return '#ffffff';
  }

  try {
    const colors = new Map();
    const collectRegion = (regionLeft, regionTop, regionWidth, regionHeight) => {
      const sampleLeft = Math.max(0, Math.min(canvas.width - 1, Math.floor(regionLeft)));
      const sampleTop = Math.max(0, Math.min(canvas.height - 1, Math.floor(regionTop)));
      const sampleWidth = Math.max(1, Math.min(canvas.width - sampleLeft, Math.ceil(regionWidth)));
      const sampleHeight = Math.max(1, Math.min(canvas.height - sampleTop, Math.ceil(regionHeight)));
      const { data } = context.getImageData(sampleLeft, sampleTop, sampleWidth, sampleHeight);

      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] === 0) continue;
        const color = [
          quantizeChannel(data[index]),
          quantizeChannel(data[index + 1]),
          quantizeChannel(data[index + 2])
        ];
        const key = color.join(',');
        colors.set(key, (colors.get(key) || 0) + 1);
      }
    };

    // Sample just outside the selected glyphs first. This avoids treating the
    // dark text pixels as the replacement background and keeps table lines
    // from being copied across the whole cover whenever possible.
    const margin = Math.max(2, Math.round(Math.min(width, height) * 0.35));
    const stripWidth = Math.max(1, Math.round(Math.min(width, margin)));
    const stripHeight = Math.max(1, Math.round(Math.min(height, margin)));
    collectRegion(left, top - stripHeight, width, stripHeight);
    collectRegion(left, top + height, width, stripHeight);
    collectRegion(left - stripWidth, top, stripWidth, height);
    collectRegion(left + width, top, stripWidth, height);

    // At page edges there may be no outside pixels. Fall back to the selected
    // region rather than failing to create a cover color.
    if (!colors.size) collectRegion(left, top, width, height);

    const dominant = Array.from(colors.entries()).sort((first, second) => second[1] - first[1])[0];
    if (!dominant) return '#ffffff';
    return `rgb(${dominant[0]})`;
  } catch (error) {
    console.warn('[PdfPage] replacement background sampling failed:', error);
    return '#ffffff';
  }
}

function sampleReplacementTextColor(canvas, pageSize, cover) {
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!context || !pageSize.width || !pageSize.height) return null;
  const scaleX = canvas.width / pageSize.width;
  const scaleY = canvas.height / pageSize.height;
  const left = Math.max(0, Math.floor(cover.x * scaleX));
  const top = Math.max(0, Math.floor(cover.y * scaleY));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(cover.width * scaleX)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(cover.height * scaleY)));
  if (left >= canvas.width || top >= canvas.height || width <= 0 || height <= 0) return null;
  try {
    const colors = new Map();
    const { data } = context.getImageData(left, top, width, height);
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] === 0) continue;
      const channels = [data[index], data[index + 1], data[index + 2]];
      const brightness = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      const saturation = Math.max(...channels) - Math.min(...channels);
      if (brightness > 210 && saturation < 28) continue;
      const color = channels.map((channel) => Math.round(channel / 8) * 8);
      const key = color.join(',');
      colors.set(key, (colors.get(key) || 0) + 1);
    }
    const dominant = Array.from(colors.entries()).sort((a, b) => b[1] - a[1])[0];
    return dominant ? `rgb(${dominant[0]})` : null;
  } catch {
    return null;
  }
}

function isUsableDisplayText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const characters = [...text];
  const bad = characters.filter((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f || code === 0xfffd || character === '□';
  }).length;
  return bad / Math.max(characters.length, 1) < 0.35;
}

function measureDisplayText(text, fontSize, computedStyle) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return { width: 0, height: 0 };
  const fontStyle = computedStyle?.fontStyle || 'normal';
  const fontWeight = computedStyle?.fontWeight || 'normal';
  const fontFamily = computedStyle?.fontFamily || 'Helvetica, Arial, sans-serif';
  context.font = `${fontStyle} ${fontWeight} ${Math.max(1, fontSize)}px ${fontFamily}`;
  const metrics = context.measureText(text);
  const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft : 0;
  const right = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : fontSize * 0.8;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : fontSize * 0.2;
  return { width: Math.max(metrics.width || 0, left + right), height: Math.max(fontSize, ascent + descent) };
}

function getSelectedTextLayerSpans(textLayer, range) {
  return Array.from(textLayer.querySelectorAll('span[data-text-item-index]'))
    .filter((span) => {
      try {
        return range.intersectsNode(span);
      } catch {
        return false;
      }
    })
    .sort((a, b) => Number(a.dataset.textItemIndex) - Number(b.dataset.textItemIndex));
}

// A partial selection (for example selecting "문서 검색" from a single
// "문서 검색 및 편집 지원 프로그램" PDF item) still belongs to that item's
// font. Keep the preview descriptor available even when the DOM source data
// was produced before its font analysis completed.
function getSelectionSourceFont(sourceInfo, textContent, selectedText) {
  const index = Number(sourceInfo?.textItemIndex);
  const indexedFont = Number.isInteger(index) ? textContent?.fontPreviews?.[index] : null;
  if (sourceInfo?.sourceFont?.fontCandidates?.length) return sourceInfo.sourceFont;
  if (indexedFont?.fontCandidates?.length) return indexedFont;

  const textItems = textContent?.items || [];
  const matchedIndex = textItems.findIndex((item) => (
    typeof item?.str === 'string' && item.str.includes(selectedText)
  ));
  return matchedIndex >= 0 ? textContent?.fontPreviews?.[matchedIndex] || null : null;
}

function mergeSelectionClientRects(rects = []) {
  const lines = [];
  [...rects]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((first, second) => first.top - second.top || first.left - second.left)
    .forEach((rect) => {
      const centerY = (rect.top + rect.bottom) / 2;
      const line = lines.find((entry) => Math.abs(entry.centerY - centerY) <= Math.max(2, Math.min(entry.height, rect.height) * 0.45));
      if (!line) {
        lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, centerY, height: rect.height });
        return;
      }
      line.left = Math.min(line.left, rect.left);
      line.top = Math.min(line.top, rect.top);
      line.right = Math.max(line.right, rect.right);
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.centerY = (line.top + line.bottom) / 2;
      line.height = line.bottom - line.top;
    });
  return lines.map(({ left, top, right, bottom }) => ({ left, top, right, bottom, width: right - left, height: bottom - top }));
}

function getTextSpanSelectionClientRects(range, textLayer) {
  if (!range || !textLayer) return [];
  // PDF.js inserts <br> nodes for each hasEOL item. A browser Range includes
  // them in getClientRects() even though they contain no glyphs. On a
  // multi-column page those fragments become the blue bar at the left edge.
  // Collect only actual PDF text spans and preserve partial selection inside
  // the start/end span.
  return getSelectedTextLayerSpans(textLayer, range).flatMap((span) => {
    const clipped = document.createRange();
    try {
      clipped.selectNodeContents(span);
      if (span.contains(range.startContainer)) {
        clipped.setStart(range.startContainer, range.startOffset);
      }
      if (span.contains(range.endContainer)) {
        clipped.setEnd(range.endContainer, range.endOffset);
      }
      return Array.from(clipped.getClientRects());
    } catch {
      return [];
    }
  });
}

function getSelectionGeometryFromClientRects(rects, pageElement, scale) {
  const clientRects = mergeSelectionClientRects(rects);
  if (!clientRects.length || !pageElement) return null;
  const pageRect = pageElement.getBoundingClientRect();
  const coverRects = clientRects.map((rect) => ({
    x: (rect.left - pageRect.left) / scale,
    y: (rect.top - pageRect.top) / scale,
    width: rect.width / scale,
    height: rect.height / scale
  }));
  const selectionRect = coverRects.reduce((current, rect) => ({
    x: Math.min(current.x, rect.x),
    y: Math.min(current.y, rect.y),
    right: Math.max(current.right, rect.x + rect.width),
    bottom: Math.max(current.bottom, rect.y + rect.height)
  }), {
    x: coverRects[0].x,
    y: coverRects[0].y,
    right: coverRects[0].x + coverRects[0].width,
    bottom: coverRects[0].y + coverRects[0].height
  });
  return {
    coverRects,
    currentRect: {
      x: selectionRect.x,
      y: selectionRect.y,
      width: selectionRect.right - selectionRect.x,
      height: selectionRect.bottom - selectionRect.y
    },
    previewBoxes: clientRects.map((rect) => ({
      x: rect.left - pageRect.left,
      y: rect.top - pageRect.top,
      width: rect.width,
      height: rect.height
    }))
  };
}

function getSelectionGeometry(range, pageElement, scale, textLayer) {
  return getSelectionGeometryFromClientRects(
    getTextSpanSelectionClientRects(range, textLayer), pageElement, scale
  );
}

function getAreaTextLineGroups(textLayer, area, pageElement, scale) {
  if (!textLayer || !area || !pageElement) return [];
  const lines = [];
  Array.from(textLayer.querySelectorAll('span[data-text-item-index]')).forEach((span) => {
    const rect = span.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    if (centerX < area.left || centerX > area.right || centerY < area.top || centerY > area.bottom) return;
    const text = span.dataset.unicodeText ?? span.textContent ?? '';
    if (text === '') return;
    const line = lines.find((entry) => Math.abs(entry.centerY - centerY) <= Math.max(2, Math.min(entry.height, rect.height) * 0.45));
    const part = { span, rect, text };
    if (line) {
      line.parts.push(part);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.centerY = (line.top + line.bottom) / 2;
      line.height = line.bottom - line.top;
    } else {
      lines.push({ centerY, top: rect.top, bottom: rect.bottom, height: rect.height, parts: [part] });
    }
  });
  return lines.sort((first, second) => first.top - second.top).map((line) => {
    const parts = line.parts.sort((first, second) => first.rect.left - second.rect.left);
    const geometry = getSelectionGeometryFromClientRects(parts.map((part) => part.rect), pageElement, scale);
    const text = parts.map((part) => part.text).join('').trim();
    return geometry && text ? { text, geometry, sourceElement: parts[0].span } : null;
  }).filter(Boolean);
}

function collectFontCandidates(...fonts) {
  return [...new Set(fonts.flatMap((font) => (
    Array.isArray(font?.fontCandidates) ? font.fontCandidates : []
  )).filter((candidate) => typeof candidate === 'string' && candidate.trim()))];
}

function replacementHighlightBox(target, scale, movableTexts = []) {
  const linkedItem = target?.replacementId
    ? movableTexts.find((item) => item.id === target.replacementId)
    : null;
  const rect = linkedItem?.currentRect
    || target?.replacementRect
    || target?.currentRect
    || target?.displayRect
    || target?.originalRect;
  if (!rect) return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  // The replacement layer has its own white cover. Expand the highlight a
  // little around the replacement glyph and render it above that layer so the
  // whole changed word remains visibly highlighted.
  const padding = Math.max(2 / scale, Number(linkedItem?.fontSize || target?.fontSize || 0) * 0.08);
  return {
    x: Math.max(0, (x - padding) * scale),
    y: Math.max(0, (y - padding) * scale),
    width: (width + padding * 2) * scale,
    height: (height + padding * 2) * scale
  };
}

function PdfPage({
  pdf,
  pageNumber,
  scale,
  highlightKeyword,
  highlightOptions = {},
  highlightEntries = [],
  findResult,
  replacePreview,
  batchReplaceRequest,
  onBatchReplaceHandled,
  textMoveMode = false,
  textReplaceMode = false,
  areaTextReplaceMode = false,
  editingEnabled = false,
  movableTexts = [],
  imageAttachments = [],
  selectedMovableTextId = null,
  editingMovableText = null,
  onCreateMovableText,
  onCreateMovableTexts,
  onUpdateMovableTextPreviewFont,
  onMoveMovableText,
  onMoveMovableTextEnd,
  onSelectMovableText,
  onBeginEditMovableText,
  onChangeEditMovableText,
  onChangeEditMovableTextStyle,
  onCommitEditMovableText,
  onCancelEditMovableText,
  onDeleteMovableText,
  selectedImageId = null,
  onSelectImage,
  onMoveImage,
  onMoveImageEnd,
  onDeleteImage,
  onPageReady
}) {
  const canvasRef = useRef(null);
  const pageRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [renderError, setRenderError] = useState('');
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [highlightBoxes, setHighlightBoxes] = useState([]);
  const [findBoxes, setFindBoxes] = useState([]);
  const [fallbackBoxes, setFallbackBoxes] = useState([]);
  const [selectionBoxes, setSelectionBoxes] = useState([]);
  const [replacementPreviewItems, setReplacementPreviewItems] = useState([]);
  const [viewport, setViewport] = useState(null);
  const [textContent, setTextContent] = useState(null);
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  const [areaSelectionBox, setAreaSelectionBox] = useState(null);
  const moveRef = useRef(null);
  const areaSelectionRef = useRef(null);
  const imageMoveRef = useRef(null);
  const handledBatchRequestRef = useRef('');
  const batchSelectionActiveRef = useRef(false);
  const handleTextLayerRendered = useCallback(() => {
    setTextLayerVersion((version) => version + 1);
  }, []);

  const handleTextSelection = useCallback(() => {
    const isBatchSelection = batchSelectionActiveRef.current;
    if ((!textMoveMode && !textReplaceMode && !isBatchSelection) || !pageRef.current) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const textLayer = pageRef.current.querySelector('.textLayer');
    const commonNode = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    if (!textLayer?.contains(commonNode)) return;
    const selectedSpans = getSelectedTextLayerSpans(textLayer, range);
    const selectionText = selection.toString().trim();
    const spanText = selectedSpans.map((span) => span.dataset.unicodeText || span.textContent || '').join('').trim();
    const wholeSpanRange = selectedSpans.length === 1 ? document.createRange() : null;
    if (wholeSpanRange) wholeSpanRange.selectNodeContents(selectedSpans[0]);
    const wholeSpan = selectedSpans.length === 1
      && wholeSpanRange.toString().trim() === selectionText;
    // PDF.js item.str is the authoritative Unicode value for a complete item.
    // For partial/multi-item selections, retain the browser's selected range.
    const selectedText = (wholeSpan ? spanText : selectionText) || spanText;
    const displayText = String(isBatchSelection ? batchReplaceRequest?.newText : selectedText);
    const batchTarget = isBatchSelection
      ? (batchReplaceRequest?.targets || []).find((target) => Number(target?.pageNumber ?? target?.page) === pageNumber) || null
      : null;
    // Do not block a user-selected range because PDF.js exposed unusual
    // Unicode. The export layer will choose direct removal or overlay
    // fallback based on whether the source can be safely identified.
    if (!String(selectedText || '').length) return;

    const geometry = getSelectionGeometry(range, pageRef.current, scale, textLayer);
    // Selection is always accepted in text-move mode. Multi-line and partial
    // selections may not be removable directly from the PDF stream later,
    // but they must still become movable items and can safely use overlay
    // fallback during save.
    if (!geometry) {
      return;
    }
    const { currentRect, coverRects } = geometry;
    if (currentRect.width < 2 || currentRect.height < 2) return;

    const startElement = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement : range.startContainer;
    const sourceElement = startElement?.closest('.textLayer span') || startElement;
    const computedStyle = sourceElement ? window.getComputedStyle(sourceElement) : null;
    // Only a complete PDF.js text item provides evidence for the first direct
    // removal implementation. Partial/multi-span selections still use overlay.
    let sourceSelection = null;
    const sourceInfo = sourceElement?.dataset.pdfSource ? JSON.parse(sourceElement.dataset.pdfSource) : null;
    if (sourceElement?.dataset.pdfSource && sourceElement.contains(range.endContainer)) {
      const before = range.cloneRange();
      before.selectNodeContents(sourceElement);
      before.setEnd(range.startContainer, range.startOffset);
      const after = range.cloneRange();
      after.selectNodeContents(sourceElement);
      after.setStart(range.endContainer, range.endOffset);
      if (!before.toString() && !after.toString()) {
        sourceSelection = { ...sourceInfo, wholeItem: true };
      } else {
        sourceSelection = {
          ...sourceInfo,
          wholeItem: false,
          partialSelection: true,
          selectedText
        };
      }
    }
    const computedFontSize = Number.parseFloat(computedStyle?.fontSize);
    // The visible PDF.js text layer is the authoritative size for editor
    // geometry. Some pages expose a source transform size that differs from
    // the DOM glyph size, which made the replacement font look broken.
    const fontSize = Math.max(
      1,
      (Number.isFinite(computedFontSize) && computedFontSize > 1
        ? computedFontSize
        : currentRect.height * scale * 0.82) / scale
    );
    const computedColor = computedStyle?.color || '';
    const color = computedColor && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0)?\s*\)/i.test(computedColor)
      ? computedColor
      : '#111111';
    const cover = {
      x: currentRect.x,
      y: currentRect.y,
      width: currentRect.width,
      height: currentRect.height
    };
    const backgroundColor = sampleReplacementBackground(canvasRef.current, pageSize, {
      x: cover.x * scale,
      y: cover.y * scale,
      width: cover.width * scale,
      height: cover.height * scale
    });
    const sampledTextColor = sampleReplacementTextColor(canvasRef.current, pageSize, {
      x: cover.x * scale,
      y: cover.y * scale,
      width: cover.width * scale,
      height: cover.height * scale
    });
    const resolvedSourceFont = getSelectionSourceFont(sourceInfo, textContent, selectedText);
    if (sourceSelection && resolvedSourceFont) {
      sourceSelection = { ...sourceSelection, sourceFont: resolvedSourceFont };
    }
    const sourceFont = sourceSelection?.sourceFont || resolvedSourceFont;
    const fontCandidates = collectFontCandidates(
      sourceFont,
      sourceInfo?.sourceFont,
      textContent?.fontPreviews?.[Number(sourceInfo?.textItemIndex)]
    );
    const sourceFontWeight = sourceFont?.fontWeight || computedStyle?.fontWeight || 'normal';
    const preferBoldFont = sourceFont?.preferBoldFont === true || sourceFontWeight === 'bold' || Number(sourceFontWeight) >= 600;
    const measuredText = measureDisplayText(displayText, fontSize, {
      ...computedStyle,
      fontWeight: sourceFontWeight
    });
    const horizontalSafetyPadding = Math.max(2, fontSize * 0.15);
    const verticalSafetyPadding = Math.max(1, fontSize * 0.1);
    // Text replacement is anchored at the source selection's left edge.
    // Do not centre shorter batch values: the user expects both manual and
    // batch replacements to remain at exactly the original text position.
    const anchoredX = currentRect.x;
    const displayRect = {
      ...currentRect,
      x: anchoredX,
      width: Math.max(currentRect.width, measuredText.width + horizontalSafetyPadding * 2),
      height: Math.max(currentRect.height, measuredText.height + verticalSafetyPadding * 2)
    };
    let glyphScaleX = 1;
    if (sourceFont?.glyphText) {
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${sourceFont.fontStyle} ${sourceFont.fontWeight} ${fontSize}px ${sourceFont.fontFamily}`;
      const naturalWidth = context.measureText(sourceFont.glyphText).width;
      if (naturalWidth > 0) glyphScaleX = currentRect.width / naturalWidth;
    }
    const createdTextId = onCreateMovableText?.({
      type: (textReplaceMode || isBatchSelection) ? 'replacementText' : 'movableText',
      pageNumber,
      searchLineNumber: batchTarget?.lineNumber ?? batchTarget?.line ?? null,
      displayText,
      text: displayText,
      // PDF.js can expose a compact source string while browser selection
      // presents layout spaces between glyphs. Retain both representations.
      // Keep layout/source text separately, but use the actual selected word
      // for deletion matching. This prevents a leading space in the PDF text
      // item from turning a text-only selection into a mismatched range.
      sourceText: sourceSelection?.selectedText || selectedText,
      originalText: sourceSelection?.selectedText || selectedText,
      originalRect: currentRect,
      displayRect,
      movedRect: displayRect,
      currentRect: displayRect,
      coverRects,
      sourcePageWidth: pageSize.width / scale,
      sourcePageHeight: pageSize.height / scale,
      backgroundColor,
      // PDF.js text-layer bounds can be tighter than anti-aliased canvas
      // glyphs. Keep a small bleed around the cover so the original glyph
      // never remains visible behind a live editor.
      coverPadding: Math.max(1 / scale, fontSize * 0.06),
      renderFontFamily: 'DocPilotReplacement',
      fontSize,
      fontFamily: computedStyle?.fontFamily || 'Helvetica, Arial, sans-serif',
      // The selected local font face itself may already be Bold. Keep the
      // toolbar's manual-bold state off initially; it is independent from
      // the original face chosen through preferBoldFont.
      fontWeight: 'normal',
      preferBoldFont,
      fontStyle: computedStyle?.fontStyle || 'normal',
      letterSpacing: 0,
      verticalAlign: 'middle',
      textAlign: 'left',
      // PDF operator color is authoritative. Canvas sampling is retained only
      // for documents where the source operator does not expose one.
      color: sourceFont?.textColor || sampledTextColor || color,
      createdFromSelection: true,
      // Batch replacement differs only in how this Range was obtained.
      // From here onward it follows the same replacement object contract as
      // a user-dragged "텍스트 교체" selection.
      // Text Move creates movable objects. Text Replace and Batch Replace are
      // anchored edits and must remain locked even if Text Move is enabled
      // later.
      allowMove: textMoveMode && !textReplaceMode && !isBatchSelection,
      autoEdit: textReplaceMode && !isBatchSelection,
      // A browser selection is represented by PDF.js Unicode text. Preserve
      // that exact text for export rather than replaying the source glyph run.
      forceUnicodeFallback: true,
      sourceSelection,
      sourceFont: sourceFont || null,
      // Preserve the original PDF font name for partial search selections as
      // well as whole-item manual selections. This is consumed by Electron's
      // local Windows-font resolver during PDF export.
      fontCandidates,
      originalFontCandidates: fontCandidates,
      originalPreferBoldFont: preferBoldFont,
      glyphText: sourceFont?.glyphText || null,
      originalGlyphText: sourceFont?.glyphText || null,
      originalEncodedText: sourceInfo?.encodedText || null,
      originalUnicodeText: selectedText,
      fontAnalysis: sourceInfo?.sourceFont || null,
      glyphScaleX,
      // Browser range rectangles and PDF text transforms do not always share
      // a baseline for split text spans. Replacement input uses the same
      // top-aligned geometry as its cover so it cannot overlap a neighbour.
      baselineOffset: (textReplaceMode || isBatchSelection)
        // Centre the editor line box vertically in the selected glyph area.
        // This is stable for pages whose PDF source baseline differs from the
        // browser range rectangle.
        ? Math.max(0, (currentRect.height - fontSize) / 2) + fontSize * 0.88
        : sourceSelection && viewport
        ? (viewport.convertToViewportPoint(sourceSelection.transform[4], sourceSelection.transform[5])[1] / scale) - currentRect.y
        : null,
      canDirectEdit: false,
      fallbackReason: '저장 시 원본 텍스트 직접 제거 가능 여부를 확인합니다.'
    });
    if (createdTextId && fontCandidates.length) {
      resolveReplacementPreviewFont(fontCandidates, { preferBold: preferBoldFont })
        .then((previewFont) => onUpdateMovableTextPreviewFont?.(createdTextId, previewFont))
        .catch((fontError) => {
          console.warn('[PdfPage] source font preview unavailable; using bundled font:', fontError);
        });
    }
    setSelectionBoxes([]);
    selection.removeAllRanges();
  }, [batchReplaceRequest, onCreateMovableText, onUpdateMovableTextPreviewFont, pageNumber, pageSize, scale, textContent, textMoveMode, textReplaceMode, viewport]);

  const createAreaReplacementItems = useCallback((area) => {
    const pageElement = pageRef.current;
    const textLayer = pageElement?.querySelector('.textLayer');
    if (!pageElement || !textLayer || !textContent) return;
    const groups = getAreaTextLineGroups(textLayer, area, pageElement, scale);
    if (!groups.length) return;

    const selections = groups.map((group, index) => {
      const { text, geometry, sourceElement } = group;
      const { currentRect, coverRects } = geometry;
      let sourceInfo = null;
      try { sourceInfo = sourceElement?.dataset.pdfSource ? JSON.parse(sourceElement.dataset.pdfSource) : null; } catch { sourceInfo = null; }
      const computedStyle = sourceElement ? window.getComputedStyle(sourceElement) : null;
      const computedFontSize = Number.parseFloat(computedStyle?.fontSize);
      const fontSize = Math.max(1, (Number.isFinite(computedFontSize) && computedFontSize > 1
        ? computedFontSize : currentRect.height * scale * 0.82) / scale);
      const sourceFont = getSelectionSourceFont(sourceInfo, textContent, text);
      const fontCandidates = collectFontCandidates(sourceFont, sourceInfo?.sourceFont,
        textContent?.fontPreviews?.[Number(sourceInfo?.textItemIndex)]);
      const sourceFontWeight = sourceFont?.fontWeight || computedStyle?.fontWeight || 'normal';
      const measuredText = measureDisplayText(text, fontSize, { ...computedStyle, fontWeight: sourceFontWeight });
      const displayRect = {
        ...currentRect,
        width: Math.max(currentRect.width, measuredText.width + Math.max(2, fontSize * 0.15) * 2),
        height: Math.max(currentRect.height, measuredText.height + Math.max(1, fontSize * 0.1) * 2)
      };
      const cover = { x: currentRect.x, y: currentRect.y, width: currentRect.width, height: currentRect.height };
      const backgroundColor = sampleReplacementBackground(canvasRef.current, pageSize, {
        x: cover.x * scale, y: cover.y * scale, width: cover.width * scale, height: cover.height * scale
      });
      const computedColor = computedStyle?.color || '';
      const color = sourceFont?.textColor || sampleReplacementTextColor(canvasRef.current, pageSize, {
        x: cover.x * scale, y: cover.y * scale, width: cover.width * scale, height: cover.height * scale
      }) || (computedColor && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0)?\s*\)/i.test(computedColor) ? computedColor : '#111111');
      const preferBoldFont = sourceFont?.preferBoldFont === true || sourceFontWeight === 'bold' || Number(sourceFontWeight) >= 600;
      return {
        type: 'replacementText', pageNumber, displayText: text, text,
        sourceText: text, originalText: text, originalUnicodeText: text,
        originalRect: currentRect, displayRect, movedRect: displayRect, currentRect: displayRect, coverRects,
        sourcePageWidth: pageSize.width / scale, sourcePageHeight: pageSize.height / scale,
        backgroundColor, coverPadding: Math.max(1 / scale, fontSize * 0.06), color, renderFontFamily: 'DocPilotReplacement', fontSize,
        fontFamily: computedStyle?.fontFamily || 'Helvetica, Arial, sans-serif', fontWeight: 'normal',
        preferBoldFont, fontStyle: computedStyle?.fontStyle || 'normal', letterSpacing: 0,
        verticalAlign: 'middle', textAlign: 'left', allowMove: false, autoEdit: index === 0,
        forceUnicodeFallback: true, sourceSelection: null, sourceFont: sourceFont || null,
        fontCandidates, originalFontCandidates: fontCandidates, originalPreferBoldFont: preferBoldFont,
        originalGlyphText: sourceFont?.glyphText || null, originalEncodedText: sourceInfo?.encodedText || null,
        fontAnalysis: sourceInfo?.sourceFont || null,
        baselineOffset: Math.max(0, (currentRect.height - fontSize) / 2) + fontSize * 0.88,
        canDirectEdit: false, fallbackReason: '영역 선택으로 만든 줄별 텍스트 교체 항목입니다.'
      };
    });
    const ids = onCreateMovableTexts?.(selections) || [];
    selections.forEach((selection, index) => {
      if (!ids[index] || !selection.fontCandidates.length) return;
      resolveReplacementPreviewFont(selection.fontCandidates, { preferBold: selection.preferBoldFont })
        .then((previewFont) => onUpdateMovableTextPreviewFont?.(ids[index], previewFont))
        .catch(() => undefined);
    });
  }, [onCreateMovableTexts, onUpdateMovableTextPreviewFont, pageNumber, pageSize, scale, textContent]);

  const handleAreaSelectionPointerDown = useCallback((event) => {
    if (!areaTextReplaceMode || event.button !== 0 || !pageRef.current) return;
    event.preventDefault();
    const pageRect = pageRef.current.getBoundingClientRect();
    const startX = Math.max(0, Math.min(pageRect.width, event.clientX - pageRect.left));
    const startY = Math.max(0, Math.min(pageRect.height, event.clientY - pageRect.top));
    areaSelectionRef.current = { pageRect, startX, startY };
    setAreaSelectionBox({ x: startX, y: startY, width: 0, height: 0 });
    const update = (pointerEvent) => {
      const active = areaSelectionRef.current;
      if (!active) return null;
      const x = Math.max(0, Math.min(active.pageRect.width, pointerEvent.clientX - active.pageRect.left));
      const y = Math.max(0, Math.min(active.pageRect.height, pointerEvent.clientY - active.pageRect.top));
      const box = { x: Math.min(active.startX, x), y: Math.min(active.startY, y), width: Math.abs(x - active.startX), height: Math.abs(y - active.startY) };
      setAreaSelectionBox(box);
      return box;
    };
    const finish = (pointerEvent) => {
      const box = update(pointerEvent);
      const active = areaSelectionRef.current;
      areaSelectionRef.current = null;
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      setAreaSelectionBox(null);
      if (!box || box.width < 6 || box.height < 6 || !active) return;
      createAreaReplacementItems({
        left: active.pageRect.left + box.x, top: active.pageRect.top + box.y,
        right: active.pageRect.left + box.x + box.width, bottom: active.pageRect.top + box.y + box.height
      });
    };
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish, { once: true });
  }, [areaTextReplaceMode, createAreaReplacementItems]);

  useEffect(() => {
    if (!textMoveMode && !textReplaceMode) {
      setSelectionBoxes([]);
      return undefined;
    }
    const updateSelectionPreview = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !pageRef.current) {
        setSelectionBoxes([]);
        return;
      }
      const range = selection.getRangeAt(0);
      const commonNode = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
      const textLayer = pageRef.current.querySelector('.textLayer');
      if (!textLayer?.contains(commonNode)) {
        setSelectionBoxes([]);
        return;
      }
      const geometry = getSelectionGeometry(range, pageRef.current, scale, textLayer);
      setSelectionBoxes((geometry?.previewBoxes || []).map((box) => ({ ...box, page: pageNumber })));
    };
    document.addEventListener('selectionchange', updateSelectionPreview);
    return () => document.removeEventListener('selectionchange', updateSelectionPreview);
  }, [pageNumber, scale, textMoveMode, textReplaceMode]);

  useLayoutEffect(() => {
    if (!batchReplaceRequest || !pageRef.current || handledBatchRequestRef.current === batchReplaceRequest.id) return;
    const targets = (batchReplaceRequest.targets || []).filter((target) => Number(target.pageNumber ?? target.page) === pageNumber);
    if (!targets.length) return;

    const textLayer = pageRef.current.querySelector('.textLayer');
    if (!textLayer) return;
    const nodes = [];
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    let combined = '';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const start = combined.length;
      combined += node.textContent || '';
      nodes.push({ node, start, end: combined.length });
    }
    const originalText = String(batchReplaceRequest.originalText || '');
    if (!originalText || !nodes.length) return;
    const occurrences = [];
    const lowerText = combined.toLocaleLowerCase();
    const lowerOriginal = originalText.toLocaleLowerCase();
    let offset = 0;
    while (offset <= lowerText.length - lowerOriginal.length) {
      const found = lowerText.indexOf(lowerOriginal, offset);
      if (found < 0) break;
      occurrences.push(found);
      offset = found + Math.max(lowerOriginal.length, 1);
    }
    targets.forEach((target, index) => {
      const occurrence = occurrences[Number(target.pageMatchOrdinal ?? index)];
      if (!Number.isInteger(occurrence)) return;
      const end = occurrence + originalText.length;
      const startNode = nodes.find((entry) => occurrence >= entry.start && occurrence < entry.end);
      const endNode = nodes.find((entry) => end > entry.start && end <= entry.end);
      if (!startNode || !endNode) return;
      const range = document.createRange();
      range.setStart(startNode.node, occurrence - startNode.start);
      range.setEnd(endNode.node, end - endNode.start);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      batchSelectionActiveRef.current = true;
      handleTextSelection();
      batchSelectionActiveRef.current = false;
    });
    handledBatchRequestRef.current = batchReplaceRequest.id;
    onBatchReplaceHandled?.(batchReplaceRequest.id, pageNumber);
  }, [batchReplaceRequest, handleTextSelection, onBatchReplaceHandled, pageNumber, textLayerVersion]);

  const handleMovableTextPointerDown = (event, item) => {
    if (!editingEnabled) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    onSelectMovableText?.(item.id);
    // Replacements remain fixed during normal editing, but switching on
    // "텍스트 이동" explicitly authorizes moving any edited text as well.
    // Older replacement objects may have allowMove:false from the former
    // creation-time lock, so do not let that stale flag override the mode.
    if (!textMoveMode) return;
    moveRef.current = {
      id: item.id,
      startX: event.clientX,
      startY: event.clientY,
      startRect: item.currentRect
    };
  };

  const handleImagePointerDown = (event, item, action = 'move') => {
    if (!editingEnabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectImage?.(item.id);
    imageMoveRef.current = { id: item.id, action, startX: event.clientX, startY: event.clientY, startRect: item.currentRect, aspectRatio: item.aspectRatio || (item.currentRect.width / Math.max(item.currentRect.height, 1)) };
  };

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (moveRef.current) {
        const { id, startX, startY, startRect } = moveRef.current;
        const pageWidth = pageSize.width / scale;
        const pageHeight = pageSize.height / scale;
        const currentRect = {
          ...startRect,
          x: Math.min(Math.max(0, startRect.x + (event.clientX - startX) / scale), Math.max(0, pageWidth - startRect.width)),
          y: Math.min(Math.max(0, startRect.y + (event.clientY - startY) / scale), Math.max(0, pageHeight - startRect.height))
        };
        moveRef.current.currentRect = currentRect;
        onMoveMovableText?.(id, currentRect);
      }
      if (imageMoveRef.current) {
        const active = imageMoveRef.current;
        const pageWidth = pageSize.width / scale;
        const pageHeight = pageSize.height / scale;
        const dx = (event.clientX - active.startX) / scale;
        const dy = (event.clientY - active.startY) / scale;
        const currentRect = active.action === 'resize'
          ? (() => {
            const width = Math.max(36, Math.min(pageWidth - active.startRect.x, active.startRect.width + dx));
            const height = Math.max(24, Math.min(pageHeight - active.startRect.y, width / Math.max(active.aspectRatio, 0.01)));
            return { ...active.startRect, width: Math.min(width, height * active.aspectRatio), height };
          })()
          : { ...active.startRect, x: Math.min(Math.max(0, active.startRect.x + dx), Math.max(0, pageWidth - active.startRect.width)), y: Math.min(Math.max(0, active.startRect.y + dy), Math.max(0, pageHeight - active.startRect.height)) };
        active.currentRect = currentRect;
        onMoveImage?.(active.id, currentRect);
      }
    };
    const handlePointerUp = () => {
      if (moveRef.current?.currentRect) {
        onMoveMovableTextEnd?.(moveRef.current.id, moveRef.current.currentRect);
      }
      moveRef.current = null;
      if (imageMoveRef.current?.currentRect) onMoveImageEnd?.(imageMoveRef.current.id, imageMoveRef.current.currentRect);
      imageMoveRef.current = null;
    };
    const handleKeyDown = (event) => {
      if (!selectedMovableTextId && !selectedImageId) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea')) return;
      if (event.key === 'Escape') {
        onSelectMovableText?.(null);
        onSelectImage?.(null);
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        if (selectedImageId) onDeleteImage?.(selectedImageId);
        else onDeleteMovableText?.(selectedMovableTextId);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onDeleteImage, onDeleteMovableText, onMoveImage, onMoveImageEnd, onMoveMovableText, onMoveMovableTextEnd, onSelectImage, onSelectMovableText, pageSize, scale, selectedImageId, selectedMovableTextId]);

  useEffect(() => {
    let cancelled = false;

    async function renderPage() {
      if (!pdf || !canvasRef.current) {
        return;
      }

      const previousRenderTask = renderTaskRef.current;
      if (previousRenderTask) {
        renderTaskRef.current = null;
        previousRenderTask.cancel();
        // PDF.js does not release the canvas until the cancelled render promise
        // settles. Waiting here prevents StrictMode's effect re-run from
        // starting a second render on the same canvas.
        try {
          await previousRenderTask.promise;
        } catch (error) {
          if (error?.name !== 'RenderingCancelledException') {
            console.warn('[PdfPage] previous render cleanup failed:', error);
          }
        }
      }

      if (cancelled) {
        return;
      }

      setRenderError('');
      console.log('[PdfPage] render page:', pageNumber);

      const page = await pdf.getPage(pageNumber);

      if (cancelled) {
        return;
      }

      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');

      if (!context) {
        throw new Error('Canvas 2D context is not available.');
      }

      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      setPageSize({
        width: viewport.width,
        height: viewport.height
      });
      setViewport(viewport);

      const renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1
          ? null
          : [outputScale, 0, 0, outputScale, 0, 0]
      });

      renderTaskRef.current = renderTask;

      await renderTask.promise;

      if (renderTaskRef.current === renderTask) {
        renderTaskRef.current = null;
      }

      if (cancelled) {
        return;
      }

      // The replacement font is optional for displaying a PDF. A font load
      // failure must not turn a successfully rendered PDF page into a page
      // render error, especially in Electron's file:// environment.
      try {
        await ensureReplacementFont();
      } catch (fontError) {
        console.warn('[PdfPage] replacement font unavailable; using browser fallback:', fontError);
      }
      const textContent = await page.getTextContent();
      try {
        textContent.fontPreviews = await describePdfTextFonts(page, textContent);
      } catch (fontError) {
        console.warn('[PdfPage] 원본 글꼴 미리보기 분석 실패:', fontError);
      }
      if (!cancelled) {
        setTextContent(textContent);
        setReplacementPreviewItems([]);
      }
    }

    renderPage().catch((error) => {
      if (error?.name === 'RenderingCancelledException') {
        return;
      }

      console.error(`[PdfPage] Failed to render page ${pageNumber}`, error);

      if (!cancelled) {
        setRenderError(`${pageNumber}페이지를 표시하지 못했습니다. 파일을 다시 선택해주세요.`);
        setFallbackBoxes([]);
        setHighlightBoxes([]);
        setReplacementPreviewItems([]);
      }
    });

    return () => {
      cancelled = true;

      if (renderTaskRef.current) {
        const activeRenderTask = renderTaskRef.current;
        activeRenderTask.cancel();
      }
    };
  }, [pageNumber, pdf, scale]);

  useEffect(() => {
    const entries = Array.isArray(highlightEntries) && highlightEntries.length
      ? highlightEntries
      : (highlightKeyword ? [{ keyword: highlightKeyword, ...highlightOptions }] : []);
    if (!entries.length) {
      setFallbackBoxes([]);
      return;
    }
    const boxes = entries.flatMap((entry) => {
      const hasSelectedTargetFilter = Array.isArray(entry.selectedTargets);
      const selectedTargets = hasSelectedTargetFilter
        ? entry.selectedTargets.filter((target) => Number(target?.pageNumber ?? target?.page) === pageNumber)
        : [];
      if (hasSelectedTargetFilter && !selectedTargets.length) return [];
      const replacementTargets = (selectedTargets.length
        ? selectedTargets
        : (Array.isArray(entry.replacementTargets) ? entry.replacementTargets : [])
      ).filter((target) => target?.isReplacement && Number(target?.pageNumber ?? target?.page) === pageNumber);
      const replacementBoxes = replacementTargets.flatMap((target) => {
        const box = replacementHighlightBox(target, scale, movableTexts);
        return box ? [{ ...box, color: target.color || entry.color }] : [];
      });
      const textTargets = selectedTargets.filter((target) => !target?.isReplacement);
      if (selectedTargets.length) {
        return [
          ...replacementBoxes,
          ...textTargets.flatMap((target) => calculateFindBoxesFromPdfText({
          keyword: entry.keyword,
          pageNumber,
          textItems: textContent?.items,
          viewport,
          lineText: target.lineText ?? target.fullText ?? target.text
          }).map((box) => ({ ...box, color: target.color || entry.color })))
        ];
      }
      return [
        ...replacementBoxes,
        ...calculateHighlightBoxes({
        keyword: entry.keyword,
        pageNumber,
        textItems: textContent?.items,
        viewport,
        matchMode: entry.matchMode
        }).map((box) => ({ ...box, color: entry.color }))
      ];
    });
    setFallbackBoxes(boxes);
    return;
    /*
    const hasSelectedTargetFilter = Array.isArray(highlightOptions.selectedTargets);
    const selectedTargets = hasSelectedTargetFilter
      ? highlightOptions.selectedTargets.filter((target) => Number(target?.pageNumber ?? target?.page) === pageNumber)
      : [];
    if (hasSelectedTargetFilter && !selectedTargets.length) {
      setFallbackBoxes([]);
      return;
    }
    if (selectedTargets.length) {
      setFallbackBoxes(selectedTargets.flatMap((target) => calculateFindBoxesFromPdfText({
        keyword: highlightKeyword,
        pageNumber,
        textItems: textContent?.items,
        viewport,
        lineText: target.lineText ?? target.fullText ?? target.text
      }).map((box) => ({ ...box, color: target.color }))));
      return;
    }
    setFallbackBoxes(calculateHighlightBoxes({
      keyword: highlightKeyword, pageNumber,
      textItems: textContent?.items, viewport,
      matchMode: highlightOptions.matchMode
    }));
    */
  }, [highlightEntries, highlightKeyword, highlightOptions, movableTexts, pageNumber, scale, textContent, viewport]);

  useLayoutEffect(() => {
    if (!pageRef.current) {
      setHighlightBoxes([]);
      return undefined;
    }

    let frameId = 0;

    const updateHighlightBoxes = () => {
      const entries = Array.isArray(highlightEntries) && highlightEntries.length
        ? highlightEntries
        : (highlightKeyword ? [{ keyword: highlightKeyword, ...highlightOptions }] : []);
      if (!entries.length) {
        setHighlightBoxes([]);
        return;
      }
      const domRangeBoxes = entries.flatMap((entry) => {
        const hasSelectedTargetFilter = Array.isArray(entry.selectedTargets);
        const selectedTargets = hasSelectedTargetFilter
          ? entry.selectedTargets.filter((target) => Number(target?.pageNumber ?? target?.page) === pageNumber)
          : [];
        if (hasSelectedTargetFilter && !selectedTargets.length) return [];
        const replacementTargets = (selectedTargets.length
          ? selectedTargets
          : (Array.isArray(entry.replacementTargets) ? entry.replacementTargets : [])
        ).filter((target) => target?.isReplacement && Number(target?.pageNumber ?? target?.page) === pageNumber);
        const replacementBoxes = replacementTargets.flatMap((target) => {
          const box = replacementHighlightBox(target, scale, movableTexts);
          return box ? [{ ...box, color: target.color || entry.color }] : [];
        });
        const textTargets = selectedTargets.filter((target) => !target?.isReplacement);
        if (selectedTargets.length) {
          return [
            ...replacementBoxes,
            ...textTargets.flatMap((target) => createHighlightBoxesFromTextLayer(pageRef.current, entry.keyword, {
            matchMode: entry.matchMode,
            lineNumber: Number(target.lineNumber ?? target.line),
            matchIndex: Number(target.matchIndex),
            lineText: target.lineText ?? target.fullText ?? target.text
            }).map((box) => ({ ...box, color: target.color || entry.color })))
          ];
        }
        return [
          ...replacementBoxes,
          ...createHighlightBoxesFromTextLayer(pageRef.current, entry.keyword, entry).map((box) => ({ ...box, color: entry.color }))
        ];
      });
      if (domRangeBoxes.length > 0) {
        setHighlightBoxes(domRangeBoxes.map((box) => ({ ...box, page: pageNumber })));
        return;
      }
      setHighlightBoxes(fallbackBoxes);
      return;
      /*
      const hasSelectedTargetFilter = Array.isArray(highlightOptions.selectedTargets);
      const selectedTargets = hasSelectedTargetFilter
        ? highlightOptions.selectedTargets.filter((target) => Number(target?.pageNumber ?? target?.page) === pageNumber)
        : [];
      if (hasSelectedTargetFilter && !selectedTargets.length) {
        setHighlightBoxes([]);
        return;
      }
      const domRangeBoxes = selectedTargets.length
        ? selectedTargets.flatMap((target) => createHighlightBoxesFromTextLayer(pageRef.current, highlightKeyword, {
          matchMode: highlightOptions.matchMode,
          lineNumber: Number(target.lineNumber ?? target.line),
          matchIndex: Number(target.matchIndex),
          lineText: target.lineText ?? target.fullText ?? target.text
        }).map((box) => ({ ...box, color: target.color })))
        : createHighlightBoxesFromTextLayer(pageRef.current, highlightKeyword, highlightOptions);

      if (domRangeBoxes.length > 0) {
        setHighlightBoxes(domRangeBoxes.map((box) => ({ ...box, page: pageNumber })));
        return;
      }

      setHighlightBoxes(fallbackBoxes);
      */
    };

    frameId = window.requestAnimationFrame(updateHighlightBoxes);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [fallbackBoxes, highlightEntries, highlightKeyword, highlightOptions, movableTexts, pageNumber, scale, textLayerVersion]);

  useLayoutEffect(() => {
    const targetPage = Number(findResult?.pageNumber ?? findResult?.page);
    // Search results show a surrounding word for context, but the temporary
    // Ctrl+F-style marker should color only the search term itself.
    const keyword = String(findResult?.keyword ?? findResult?.matchedText ?? findResult?.originalText ?? '').trim();

    if (!pageRef.current || targetPage !== pageNumber || !keyword) {
      setFindBoxes([]);
      return undefined;
    }

    let frameId = window.requestAnimationFrame(() => {
      let boxes = createHighlightBoxesFromTextLayer(pageRef.current, keyword, {
        matchMode: 'contains',
        lineNumber: Number(findResult?.lineNumber ?? findResult?.line),
        matchIndex: Number(findResult?.matchIndex),
        lineText: findResult?.lineText ?? findResult?.fullText ?? findResult?.text
      });
      // Large title glyphs and multi-column pages can receive a different
      // DOM character index after PDF.js text-layer width correction. The
      // result line remains a reliable identity, so retry within that one
      // line without the stale index rather than losing the Ctrl+F marker.
      if (!boxes.length) {
        boxes = createHighlightBoxesFromTextLayer(pageRef.current, keyword, {
          matchMode: 'contains',
          lineText: findResult?.lineText ?? findResult?.fullText ?? findResult?.text
        });
      }
      if (!boxes.length) {
        boxes = calculateFindBoxesFromPdfText({
          keyword,
          pageNumber,
          textItems: textContent?.items,
          viewport,
          lineText: findResult?.lineText ?? findResult?.fullText ?? findResult?.text
        });
      }
      setFindBoxes(boxes.map((box) => ({ ...box, page: pageNumber })));
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [findResult, pageNumber, textContent, textLayerVersion, viewport]);

  useLayoutEffect(() => {
    if (!pageRef.current || !replacePreview?.originalText || replacePreview?.mode === 'review') {
      setReplacementPreviewItems([]);
      return undefined;
    }

    let frameId = 0;

    const updateReplacementPreview = () => {
      const items = createReplacementPreviewFromTextLayer(pageRef.current, replacePreview);
      const canvas = canvasRef.current;
      setReplacementPreviewItems(items.map((item) => ({
        ...item,
        cover: {
          ...item.cover,
          backgroundColor: sampleReplacementBackground(canvas, pageSize, item.cover)
        }
      })));
    };

    frameId = window.requestAnimationFrame(updateReplacementPreview);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [pageNumber, pageSize, replacePreview, textLayerVersion]);

  useEffect(() => {
    if (!onPageReady) {
      return undefined;
    }

    onPageReady(pageRef.current);

    return () => {
      onPageReady(null);
    };
  }, [onPageReady, pageNumber, pageSize.height, pageSize.width]);

  return (
    <div
      ref={pageRef}
      className={`pdf-page${textMoveMode || textReplaceMode ? ' is-text-selection-mode' : ''}${areaTextReplaceMode ? ' is-area-text-selection-mode' : ''}`}
      data-page-number={pageNumber}
      onMouseDown={() => setSelectionBoxes([])}
      onMouseUp={handleTextSelection}
      onPointerDown={handleAreaSelectionPointerDown}
      style={{
        width: pageSize.width ? `${pageSize.width}px` : undefined,
        height: pageSize.height ? `${pageSize.height}px` : undefined,
        minHeight: pageSize.height ? `${pageSize.height}px` : undefined
      }}
    >
      <div className="pdf-page-debug-label">page {pageNumber}</div>
      {renderError ? <div role="alert">{renderError}</div> : null}
      <canvas ref={canvasRef} className="pdf-canvas" />
      <PdfTextLayer
        pageNumber={pageNumber}
        textContent={textContent}
        viewport={viewport}
        width={pageSize.width}
        height={pageSize.height}
        onRendered={handleTextLayerRendered}
      />
      {areaSelectionBox ? <div className="pdf-area-text-selection-box" style={{ left: `${areaSelectionBox.x}px`, top: `${areaSelectionBox.y}px`, width: `${areaSelectionBox.width}px`, height: `${areaSelectionBox.height}px` }} /> : null}
      <HighlightLayer boxes={selectionBoxes} width={pageSize.width} height={pageSize.height} color="blue" />
      <ReplacementPreviewLayer items={replacementPreviewItems} width={pageSize.width} height={pageSize.height} />
      <MovableTextLayer
        items={movableTexts}
        scale={scale}
        selectedId={selectedMovableTextId}
        editingMovableText={editingMovableText}
        onPointerDown={handleMovableTextPointerDown}
        onDoubleClick={editingEnabled ? onBeginEditMovableText : undefined}
        onEditChange={onChangeEditMovableText}
        onEditStyleChange={onChangeEditMovableTextStyle}
        onEditCommit={onCommitEditMovableText}
        onEditCancel={onCancelEditMovableText}
      />
      <ImageAttachmentLayer items={imageAttachments} scale={scale} selectedId={selectedImageId} onPointerDown={handleImagePointerDown} />
      <HighlightLayer boxes={highlightBoxes} width={pageSize.width} height={pageSize.height} color={highlightOptions.color} />
      <HighlightLayer boxes={findBoxes} width={pageSize.width} height={pageSize.height} color="blue" />
    </div>
  );
}

function ImageAttachmentLayer({ items, scale, selectedId, onPointerDown }) {
  if (!items.length) return null;
  return (
    <div className="pdf-image-layer" aria-label="첨부 이미지">
      {items.map((item) => (
        <div
          key={item.id}
          className={`pdf-image-object${selectedId === item.id ? ' is-selected' : ''}`}
          style={{ left: `${item.currentRect.x * scale}px`, top: `${item.currentRect.y * scale}px`, width: `${item.currentRect.width * scale}px`, height: `${item.currentRect.height * scale}px` }}
          onPointerDown={(event) => onPointerDown?.(event, item, 'move')}
        >
          <img src={item.dataUrl} alt="첨부 이미지" draggable="false" />
          {selectedId === item.id ? <button type="button" className="pdf-image-resize-handle" aria-label="이미지 크기 조절" onPointerDown={(event) => onPointerDown?.(event, item, 'resize')} /> : null}
        </div>
      ))}
    </div>
  );
}

function MovableTextLayer({ items, scale, selectedId, editingMovableText, onPointerDown, onDoubleClick, onEditChange, onEditStyleChange, onEditCommit, onEditCancel }) {
  if (!items.length) return null;

  return (
    <div className="movable-text-layer" aria-hidden="true">
      {items.map((item) => (
        <div key={item.id}>
          {(item.persistedToPdf && !item.hasChanges
            ? []
            : (item.persistedToPdf && item.hasChanges
              ? [item.originalRect]
              : (item.coverRects?.length ? item.coverRects : [item.originalRect]))
          ).filter((cover) => Number.isFinite(Number(cover?.x)) && Number.isFinite(Number(cover?.y))
            && Number(cover?.width) > 0 && Number(cover?.height) > 0).map((cover, index) => (
            (() => {
              const padding = Number.isFinite(Number(item.coverPadding))
                ? Number(item.coverPadding)
                : Math.max(1 / scale, Number(item.fontSize || 10) * 0.06);
              return <div
                key={`${item.id}-cover-${index}`}
                className="movable-text-cover"
                style={{
                  left: `${(cover.x - padding) * scale}px`,
                  top: `${(cover.y - padding) * scale}px`,
                  width: `${(cover.width + padding * 2) * scale}px`,
                  height: `${(cover.height + padding * 2) * scale}px`,
                  backgroundColor: item.backgroundColor || '#ffffff'
                }}
              />;
            })()
          ))}
          <div
            className={`movable-text-object ${selectedId === item.id ? 'is-selected' : ''} ${item.persistedToPdf && !item.hasChanges ? 'is-review-selection' : ''}`}
            style={{
              left: `${item.currentRect.x * scale}px`,
              // Replacement selections already use the text-layer's top
              // coordinate. Applying the movable-text baseline correction to
              // them a second time makes the edit box drift downward. Keep
              // replacements anchored to the original selection rectangle;
              // only ordinary text-move objects need baseline correction.
              top: `${(
                item.type === 'replacementText' || item.autoEdit || item.isReplacement
                  ? item.currentRect.y
                  : item.currentRect.y + (
                    Number.isFinite(Number(editingMovableText?.id === item.id ? editingMovableText.baselineOffset : item.baselineOffset))
                      ? Number(editingMovableText?.id === item.id ? editingMovableText.baselineOffset : item.baselineOffset)
                        - Number(editingMovableText?.id === item.id ? editingMovableText.fontSize : item.fontSize) * 0.88
                      : Number(editingMovableText?.id === item.id ? editingMovableText.fontSize : item.fontSize) * 0.02
                  )
              ) * scale}px`,
              width: `${item.currentRect.width * scale}px`,
              minHeight: `${item.currentRect.height * scale}px`,
              color: item.color,
              // Movable text is exported with the Unicode fallback font. Use
              // that same font in the viewer so glyph width and line spacing
              // do not change between the editor and the downloaded PDF.
              fontFamily: item.renderFontFamily || 'DocPilotReplacement',
              fontSize: `${Number(editingMovableText?.id === item.id ? editingMovableText.fontSize : item.fontSize) * scale}px`,
              // The selection rectangle includes PDF.js ascent/descent
              // padding. Use the actual fallback font size as the line box so
              // the editor does not sit lower than the exported PDF text.
              lineHeight: `${Number(editingMovableText?.id === item.id ? editingMovableText.fontSize : item.fontSize) * scale}px`,
              fontWeight: item.fontWeight === 'bold' ? 900 : (item.fontWeight || 'normal'),
              fontStyle: item.fontStyle || 'normal',
              textDecoration: item.textDecoration || 'none',
              letterSpacing: `${(Number(item.letterSpacing) || 0) * scale}px`,
              textAlign: editingMovableText?.id === item.id ? (editingMovableText.textAlign || 'left') : (item.textAlign || 'left'),
              textShadow: 'none',
              WebkitTextStroke: item.fontWeight === 'bold' ? '0.32px currentColor' : '0 transparent'
            }}
            onPointerDown={(event) => onPointerDown(event, item)}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDoubleClick?.(item.id);
            }}
          >
            {editingMovableText?.id === item.id ? (
              <div className="movable-text-editor" onPointerDown={(event) => event.stopPropagation()}>
                <input
                  className="movable-text-edit-input"
                  value={editingMovableText.value}
                  style={{
                    fontFamily: item.renderFontFamily || 'DocPilotReplacement',
                    fontWeight: editingMovableText.fontWeight === 'bold' ? 900 : (editingMovableText.fontWeight || 'normal'),
                    fontStyle: editingMovableText.fontStyle || 'normal',
                    textDecoration: editingMovableText.textDecoration || 'none',
                    color: editingMovableText.color || '#111111',
                    letterSpacing: `${Number(editingMovableText.letterSpacing) || 0}px`,
                    textAlign: editingMovableText.textAlign || 'left',
                    textShadow: 'none',
                    WebkitTextStroke: editingMovableText.fontWeight === 'bold' ? '0.32px currentColor' : '0 transparent'
                  }}
                  onChange={(event) => onEditChange?.(event.target.value)}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onEditCommit?.();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      onEditCancel?.();
                    } else if (event.ctrlKey || event.metaKey) {
                      if (event.key.toLowerCase() === 'b') {
                        event.preventDefault();
                        onEditStyleChange?.({ fontWeight: editingMovableText.fontWeight === 'bold' ? 'normal' : 'bold' });
                      } else if (event.key.toLowerCase() === 'i') {
                        event.preventDefault();
                        onEditStyleChange?.({ fontStyle: editingMovableText.fontStyle === 'italic' ? 'normal' : 'italic' });
                      } else if (event.key.toLowerCase() === 'u') {
                        event.preventDefault();
                        onEditStyleChange?.({ textDecoration: editingMovableText.textDecoration === 'underline' ? 'none' : 'underline' });
                      }
                    }
                  }}
                  onBlur={() => {
                    window.setTimeout(() => {
                      if (!document.activeElement?.closest?.('.pdf-text-edit-toolbar')) onEditCommit?.();
                    }, 0);
                  }}
                  autoFocus
                  aria-label="선택한 PDF 텍스트 편집"
                />
              </div>
            ) : (item.persistedToPdf && !item.hasChanges ? null : (item.displayText || item.text))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReplacementPreviewLayer({ items, width, height }) {
  if (!items.length) {
    return null;
  }

  return (
    <div
      className="replacement-layer"
      style={{
        width: `${width}px`,
        height: `${height}px`
      }}
    >
      {items.map((item) => (
        <div key={item.id} data-replacement-source={item.sourceTarget ? JSON.stringify({
          ...item.sourceTarget,
          originalText: item.sourceTarget.originalText || item.sourceTarget.matchedText,
          replacementText: item.text.value,
          sourceText: item.sourceTarget.sourceText || item.sourceTarget.matchedText || item.sourceTarget.originalText,
          sourceFullText: item.sourceTarget.sourceFullText || ''
        }) : undefined}>
          <div
            className="replacement-cover"
            style={{
              left: `${item.cover.x}px`,
              top: `${item.cover.y}px`,
              width: `${item.cover.width}px`,
              height: `${item.cover.height}px`,
              backgroundColor: item.cover.backgroundColor || '#ffffff'
            }}
          />
          <div
            className="replacement-text"
            data-baseline={item.text.baseline}
            data-max-width={item.text.maxWidth}
            style={{
              left: `${item.text.x}px`,
              top: `${item.text.y}px`,
              fontSize: `${item.text.fontSize}px`,
              lineHeight: `${item.text.lineHeight}px`,
              fontFamily: item.text.fontFamily,
              fontWeight: item.text.fontWeight,
              fontStyle: item.text.fontStyle,
              letterSpacing: item.text.letterSpacing
            }}
          >
            {item.text.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export default PdfPage;
