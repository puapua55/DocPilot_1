import * as pdfjsLib from 'pdfjs-dist';
import { fitReplacementWidth, findNextTextX, findCellRight } from './pdfReplacementLayout';

const DEFAULT_PADDING_X = 1;
const DEFAULT_PADDING_Y = 1;
const MIN_BOX_SIZE = 2;
const REPLACE_PREVIEW_TUNING = {
  xOffset: 0,
  yOffset: 0,
  // The replacement object must be the selected glyph range itself.
  // Expanding this box hides table borders and creates visible gaps around
  // the following text when the replacement is shorter than the source.
  coverTopExtra: 0,
  coverBottomExtra: 0,
  coverXExtra: 0,
  fontSizeRatio: 1
};

function isWordSeparator(char) {
  return char == null || char === ' ' || char === '\n' || char === '\t';
}

function findHighlightMatchIndexes(text, keyword, matchMode = 'contains') {
  const sourceText = String(text || '');
  const targetText = String(keyword || '');
  const source = sourceText.toLowerCase();
  const target = targetText.toLowerCase();
  const indexes = [];

  if (!target) {
    return indexes;
  }

  let startIndex = 0;
  while (startIndex <= source.length - target.length) {
    const foundIndex = source.indexOf(target, startIndex);
    if (foundIndex === -1) {
      break;
    }

    const before = foundIndex > 0 ? sourceText[foundIndex - 1] : null;
    const afterIndex = foundIndex + targetText.length;
    const after = afterIndex < sourceText.length ? sourceText[afterIndex] : null;

    if (matchMode !== 'exact' || (isWordSeparator(before) && isWordSeparator(after))) {
      indexes.push(foundIndex);
    }

    startIndex = foundIndex + Math.max(target.length, 1);
  }

  return indexes;
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, '').toLocaleLowerCase();
}

function getTargetOccurrenceIndex(lineText, keyword, matchMode, matchIndex) {
  const sourceIndexes = findHighlightMatchIndexes(lineText, keyword, matchMode);
  const numericIndex = Number(matchIndex);
  const exactOccurrence = sourceIndexes.indexOf(numericIndex);
  if (exactOccurrence >= 0) return exactOccurrence;
  if (!Number.isFinite(numericIndex) || numericIndex < 0) return 0;

  const compactPrefixLength = compactText(String(lineText || '').slice(0, numericIndex)).length;
  const compactLine = compactText(lineText);
  const compactKeyword = compactText(keyword);
  const compactIndexes = [];
  let startIndex = 0;
  while (compactKeyword && startIndex <= compactLine.length - compactKeyword.length) {
    const foundIndex = compactLine.indexOf(compactKeyword, startIndex);
    if (foundIndex < 0) break;
    compactIndexes.push(foundIndex);
    startIndex = foundIndex + compactKeyword.length;
  }
  const compactOccurrence = compactIndexes.indexOf(compactPrefixLength);
  return compactOccurrence >= 0 ? compactOccurrence : 0;
}

function lineContainsTargetText(lineText, targetLineText) {
  const line = compactText(lineText);
  const target = compactText(targetLineText);
  return Boolean(line && target && (line.includes(target) || target.includes(line)));
}

function resolveTargetMatchIndexes(lineText, lineNumber, keyword, matchMode, target = {}) {
  const matchIndexes = findHighlightMatchIndexes(lineText, keyword, matchMode);
  if (!matchIndexes.length) return [];

  const targetLineText = String(target?.lineText ?? target?.fullText ?? target?.text ?? '');
  const targetLineNumber = Number(target?.lineNumber ?? target?.line);
  const targetMatchIndex = Number(target?.matchIndex);
  const hasLineNumber = Number.isInteger(targetLineNumber) && targetLineNumber > 0;
  const hasLineText = Boolean(targetLineText.trim());
  const hasMatchIndex = Number.isFinite(targetMatchIndex) && targetMatchIndex >= 0;

  if (!hasLineNumber && !hasLineText && !hasMatchIndex) return matchIndexes;

  const numberMatches = !hasLineNumber || targetLineNumber === lineNumber;
  const textMatches = !hasLineText || lineContainsTargetText(lineText, targetLineText);
  if (!numberMatches) return [];
  // A known source line must never expand to an unrelated line merely because
  // the same keyword exists elsewhere on the page.
  if (hasLineText && !textMatches) return [];

  const occurrenceIndex = getTargetOccurrenceIndex(
    targetLineText || lineText,
    keyword,
    matchMode,
    targetMatchIndex
  );
  return matchIndexes[occurrenceIndex] == null ? [] : [matchIndexes[occurrenceIndex]];
}

