import * as pdfjsLib from 'pdfjs-dist';

const DEFAULT_PADDING_X = 1;
const DEFAULT_PADDING_Y = 1;
const MIN_BOX_SIZE = 2;

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

export function countKeywordMatches(documentText, keyword) {
  const normalizedKeyword = String(keyword || '').trim().toLowerCase();

  if (!normalizedKeyword || !Array.isArray(documentText)) {
    return 0;
  }

  let count = 0;

  documentText.forEach((pageData) => {
    const lines = Array.isArray(pageData?.lines) ? pageData.lines : [];

    lines.forEach((line) => {
      const normalizedLine = String(line || '').toLowerCase();
      let startIndex = 0;

      while (true) {
        const foundIndex = normalizedLine.indexOf(normalizedKeyword, startIndex);

        if (foundIndex === -1) {
          break;
        }

        count += 1;
        startIndex = foundIndex + normalizedKeyword.length;
      }
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
  paddingY = DEFAULT_PADDING_Y
}) {
  const normalizedKeyword = String(keyword || '').trim();
  const viewport = rawViewport;
  const textItems = createViewportTextSpans(rawTextItems, viewport);

  if (!normalizedKeyword || !Array.isArray(textItems) || !viewport) {
    return [];
  }

  const loweredKeyword = normalizedKeyword.toLowerCase();
  const highlightBoxes = [];

  textItems.forEach((item) => {
    const fullText = String(item?.text || '');

    if (!fullText) {
      return;
    }

    const normalizedText = fullText.toLowerCase();
    const itemLength = fullText.length;
    const itemWidth = Number(item?.width) || 0;
    const itemHeight = Number(item?.height) || 0;
    const baseX = Number(item?.left) || 0;
    const baseY = Number(item?.top) || 0;

    if (!itemLength || !itemWidth || !itemHeight) {
      return;
    }

    const charWidth = itemWidth / itemLength;
    let startIndex = 0;

    while (true) {
      const foundIndex = normalizedText.indexOf(loweredKeyword, startIndex);

      if (foundIndex === -1) {
        break;
      }

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
        startIndex = foundIndex + loweredKeyword.length;
        continue;
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

      startIndex = foundIndex + loweredKeyword.length;
    }
  });

  return highlightBoxes;
}

export function createHighlightBoxesFromTextLayer(pageElement, keyword) {
  const boxes = [];
  const normalizedKeyword = String(keyword || '').trim();
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

  const loweredKeyword = normalizedKeyword.toLowerCase();
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
    const loweredText = lineText.toLowerCase();
    let startIndex = 0;

    console.log('[Highlight] lineText:', lineText);

    while (true) {
      const foundIndex = loweredText.indexOf(loweredKeyword, startIndex);

      if (foundIndex === -1) {
        break;
      }

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

      startIndex = foundIndex + normalizedKeyword.length;
    }
  });

  console.log('[Highlight] boxes:', boxes);

  return boxes;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
