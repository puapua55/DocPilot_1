import * as pdfjsLib from 'pdfjs-dist';

const DEFAULT_PADDING_X = 1;
const DEFAULT_PADDING_Y = 1;
const MIN_BOX_SIZE = 2;
const REPLACE_PREVIEW_TUNING = {
  xOffset: 0,
  yOffset: 3,
  coverTopExtra: 3,
  coverBottomExtra: 5,
  coverXExtra: 2,
  fontSizeRatio: 0.95
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
        expectedWidth
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

export function createHighlightBoxesFromTextLayer(pageElement, keyword, options = {}) {
  const boxes = [];
  const normalizedKeyword = String(keyword || '').trim();
  const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';
  const LINE_Y_TOLERANCE = 5;

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

  const spans = Array.from(textLayer.querySelectorAll('span')).filter(
    (span) => (span.textContent || '').length > 0
  );

  console.log('[Highlight] textLayer spans:', spans.map((span) => span.textContent));

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

  console.log(
    '[Highlight] line groups:',
    lineGroups.map((line) => ({
      top: line.top,
      spans: line.spans.map((entry) => entry.text)
    }))
  );

  lineGroups.forEach((lineGroup) => {
    const lineText = lineGroup.text || '';
    console.log('[Highlight] lineText:', lineText);

    const matchIndexes = findHighlightMatchIndexes(lineText, normalizedKeyword, matchMode);
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

  const spans = Array.from(textLayer.querySelectorAll('span')).filter(
    (span) => (span.textContent || '').length > 0
  );
  const lineGroups = buildTextLayerLineGroups(spans);
  const previewItems = [];

  lineGroups.forEach((lineGroup, lineIndex) => {
    const lineText = lineGroup.text || '';
    const matchIndexes = findHighlightMatchIndexes(lineText, originalText, matchMode);

    matchIndexes.forEach((foundIndex) => {
      if (selectedTargets && !selectedTargets.some((target) => {
        const raw = target?.raw || target || {};
        return Number(raw.pageNumber ?? raw.page) === pageNumber
          && Number(raw.lineNumber ?? raw.line) === lineIndex + 1
          && Number(raw.matchIndex) === foundIndex;
      })) {
        return;
      }
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
        const sourceFontSize = Number.parseFloat(computedStyle?.fontSize || '') || lineBox.height;
        const fontSize = Math.max(sourceFontSize * REPLACE_PREVIEW_TUNING.fontSizeRatio, 8);

        previewItems.push({
          id: `${lineIndex}-${foundIndex}-${newText}`,
          cover: {
            x: lineBox.x - REPLACE_PREVIEW_TUNING.coverXExtra,
            y: lineBox.y - REPLACE_PREVIEW_TUNING.coverTopExtra,
            width: Math.max(
              lineBox.width + REPLACE_PREVIEW_TUNING.coverXExtra * 2,
              estimateReplacementWidth(newText, fontSize)
            ),
            height:
              lineBox.height +
              REPLACE_PREVIEW_TUNING.coverTopExtra +
              REPLACE_PREVIEW_TUNING.coverBottomExtra
          },
          text: {
            x: lineBox.x + REPLACE_PREVIEW_TUNING.xOffset,
            y: lineBox.y + REPLACE_PREVIEW_TUNING.yOffset,
            value: newText,
            fontSize
          }
        });
      }

    });
  });

  return previewItems;
}

function buildTextLayerLineGroups(spans) {
  const LINE_Y_TOLERANCE = 5;
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

function estimateReplacementWidth(text, fontSize) {
  return Math.max(String(text || '').length * fontSize * 0.62, MIN_BOX_SIZE);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