function getSpanPdfSource(span) {
  try {
    return JSON.parse(span?.dataset?.pdfSource || '{}');
  } catch {
    return {};
  }
}

function getTextLayerContentSpans(textLayer) {
  const spans = Array.from(textLayer?.querySelectorAll('span') || []).filter(
    (span) => (span.dataset.unicodeText || span.textContent || '').length > 0
  );
  const indexedSpans = spans.filter((span) => span.hasAttribute('data-text-item-index'));
  return indexedSpans.length ? indexedSpans : spans;
}

export function createViewportTextSpans(textItems, viewport) {
  if (!Array.isArray(textItems) || !viewport) {
    return [];
  }

  return textItems
    .map((item) => {
      const text = String(item?.str || '');
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const x = tx[4];
      const y = tx[5];
      const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
      const expectedWidth = (Number(item?.width) || 0) * viewport.scale;

      if (!text || !fontHeight) {
        return null;
      }

      const left = x;
      const top = y - fontHeight;
      const height = fontHeight;
      const width = expectedWidth;

      if (![left, top, width, height].every(Number.isFinite)) {
        return null;
      }

      return {
        text,
        left: clamp(left, 0, viewport.width),
        top: clamp(top, 0, viewport.height),
        width: clamp(width, MIN_BOX_SIZE, Math.max(viewport.width - left, MIN_BOX_SIZE)),
        height: clamp(height, MIN_BOX_SIZE, Math.max(viewport.height - top, MIN_BOX_SIZE)),
        fontSize: Math.max(height, 8),
        lineHeight: 1,
        itemWidth: Number(item?.width) || 0,
        expectedWidth,
        sourceY: Number(item?.transform?.[5])
      };
    })
    .filter(Boolean);
}

export function countKeywordMatches(documentText, keyword, options = {}) {
  const normalizedKeyword = String(keyword || '').trim();
  const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';

  if (!normalizedKeyword || !Array.isArray(documentText)) {
    return 0;
  }

  let count = 0;

  documentText.forEach((pageData) => {
    const lines = Array.isArray(pageData?.lines) ? pageData.lines : [];

    lines.forEach((line) => {
      count += findHighlightMatchIndexes(String(line || ''), normalizedKeyword, matchMode).length;
    });
  });

  return count;
}

export function calculateHighlightBoxes({
  keyword,
  pageNumber,
  textItems: rawTextItems,
  viewport: rawViewport,
  paddingX = DEFAULT_PADDING_X,
  paddingY = DEFAULT_PADDING_Y,
  matchMode = 'contains'
}) {
  const normalizedKeyword = String(keyword || '').trim();
  const viewport = rawViewport;
  const textItems = createViewportTextSpans(rawTextItems, viewport);

  if (!normalizedKeyword || !Array.isArray(textItems) || !viewport) {
    return [];
  }

  const highlightBoxes = [];

  textItems.forEach((item) => {
    const fullText = String(item?.text || '');

    if (!fullText) {
      return;
    }

    const itemLength = fullText.length;
    const itemWidth = Number(item?.width) || 0;
    const itemHeight = Number(item?.height) || 0;
    const baseX = Number(item?.left) || 0;
    const baseY = Number(item?.top) || 0;

    if (!itemLength || !itemWidth || !itemHeight) {
      return;
    }

    const charWidth = itemWidth / itemLength;
    const matchIndexes = findHighlightMatchIndexes(fullText, normalizedKeyword, matchMode);

    matchIndexes.forEach((foundIndex) => {

      const highlightX = baseX + charWidth * foundIndex;
      const highlightWidth = charWidth * normalizedKeyword.length;
      const rawLeft = highlightX - paddingX;
      const rawTop = baseY - paddingY;
      const rawWidth = highlightWidth + paddingX * 2;
      const rawHeight = itemHeight + paddingY * 2;
      const left = clamp(rawLeft, 0, viewport.width);
      const top = clamp(rawTop, 0, viewport.height);
      const maxWidth = Math.max(viewport.width - left, MIN_BOX_SIZE);
      const maxHeight = Math.max(viewport.height - top, MIN_BOX_SIZE);
      const width = clamp(rawWidth, MIN_BOX_SIZE, maxWidth);
      const height = clamp(rawHeight, MIN_BOX_SIZE, maxHeight);

      if (![left, top, width, height].every(Number.isFinite)) {
        return;
      }

      highlightBoxes.push({
        page: pageNumber,
        text: fullText.slice(foundIndex, foundIndex + normalizedKeyword.length),
        fullText,
        x: left,
        y: top,
        width,
        height
      });

    });
  });

  return highlightBoxes;
}

// DOM Range is the most accurate highlight mechanism, but certain large PDF
// title glyphs have no usable Range rectangles after the browser text-layer
// layout pass. Use the PDF text item's own geometry as a narrow fallback for
// the selected search-result line, rather than highlighting every occurrence
// of the word on the page.
export function calculateFindBoxesFromPdfText({
  keyword,
  pageNumber,
  textItems: rawTextItems,
  viewport,
  lineText,
  lineY,
  matchIndex,
  matchMode = 'contains'
}) {
  const normalizedKeyword = String(keyword || '').trim();
  const normalizedLine = String(lineText || '').replace(/\s+/g, ' ').trim();
  if (!normalizedKeyword || !viewport) return [];
  const spans = createViewportTextSpans(rawTextItems, viewport);
  const matched = spans.filter((item) => (
    findHighlightMatchIndexes(item.text, normalizedKeyword, 'contains').length > 0
  ));
  const numericLineY = Number(lineY);
  const exactLineItems = normalizedLine
    ? matched.filter((item) => item.text.replace(/\s+/g, ' ').trim() === normalizedLine)
    : [];
  const textItems = normalizedLine
    ? matched.filter((item) => lineContainsTargetText(item.text, normalizedLine))
    : [];
  const yItems = Number.isFinite(numericLineY)
    ? matched.filter((item) => Number.isFinite(item.sourceY) && Math.abs(item.sourceY - numericLineY) < 4)
    : [];
  const intersectedItems = textItems.length && yItems.length
    ? textItems.filter((item) => yItems.includes(item))
    : [];
  const hasTargetIdentity = Boolean(normalizedLine) || Number.isFinite(numericLineY) || Number.isFinite(Number(matchIndex));
  const targetItems = exactLineItems.length
    ? exactLineItems
    : intersectedItems.length
      ? intersectedItems
      : textItems.length
        ? textItems
        : yItems.length
          ? yItems
          : hasTargetIdentity ? [] : matched;
  const boxes = [];
  targetItems.forEach((item) => {
    const itemLength = Array.from(item.text).length;
    const charWidth = item.width / Math.max(itemLength, 1);
    const itemMatchIndexes = findHighlightMatchIndexes(item.text, normalizedKeyword, matchMode);
    const targetOccurrence = getTargetOccurrenceIndex(
      normalizedLine || item.text,
      normalizedKeyword,
      matchMode,
      matchIndex
    );
    const selectedIndexes = hasTargetIdentity
      ? (itemMatchIndexes[targetOccurrence] == null ? [] : [itemMatchIndexes[targetOccurrence]])
      : itemMatchIndexes;
    selectedIndexes.forEach((foundIndex) => {
      boxes.push({
        page: pageNumber,
        text: item.text.slice(foundIndex, foundIndex + normalizedKeyword.length),
        fullText: item.text,
        x: clamp(item.left + charWidth * foundIndex - DEFAULT_PADDING_X, 0, viewport.width),
        y: clamp(item.top - DEFAULT_PADDING_Y, 0, viewport.height),
        width: Math.min(viewport.width, charWidth * normalizedKeyword.length + DEFAULT_PADDING_X * 2),
        height: Math.min(viewport.height, item.height + DEFAULT_PADDING_Y * 2)
      });
    });
  });
  return boxes;
}

export function createHighlightBoxesFromTextLayer(pageElement, keyword, options = {}) {
  const boxes = [];
  const normalizedKeyword = String(keyword || '').trim();
  const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';

  if (!pageElement || !normalizedKeyword) {
    return boxes;
  }

  const textLayer = pageElement.querySelector('.textLayer');
  const pageRect = pageElement.getBoundingClientRect();

  console.log('[Highlight] using DOM Range');
  console.log('[Highlight] keyword:', normalizedKeyword);
  console.log('[Highlight] pageRect:', pageRect);

  if (!textLayer) {
    console.log('[Highlight] boxes:', boxes);
    return boxes;
  }

  const spans = getTextLayerContentSpans(textLayer);

  console.log('[Highlight] textLayer spans:', spans.map((span) => span.textContent));

  const lineGroups = buildTextLayerLineGroups(spans);

  console.log(
    '[Highlight] line groups:',
    lineGroups.map((line) => ({
      top: line.top,
      spans: line.spans.map((entry) => entry.text)
    }))
  );

  lineGroups.forEach((lineGroup, lineIndex) => {
    const lineText = lineGroup.text || '';
    console.log('[Highlight] lineText:', lineText);

    const matchIndexes = resolveTargetMatchIndexes(
      lineText,
      lineIndex + 1,
      normalizedKeyword,
      matchMode,
      options
    );
    matchIndexes.forEach((foundIndex) => {
      const endIndex = foundIndex + normalizedKeyword.length;

      console.log('[Highlight] match range:', { foundIndex, endIndex });

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

        const localStart = overlapStart - spanStart;
        const localEnd = overlapEnd - spanStart;
        const range = document.createRange();
        range.setStart(textNode, localStart);
        range.setEnd(textNode, localEnd);

        const rects = Array.from(range.getClientRects());

        console.log('[Highlight] range rects:', rects);

        rects.forEach((rect) => {
          const box = {
            x: rect.left - pageRect.left,
            y: rect.top - pageRect.top,
            width: rect.width,
            height: rect.height
          };

          if ([box.x, box.y, box.width, box.height].every(Number.isFinite)) {
            boxes.push(box);
          }
        });

        range.detach?.();
      });

    });
  });

  console.log('[Highlight] boxes:', boxes);

  return boxes;
}

export function createReplacementPreviewFromTextLayer(pageElement, replaceState) {
  const originalText = String(replaceState?.originalText || '').trim();
  const newText = String(replaceState?.newText ?? '');
  const matchMode = replaceState?.matchMode === 'exact' ? 'exact' : 'contains';
  const selectedTargets = Array.isArray(replaceState?.selectedTargets) ? replaceState.selectedTargets : null;
  const pageNumber = Number(pageElement?.dataset?.pageNumber);

  if (!pageElement || !originalText) {
    return [];
  }

  const textLayer = pageElement.querySelector('.textLayer');

  if (!textLayer) {
    return [];
  }

  const spans = getTextLayerContentSpans(textLayer);
  const lineGroups = buildTextLayerLineGroups(spans);
  const previewItems = [];

  lineGroups.forEach((lineGroup, lineIndex) => {
    const lineText = lineGroup.text || '';
    const matchIndexes = findHighlightMatchIndexes(lineText, originalText, matchMode);
    const resolvedTargets = selectedTargets?.map((target) => {
      const raw = target?.raw || target || {};
      if (Number(raw.pageNumber ?? raw.page) !== pageNumber) return null;
      return {
        target: raw,
        indexes: resolveTargetMatchIndexes(
          lineText,
          lineIndex + 1,
          originalText,
          matchMode,
          raw
        )
      };
    }).filter(Boolean) || null;

    matchIndexes.forEach((foundIndex) => {
      const resolvedTarget = resolvedTargets?.find((entry) => entry.indexes.includes(foundIndex));
      if (selectedTargets && !resolvedTarget) return;
      const endIndex = foundIndex + originalText.length;
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
        const sourceSpan = findSourceSpanForPreview(lineGroup.spans, matchedRects[0]);
        const computedStyle = sourceSpan ? window.getComputedStyle(sourceSpan) : null;
        const minFontScale = Number.parseFloat(textLayer.style.getPropertyValue('--min-font-size')) || 1;
        const sourceFontSize = (Number.parseFloat(computedStyle?.fontSize || '') || lineBox.height) / minFontScale;
        const lineHeight = Math.max(lineBox.height, 1);
        const context = document.createElement('canvas').getContext('2d');
        context.font = `${sourceFontSize}px DocPilotReplacement`;
        const originalMetrics = context.measureText(newText || '한');
        const nextTextX = findNextTextX(lineGroup, endIndex, pageElement);
        const pageRight = parseFloat(pageElement.style.width);
        const cellRight = findCellRight(pageElement, lineBox, Math.min(pageRight, nextTextX ?? pageRight));
        const { maxWidth: availableWidth } = fitReplacementWidth({
          sourceSize: sourceFontSize, measuredWidth: originalMetrics.width,
          startX: lineBox.x, pageRight, nextTextX, cellRight,
          gap: sourceFontSize * 0.08
        });
        // Treat the original matched range as the layout box. Shorter text is
        // centered inside it; longer text is reduced until it fits that same
        // box (and any following text/cell boundary).
        const maxWidth = Math.min(lineBox.width, availableWidth);
        if (maxWidth <= 0) return;
        const fontSize = originalMetrics.width > maxWidth
          ? sourceFontSize * maxWidth / originalMetrics.width
          : sourceFontSize;
        context.font = `${fontSize}px DocPilotReplacement`;
        const metrics = context.measureText(newText || '한');
        const renderedWidth = Math.min(metrics.width, maxWidth);
        const centeredTextX = lineBox.x + Math.max(0, (lineBox.width - renderedWidth) / 2);
        const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
        const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
        const baseline = lineBox.y + (lineHeight - ascent - descent) / 2 + ascent;

        const selectedTarget = resolvedTarget?.target || null;
        const sourceItems = lineGroup.spans.filter(({ span, rect }) => matchedRects.some((matchRect) => (
          rect.left <= matchRect.right && rect.right >= matchRect.left
            && Math.abs(rect.top - matchRect.top) <= 4
        )));
        const sourceFullText = sourceItems.length === 1
          ? (sourceItems[0].span.dataset.unicodeText || sourceItems[0].text)
          : '';
        const sourceTargetMetadata = {
          ...(selectedTarget || {}),
          pageNumber,
          lineNumber: lineIndex + 1,
          matchIndex: foundIndex,
          keyword: selectedTarget?.keyword || originalText,
          sourceText: selectedTarget?.sourceText || selectedTarget?.keyword || originalText,
          // A complete source text object is useful for rewriting a true
          // substring. Do not use the visual *line* as a substitute: many
          // PDFs (including DOCX exports) emit one glyph per text object.
          // Treating that whole line as one object deletes neighbouring words
          // and makes every result on the line compete for the same command.
          sourceFullText: selectedTarget?.sourceFullText || sourceFullText || '',
          textItemIndexes: sourceItems.map(({ span }) => Number(span.dataset.textItemIndex)).filter(Number.isInteger)
        };
        previewItems.push({
          id: `${lineIndex}-${foundIndex}-${newText}`,
          sourceTarget: sourceTargetMetadata,
          cover: {
            x: lineBox.x - REPLACE_PREVIEW_TUNING.coverXExtra,
            y: lineBox.y - REPLACE_PREVIEW_TUNING.coverTopExtra,
            // Keep the cover exactly as wide as the dragged source text.
            // The new glyph may be shorter or longer, but it must not change
            // the area that is cleared from the original page.
            width: lineBox.width + REPLACE_PREVIEW_TUNING.coverXExtra * 2,
            height:
              lineBox.height +
              REPLACE_PREVIEW_TUNING.coverTopExtra +
              REPLACE_PREVIEW_TUNING.coverBottomExtra
          },
          text: {
            x: centeredTextX + REPLACE_PREVIEW_TUNING.xOffset,
            y: lineBox.y + REPLACE_PREVIEW_TUNING.yOffset,
            value: newText,
            fontSize,
            maxWidth,
            lineHeight,
            baseline,
            fontFamily: 'DocPilotReplacement',
            fontWeight: computedStyle?.fontWeight || '400',
            fontStyle: computedStyle?.fontStyle || 'normal',
            letterSpacing: 'normal'
          }
        });
      }

    });
  });

  return previewItems;
}

function buildTextLayerLineGroups(spans) {
  const LINE_Y_TOLERANCE = 5;
  const sourceEntries = spans.map((span) => {
    const rect = span.getBoundingClientRect();
    const source = getSpanPdfSource(span);
    return {
      span,
      rect,
      text: span.dataset.unicodeText || source.unicodeText || source.text || span.textContent || '',
      sourceIndex: Number(source.textItemIndex ?? span.dataset.textItemIndex),
      sourceY: Number(source?.transform?.[5])
    };
  }).filter((entry) => entry.rect.width || entry.rect.height);

  const sourceOrderedEntries = sourceEntries
    .filter((entry) => Number.isInteger(entry.sourceIndex) && Number.isFinite(entry.sourceY))
    .sort((first, second) => first.sourceIndex - second.sourceIndex);

  if (sourceOrderedEntries.length === sourceEntries.length && sourceOrderedEntries.length > 0) {
    const sourceLineGroups = [];
    sourceOrderedEntries.forEach((entry) => {
      const lastLine = sourceLineGroups[sourceLineGroups.length - 1];
      if (lastLine && Math.abs(lastLine.sourceY - entry.sourceY) < 4) {
        lastLine.spans.push(entry);
      } else {
        sourceLineGroups.push({
          top: entry.rect.top,
          sourceY: entry.sourceY,
          spans: [entry]
        });
      }
    });
    sourceLineGroups.forEach((line) => {
      line.text = line.spans.map((entry) => entry.text).join('').replace(/\s+/g, ' ').trim();
    });
    return sourceLineGroups.filter((line) => line.text);
  }

  const lineGroups = [];

  sourceEntries.forEach((entry) => {
    const { rect } = entry;

    const lineGroup = lineGroups.find((line) => Math.abs(rect.top - line.top) <= LINE_Y_TOLERANCE);

    if (lineGroup) {
      lineGroup.spans.push(entry);
      return;
    }

    lineGroups.push({
      top: rect.top,
      spans: [entry]
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
    x: bounds.left - pageRect.left,
    y: bounds.top - pageRect.top,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top
  };
}

function findSourceSpanForPreview(spans, firstRect) {
  if (!firstRect) {
    return null;
  }

  return spans.find(({ rect }) => (
    rect.left - 1 <= firstRect.left &&
    rect.right + 1 >= firstRect.left &&
    Math.abs(rect.top - firstRect.top) <= 3
  ))?.span || null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
