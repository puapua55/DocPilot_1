import { Fragment, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import HighlightLayer from './HighlightLayer';
import PdfTextLayer from './PdfTextLayer';
import { tableBorderDashArray, tableBorderSegments, tableCellAt, tablePaste, tableResizeBoundary, tableSizes, tableStyle, tableVisibleCells } from '../services/pdfTableModel.js';
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

function getPdfLineBaselineOffset(sourceInfo, textContent, viewport, scale, rect, fallbackFontSize) {
  const sourceTransform = sourceInfo?.transform;
  const sourceY = Number(sourceTransform?.[5]);
  if (!Array.isArray(sourceTransform) || !Number.isFinite(sourceY) || !viewport || !rect) return null;

  // A moved/replaced item can have a slightly different baseline from the
  // other glyphs on the same visual line. Use the line's nearby PDF text
  // transforms as a consensus baseline so a second edit does not preserve an
  // earlier overlay's small vertical drift.
  const tolerance = Math.max(2, (Number(fallbackFontSize) || 10) * 0.45);
  const lineBaselines = (Array.isArray(textContent?.items) ? textContent.items : [])
    .filter((item) => typeof item?.str === 'string' && item.str.trim())
    .map((item) => Number(item?.transform?.[5]))
    .filter((y) => Number.isFinite(y) && Math.abs(y - sourceY) <= tolerance)
    .sort((a, b) => a - b);
  const baselineY = lineBaselines.length
    ? lineBaselines[Math.floor(lineBaselines.length / 2)]
    : sourceY;
  const point = viewport.convertToViewportPoint(Number(sourceTransform[4]) || 0, baselineY);
  return Number.isFinite(point?.[1]) ? point[1] / scale - Number(rect.y) : null;
}

function getNearbyLineBaselines(textContent, viewport, scale, movableTexts, pageNumber, movingId) {
  // The text layer is zoomed; movement and PDF export both use unscaled page coordinates.
  const sourceBaselines = (textContent?.items || []).flatMap((item) => {
    if (!String(item?.str || '').trim() || !Number.isFinite(Number(item?.transform?.[4]))
      || !Number.isFinite(Number(item?.transform?.[5]))) return [];
    const point = viewport?.convertToViewportPoint(item.transform[4], item.transform[5]);
    return Number.isFinite(point?.[1]) ? [point[1] / scale] : [];
  });
  const editedBaselines = movableTexts.flatMap((item) => {
    if (item.id === movingId || Number(item.pageNumber) !== Number(pageNumber)) return [];
    const y = Number(item.currentRect?.y);
    const offset = Number(item.baselineOffset);
    return Number.isFinite(y) && Number.isFinite(offset) ? [y + offset] : [];
  });
  const sorted = [...sourceBaselines, ...editedBaselines].filter(Number.isFinite).sort((a, b) => a - b);
  const groups = [];
  sorted.forEach((baseline) => {
    const last = groups[groups.length - 1];
    if (last && Math.abs(baseline - last[last.length - 1]) <= 1.5) last.push(baseline);
    else groups.push([baseline]);
  });
  return groups.map((group) => group[Math.floor(group.length / 2)]);
}

function snapMovedTextToLine(rect, baselineOffset, baselines, maxDistance, pageHeight) {
  const baseline = rect.y + baselineOffset;
  const nearest = baselines.reduce((best, candidate) => (
    Math.abs(candidate - baseline) < Math.abs(best - baseline) ? candidate : best
  ), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(nearest) || Math.abs(nearest - baseline) > maxDistance) return rect;
  return { ...rect, y: Math.min(Math.max(0, nearest - baselineOffset), Math.max(0, pageHeight - rect.height)) };
}

function getHorizontalTextGuides(textContent, viewport, scale, movableTexts, pageNumber, movingId) {
  const rows = [];
  (textContent?.items || []).forEach((item) => {
    const transform = item?.transform;
    const width = Number(item?.width);
    if (!String(item?.str || '').trim() || !Array.isArray(transform) || !Number.isFinite(width) || width <= 0) return;
    const directionLength = Math.hypot(Number(transform[0]) || 0, Number(transform[1]) || 0);
    if (directionLength <= 0) return;
    const start = viewport?.convertToViewportPoint(transform[4], transform[5]);
    const end = viewport?.convertToViewportPoint(
      transform[4] + (transform[0] / directionLength) * width,
      transform[5] + (transform[1] / directionLength) * width
    );
    if (!Number.isFinite(start?.[0]) || !Number.isFinite(start?.[1]) || !Number.isFinite(end?.[0])) return;
    const left = Math.min(start[0], end[0]) / scale;
    const right = Math.max(start[0], end[0]) / scale;
    if (right - left < 1) return;
    const baseline = start[1] / scale;
    let row = rows.find((entry) => Math.abs(entry.baseline - baseline) <= 1.5);
    if (!row) {
      row = { baseline, parts: [] };
      rows.push(row);
    }
    row.parts.push({ left, right, fontSize: directionLength });
  });
  const guides = [];
  rows.forEach((row) => {
    let segment = null;
    row.parts.sort((a, b) => a.left - b.left).forEach((part) => {
      if (segment && part.left - segment.right <= Math.max(6, part.fontSize * 1.5)) {
        segment.right = Math.max(segment.right, part.right);
      } else {
        segment = { left: part.left, right: part.right };
        guides.push(segment);
      }
    });
  });
  movableTexts.forEach((item) => {
    if (item.id === movingId || Number(item.pageNumber) !== Number(pageNumber)) return;
    const rect = item.currentRect;
    if (Number.isFinite(Number(rect?.x)) && Number(rect?.width) > 0) {
      guides.push({ left: Number(rect.x), right: Number(rect.x) + Number(rect.width) });
    }
  });
  return guides.map(({ left, right }) => ({ left, center: (left + right) / 2, right }));
}

function snapMovedTextHorizontally(rect, guides, maxDistance, pageWidth) {
  const anchors = { left: rect.x, center: rect.x + rect.width / 2, right: rect.x + rect.width };
  let correction = 0;
  let distance = maxDistance + 1;
  guides.forEach((guide) => {
    for (const kind of ['left', 'center', 'right']) {
      const delta = guide[kind] - anchors[kind];
      if (Math.abs(delta) < distance) {
        distance = Math.abs(delta);
        correction = delta;
      }
    }
  });
  if (distance > maxDistance) return rect;
  return { ...rect, x: Math.min(Math.max(0, rect.x + correction), Math.max(0, pageWidth - rect.width)) };
}

function snapRectAxis(rect, axis, guides, maxDistance, pageLimit, resize = false) {
  const start = axis === 'x' ? rect.x : rect.y;
  const size = axis === 'x' ? rect.width : rect.height;
  const anchors = resize ? [start + size] : [start, start + size, start + size / 2];
  let correction = 0;
  let nearest = maxDistance + 1;
  guides.forEach((guide) => anchors.forEach((anchor) => {
    const delta = guide - anchor;
    if (Math.abs(delta) < nearest) { nearest = Math.abs(delta); correction = delta; }
  }));
  if (nearest > maxDistance) return rect;
  if (resize) return { ...rect, [axis === 'x' ? 'width' : 'height']: Math.max(24, Math.min(pageLimit - start, size + correction)) };
  return { ...rect, [axis]: Math.max(0, Math.min(pageLimit - size, start + correction)) };
}

function tableAlignmentGuides(textContent, viewport, scale, movableTexts, tables, pageNumber, activeId, pageWidth, pageHeight) {
  const x = [0, pageWidth, pageWidth / 2];
  const y = [0, pageHeight, pageHeight / 2, ...getNearbyLineBaselines(textContent, viewport, scale, movableTexts, pageNumber, null)];
  getHorizontalTextGuides(textContent, viewport, scale, movableTexts, pageNumber, null).forEach((guide) => x.push(guide.left, guide.center, guide.right));
  [...movableTexts, ...tables].forEach((item) => {
    if (item.id === activeId || Number(item.pageNumber) !== Number(pageNumber)) return;
    const rect = item.currentRect;
    if (!rect) return;
    x.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width);
    y.push(rect.y, rect.y + rect.height / 2, rect.y + rect.height);
  });
  return { x: x.filter(Number.isFinite), y: y.filter(Number.isFinite) };
}

function getMovedSourceCoverRects(movableTexts = []) {
  return movableTexts.flatMap((item) => {
    if (item.type === 'addedText') return [];
    // A saved item with no pending edits is already represented in the PDF.
    // It has no live cover in MovableTextLayer, so it should not block text.
    if (item.persistedToPdf && !item.hasChanges) return [];
    const rects = item.persistedToPdf && item.hasChanges
      ? [item.originalRect]
      : (item.coverRects?.length ? item.coverRects : [item.originalRect]);
    const padding = Number.isFinite(Number(item.coverPadding))
      ? Number(item.coverPadding)
      : Math.max(0, Number(item.fontSize || 10) * 0.06);
    return rects
      .filter((rect) => Number.isFinite(Number(rect?.x)) && Number.isFinite(Number(rect?.y))
        && Number(rect?.width) > 0 && Number(rect?.height) > 0)
      .map((rect) => ({
        left: Number(rect.x) - padding,
        top: Number(rect.y) - padding,
        right: Number(rect.x) + Number(rect.width) + padding,
        bottom: Number(rect.y) + Number(rect.height) + padding
      }));
  });
}

function isSpanCoveredByMovedText(span, pageElement, scale, movedSourceRects) {
  if (!movedSourceRects?.length || !pageElement || !Number.isFinite(scale) || scale <= 0) return false;
  const pageRect = pageElement.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  const sourceRects = movedSourceRects.map((rect) => ({
    left: pageRect.left + rect.left * scale,
    top: pageRect.top + rect.top * scale,
    right: pageRect.left + rect.right * scale,
    bottom: pageRect.top + rect.bottom * scale
  }));
  return sourceRects.some((rect) => spanRect.left < rect.right && spanRect.right > rect.left
    && spanRect.top < rect.bottom && spanRect.bottom > rect.top);
}

function rangeIntersectsMovedTextSource(textLayer, range, pageElement, scale, movableTexts = []) {
  if (!textLayer || !range) return false;
  const movedSourceRects = getMovedSourceCoverRects(movableTexts);
  if (!movedSourceRects.length) return false;
  return Array.from(textLayer.querySelectorAll('span[data-text-item-index]')).some((span) => {
    try {
      return range.intersectsNode(span)
        && isSpanCoveredByMovedText(span, pageElement, scale, movedSourceRects);
    } catch {
      return false;
    }
  });
}

function getSelectedTextLayerSpans(textLayer, range, pageElement, scale, movableTexts = []) {
  const movedSourceRects = getMovedSourceCoverRects(movableTexts);
  return Array.from(textLayer.querySelectorAll('span[data-text-item-index]'))
    .filter((span) => {
      try {
        return range.intersectsNode(span)
          && !isSpanCoveredByMovedText(span, pageElement, scale, movedSourceRects);
      } catch {
        return false;
      }
    })
    .sort((a, b) => Number(a.dataset.textItemIndex) - Number(b.dataset.textItemIndex));
}

function sortByVisualTextRows(entries) {
  const rows = [];
  entries.forEach((entry) => {
    const rect = entry.rect || entry.span?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const centerY = (rect.top + rect.bottom) / 2;
    let row = rows.find((candidate) => Math.abs(candidate.centerY - centerY)
      <= Math.max(3, Math.min(candidate.height, rect.height) * 0.7));
    if (!row) {
      row = { centerY, height: rect.height, entries: [] };
      rows.push(row);
    }
    row.entries.push({ ...entry, rect });
    row.centerY = row.entries.reduce((sum, part) => sum + (part.rect.top + part.rect.bottom) / 2, 0) / row.entries.length;
    row.height = Math.max(row.height, rect.height);
  });
  return rows.sort((a, b) => a.centerY - b.centerY)
    .flatMap((row) => row.entries.sort((a, b) => a.rect.left - b.rect.left));
}

function joinVisualTextParts(parts, field) {
  let text = '';
  let previous = null;
  parts.forEach((part) => {
    const value = String(part[field] || '');
    if (!value) return;
    if (previous) {
      const previousCenterY = (previous.rect.top + previous.rect.bottom) / 2;
      const currentCenterY = (part.rect.top + part.rect.bottom) / 2;
      const rowTolerance = Math.max(3, Math.min(previous.rect.height, part.rect.height) * 0.7);
      if (Math.abs(currentCenterY - previousCenterY) > rowTolerance) {
        if (!/\s$/.test(text)) text += '\n';
      } else {
        // PDF.js trims leading spaces from a text item. Recover word spaces
        // from the visual advance gap between adjacent content-stream items.
        const gap = part.rect.left - previous.rect.right;
        const spaceThreshold = Math.max(2.5, Math.min(previous.rect.height, part.rect.height) * 0.24);
        if (gap > spaceThreshold && !/\s$/.test(text) && !/^\s/.test(value)) text += ' ';
      }
    }
    text += value;
    previous = part;
  });
  return text.trim();
}

function getVisualRangeTextSpans(textLayer, range, pageElement, scale, movableTexts = [], dragPoints = null, expandToVisualLines = false) {
  if (!range || !textLayer) return [];
  const hasDragPoints = Number.isFinite(dragPoints?.startX) && Number.isFinite(dragPoints?.startY)
    && Number.isFinite(dragPoints?.endX) && Number.isFinite(dragPoints?.endY);
  const selected = getSelectedTextLayerSpans(textLayer, range, pageElement, scale, movableTexts);
  if (!selected.length && !hasDragPoints) return selected;

  // PDF.js can emit replacement text as a separate text item whose DOM order
  // differs from its visible position. Use the browser's selected visual rows
  // to include such items between the drag endpoints.
  const visualRows = mergeSelectionClientRects(Array.from(range.getClientRects()));
  if (!visualRows.length && !hasDragPoints) return selected;
  const movedSourceRects = getMovedSourceCoverRects(movableTexts);
  const included = new Set(selected);
  const lowY = hasDragPoints ? Math.min(dragPoints.startY, dragPoints.endY) : null;
  const highY = hasDragPoints ? Math.max(dragPoints.startY, dragPoints.endY) : null;
  const dragRows = [];
  if (hasDragPoints) {
    Array.from(textLayer.querySelectorAll('span[data-text-item-index]')).forEach((span) => {
      if (isSpanCoveredByMovedText(span, pageElement, scale, movedSourceRects)) return;
      const rect = span.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const centerY = (rect.top + rect.bottom) / 2;
      if (centerY < lowY - rect.height * 0.6 || centerY > highY + rect.height * 0.6) return;
      // A saved replacement may have a slightly different text-matrix
      // baseline from its neighbours. Group by the visual row with enough
      // tolerance for that baseline drift, while keeping adjacent lines apart.
      let row = dragRows.find((entry) => Math.abs(entry.centerY - centerY) <= Math.max(3, Math.min(entry.height, rect.height) * 0.7));
      if (!row) {
        row = { centerY, height: rect.height, spans: [] };
        dragRows.push(row);
      }
      row.spans.push({ span, rect });
      row.centerY = row.spans.reduce((sum, part) => sum + (part.rect.top + part.rect.bottom) / 2, 0) / row.spans.length;
      row.height = Math.max(row.height, rect.height);
    });
    dragRows.sort((a, b) => a.centerY - b.centerY);
  }
  Array.from(textLayer.querySelectorAll('span[data-text-item-index]')).forEach((span) => {
    if (isSpanCoveredByMovedText(span, pageElement, scale, movedSourceRects)) return;
    const rect = span.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    if (hasDragPoints) {
      const rowIndex = dragRows.findIndex((row) => Math.abs(row.centerY - centerY) <= Math.max(3, Math.min(row.height, rect.height) * 0.7));
      if (rowIndex < 0) return;
      const startIndex = dragRows.reduce((best, entry, index) => (
        Math.abs(entry.centerY - dragPoints.startY) < Math.abs(dragRows[best].centerY - dragPoints.startY) ? index : best
      ), 0);
      const endIndex = dragRows.reduce((best, entry, index) => (
        Math.abs(entry.centerY - dragPoints.endY) < Math.abs(dragRows[best].centerY - dragPoints.endY) ? index : best
      ), 0);
      let inside = false;
      if (expandToVisualLines) {
        // In text-move mode a line is the movable unit. Once a drag touches
        // that visual row, include the complete row even when PDF.js split an
        // edited word into a separate text item or placed it elsewhere in the
        // content stream. This also makes saved-and-reopened PDFs behave like
        // the live replacement overlay.
        inside = rowIndex >= Math.min(startIndex, endIndex) && rowIndex <= Math.max(startIndex, endIndex);
      } else if (startIndex === endIndex) {
        inside = centerX >= Math.min(dragPoints.startX, dragPoints.endX) - 2
          && centerX <= Math.max(dragPoints.startX, dragPoints.endX) + 2;
      } else if (rowIndex === startIndex) {
        inside = dragPoints.endY > dragPoints.startY
          ? centerX >= dragPoints.startX - 2
          : centerX <= dragPoints.startX + 2;
      } else if (rowIndex === endIndex) {
        inside = dragPoints.endY > dragPoints.startY
          ? centerX <= dragPoints.endX + 2
          : centerX >= dragPoints.endX - 2;
      } else {
        inside = true;
      }
      if (inside) included.add(span);
      return;
    }
    if (visualRows.some((row) => centerY >= row.top - 2 && centerY <= row.bottom + 2
      && centerX >= row.left - 2 && centerX <= row.right + 2)) included.add(span);
  });
  return sortByVisualTextRows(Array.from(included).map((span) => ({ span }))).map(({ span }) => span);
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

function buildSelectionFontRuns(parts, range, textContent, scale, useWholeSpans = false) {
  const orderedParts = sortByVisualTextRows(parts.filter((part) => part.span));
  const runs = [];
  let previous = null;
  orderedParts.forEach((part) => {
    const span = part.span;
    const rect = part.rect || span.getBoundingClientRect();
    let text = String(part.text || span.dataset.unicodeText || span.textContent || '');
    if (range && !useWholeSpans) {
      try {
        const clipped = document.createRange();
        clipped.selectNodeContents(span);
        if (span.contains(range.startContainer)) clipped.setStart(range.startContainer, range.startOffset);
        if (span.contains(range.endContainer)) clipped.setEnd(range.endContainer, range.endOffset);
        text = clipped.toString();
      } catch {
        return;
      }
    }
    if (!text) return;

    let separator = '';
    if (previous) {
      const previousRect = previous.rect;
      const previousCenterY = (previousRect.top + previousRect.bottom) / 2;
      const currentCenterY = (rect.top + rect.bottom) / 2;
      const rowTolerance = Math.max(3, Math.min(previousRect.height, rect.height) * 0.7);
      if (Math.abs(currentCenterY - previousCenterY) > rowTolerance) {
        if (!/\s$/.test(previous.text)) separator = '\n';
      } else {
        const gap = rect.left - previousRect.right;
        const spaceThreshold = Math.max(2.5, Math.min(previousRect.height, rect.height) * 0.24);
        if (gap > spaceThreshold && !/\s$/.test(previous.text) && !/^\s/.test(text)) separator = ' ';
      }
    }

    let sourceInfo = null;
    try { sourceInfo = JSON.parse(span.dataset.pdfSource || '{}'); } catch { sourceInfo = null; }
    const index = Number(sourceInfo?.textItemIndex ?? span.dataset.textItemIndex);
    const sourceFont = sourceInfo?.sourceFont || textContent?.fontPreviews?.[index] || {};
    const computedStyle = window.getComputedStyle(span);
    const fontSize = Math.max(1, Number(sourceFont.fontSize)
      || (Number.parseFloat(computedStyle.fontSize) / Math.max(scale, 0.01)) || 10);
    const fontCandidates = collectFontCandidates(sourceFont);
    const run = {
      text: `${separator}${text}`,
      fontCandidates,
      originalFontCandidates: fontCandidates,
      fontFamily: computedStyle.fontFamily || sourceFont.fontFamily || 'DocPilotReplacement',
      originalFontFamily: computedStyle.fontFamily || sourceFont.fontFamily || 'DocPilotReplacement',
      fontSize,
      fontWeight: sourceFont.fontWeight || computedStyle.fontWeight || 'normal',
      fontStyle: sourceFont.fontStyle || computedStyle.fontStyle || 'normal',
      textDecoration: computedStyle.textDecorationLine || 'none',
      color: sourceFont.textColor || computedStyle.color || '#111111',
      preferBoldFont: sourceFont.preferBoldFont === true,
      originalPreferBoldFont: sourceFont.preferBoldFont === true
    };
    const key = JSON.stringify([
      run.fontCandidates,
      run.fontFamily,
      run.fontSize,
      run.fontWeight,
      run.fontStyle,
      run.textDecoration,
      run.color
    ]);
    const last = runs[runs.length - 1];
    if (last?.key === key) last.text += run.text;
    else runs.push({ ...run, key });
    previous = { rect, text };
  });

  const cleanRuns = runs.map(({ key, ...run }) => run);
  const joinedText = cleanRuns.map((run) => run.text).join('').trim();
  return joinedText && cleanRuns.length > 0
    ? { runs: cleanRuns, text: joinedText }
    : null;
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

function getTextSpanSelectionClientRects(range, textLayer, pageElement, scale, movableTexts) {
  if (!range || !textLayer) return [];
  // PDF.js inserts <br> nodes for each hasEOL item. A browser Range includes
  // them in getClientRects() even though they contain no glyphs. On a
  // multi-column page those fragments become the blue bar at the left edge.
  // Collect only actual PDF text spans and preserve partial selection inside
  // the start/end span.
  return getSelectedTextLayerSpans(textLayer, range, pageElement, scale, movableTexts).flatMap((span) => {
    const clipped = document.createRange();
    try {
      clipped.selectNodeContents(span);
      if (span.contains(range.startContainer)) {
        clipped.setStart(range.startContainer, range.startOffset);
      }
      if (span.contains(range.endContainer)) {
        clipped.setEnd(range.endContainer, range.endOffset);
      }
      // A transformed PDF.js span can expose an extra line-box rect at the
      // text-layer origin when a selection crosses multiple lines. Keep only
      // the part that is inside the span's actual painted bounds so that
      // artifact cannot become a blue bar at the page's left edge.
      const spanRect = span.getBoundingClientRect();
      return Array.from(clipped.getClientRects()).map((rect) => {
        const left = Math.max(rect.left, spanRect.left);
        const top = Math.max(rect.top, spanRect.top);
        const right = Math.min(rect.right, spanRect.right);
        const bottom = Math.min(rect.bottom, spanRect.bottom);
        return right > left && bottom > top
          ? new DOMRect(left, top, right - left, bottom - top)
          : null;
      }).filter(Boolean);
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

function getSelectionGeometry(range, pageElement, scale, textLayer, movableTexts) {
  return getSelectionGeometryFromClientRects(
    getTextSpanSelectionClientRects(range, textLayer, pageElement, scale, movableTexts), pageElement, scale
  );
}

function getAreaTextLineGroups(
  textLayer, area, pageElement, scale, movableTexts = [], splitOnWideGaps = false, includeVisibleEdits = false
) {
  if (!textLayer || !area || !pageElement) return [];
  const movedSourceRects = getMovedSourceCoverRects(movableTexts);
  const lines = [];
  Array.from(textLayer.querySelectorAll('span[data-text-item-index]')).forEach((span) => {
    const rect = span.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (isSpanCoveredByMovedText(span, pageElement, scale, movedSourceRects)) return;
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    if (centerX < area.left || centerX > area.right || centerY < area.top || centerY > area.bottom) return;
    const text = span.dataset.unicodeText ?? span.textContent ?? '';
    if (text === '') return;
    const line = lines.find((entry) => Math.abs(entry.centerY - centerY) <= Math.max(3, Math.min(entry.height, rect.height) * 0.7));
    const part = { span, rect, text, sourceText: text };
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
  if (includeVisibleEdits) {
    const pageRect = pageElement.getBoundingClientRect();
    movableTexts.filter((item) => (
      Number(item.pageNumber) === Number(pageElement.dataset.pageNumber)
      && (!item.persistedToPdf || item.hasChanges)
      && item.type === 'replacementText'
      && Math.abs(Number(item.currentRect?.x) - Number(item.originalRect?.x)) <= 0.5
      && Math.abs(Number(item.currentRect?.y) - Number(item.originalRect?.y)) <= 0.5
      && Number.isFinite(Number(item.currentRect?.x))
      && Number.isFinite(Number(item.currentRect?.y))
      && Number(item.currentRect?.width) > 0
    )).forEach((item) => {
      const text = String(item.displayText ?? item.text ?? '').trim();
      const fontSize = Math.max(1, Number(item.fontSize) || 10);
      const baselineOffset = Number.isFinite(Number(item.baselineOffset))
        ? Number(item.baselineOffset) : fontSize * 0.88;
      const x = pageRect.left + Number(item.currentRect.x) * scale;
      const top = pageRect.top + (Number(item.currentRect.y) + baselineOffset - fontSize * 0.88) * scale;
      const width = Number(item.currentRect.width) * scale;
      const height = Math.max(fontSize, Math.min(Number(item.currentRect.height) || fontSize, fontSize * 1.25)) * scale;
      const rect = { left: x, top, right: x + width, bottom: top + height, width, height };
      const centerX = (rect.left + rect.right) / 2;
      const centerY = (rect.top + rect.bottom) / 2;
      if (!text || centerX < area.left || centerX > area.right || centerY < area.top || centerY > area.bottom) return;
      const part = {
        span: null,
        rect,
        text,
        sourceText: String(item.sourceText || item.originalText || item.originalUnicodeText || text).trim(),
        item
      };
      const line = lines.find((entry) => Math.abs(entry.centerY - centerY)
        <= Math.max(3, Math.min(entry.height, rect.height) * 0.7));
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
  }
  return lines.sort((first, second) => first.top - second.top).map((line) => {
    const sortedParts = line.parts.sort((first, second) => first.rect.left - second.rect.left);
    const segments = [];
    sortedParts.forEach((part) => {
      const segment = segments[segments.length - 1];
      const previous = segment?.parts[segment.parts.length - 1];
      const gap = previous ? part.rect.left - previous.rect.right : 0;
      const maxInlineGap = Math.max(24, line.height * 2.8);
      if (!segment || (splitOnWideGaps && gap > maxInlineGap)) segments.push({ parts: [part] });
      else segment.parts.push(part);
    });
    return segments.map(({ parts }) => {
      const geometry = getSelectionGeometryFromClientRects(parts.map((part) => part.rect), pageElement, scale);
      const text = joinVisualTextParts(parts, 'text');
      const sourceText = joinVisualTextParts(parts.map((part) => ({ ...part, sourceText: part.sourceText || part.text })), 'sourceText');
      const supersedesIds = parts.map((part) => part.item?.id).filter(Boolean);
      return geometry && text
        ? { text, sourceText, geometry, parts, supersedesIds, sourceElement: parts.find((part) => part.span)?.span || null }
        : null;
    }).filter(Boolean);
  }).flat();
}

function getOverlayAwareDragLineSelection(range, dragPoints, textLayer, pageElement, scale, movableTexts = [], expandToVisualLines = false) {
  if (!range || !textLayer || !pageElement
    || !Number.isFinite(dragPoints?.startX) || !Number.isFinite(dragPoints?.startY)
    || !Number.isFinite(dragPoints?.endX) || !Number.isFinite(dragPoints?.endY)) return null;
  const left = Math.min(dragPoints.startX, dragPoints.endX);
  const right = Math.max(dragPoints.startX, dragPoints.endX);
  if (right - left < 3) return null;

  const pageNumber = Number(pageElement.dataset.pageNumber);
  const pageRect = pageElement.getBoundingClientRect();
  const spans = getVisualRangeTextSpans(textLayer, range, pageElement, scale, movableTexts, dragPoints, expandToVisualLines);
  if (!spans.length) return null;
  const activeReplacements = movableTexts.filter((item) => (
    Number(item.pageNumber) === pageNumber
    && (!item.persistedToPdf || item.hasChanges)
    && item.type === 'replacementText'
  )).map((item) => {
    const rect = item.currentRect || item.originalRect;
    if (!Number.isFinite(Number(rect?.x)) || !Number.isFinite(Number(rect?.y))
      || Number(rect?.width) <= 0 || Number(rect?.height) <= 0) return null;
    const fontSize = Math.max(1, Number(item.fontSize) || 10);
    const baselineOffset = Number.isFinite(Number(item.baselineOffset))
      ? Number(item.baselineOffset) : fontSize * 0.88;
    const visibleRect = {
      left: pageRect.left + Number(rect.x) * scale,
      top: pageRect.top + (Number(rect.y) + baselineOffset - fontSize * 0.88) * scale,
      width: Number(rect.width) * scale,
      height: Math.max(fontSize, Math.min(Number(rect.height) || fontSize, fontSize * 1.25)) * scale
    };
    visibleRect.right = visibleRect.left + visibleRect.width;
    visibleRect.bottom = visibleRect.top + visibleRect.height;
    visibleRect.centerX = (visibleRect.left + visibleRect.right) / 2;
    visibleRect.centerY = (visibleRect.top + visibleRect.bottom) / 2;
    return { item, rect: visibleRect };
  }).filter(Boolean);

  const parts = spans.map((span) => {
    const rect = span.getBoundingClientRect();
    const text = span.dataset.unicodeText || span.textContent || '';
    return text ? { span, rect, text, sourceText: text } : null;
  }).filter(Boolean);
  activeReplacements.forEach(({ item, rect: overlayRect }) => {
    if (overlayRect.centerX < left - 2 || overlayRect.centerX > right + 2) return;
    const sameLineSpans = spans.filter((span) => {
      const rect = span.getBoundingClientRect();
      const centerY = (rect.top + rect.bottom) / 2;
      return Math.abs(centerY - overlayRect.centerY) <= Math.max(3, Math.min(rect.height, overlayRect.height) * 0.55)
        && (rect.left + rect.right) / 2 >= left - 2
        && (rect.left + rect.right) / 2 <= right + 2;
    });
    if (!sameLineSpans.length) return;

    sameLineSpans.forEach((span) => {
      if (parts.some((part) => part.span === span)) return;
      const rect = span.getBoundingClientRect();
      const text = span.dataset.unicodeText || span.textContent || '';
      if (text) parts.push({ span, rect, text, sourceText: text });
    });
    const text = String(item.displayText ?? item.text ?? '').trim();
    if (text) parts.push({
      span: null,
      rect: overlayRect,
      text,
      sourceText: String(item.sourceText || item.originalText || item.originalUnicodeText || text).trim(),
      item
    });
  });
  // When the PDF was saved and reopened, edited words are plain PDF text
  // spans rather than live overlay objects. Keep a multi-span visual drag as
  // one selection even if the browser's native Range follows content-stream
  // order and would otherwise return only the edited word (or wrong text).
  if (!parts.some((part) => part.item) && parts.filter((part) => part.span).length < 2 && !expandToVisualLines) return null;
  if (parts.some((part) => part.item) && !parts.some((part) => part.span)) return null;

  parts.splice(0, parts.length, ...sortByVisualTextRows(parts));
  const geometry = getSelectionGeometryFromClientRects(parts.map((part) => part.rect), pageElement, scale);
  if (!geometry) return null;
  // The replaced PDF glyph is still hidden by the old overlay's cover. Keep
  // that source cover when the old replacement object is superseded by this
  // combined line object, or the original word would reappear underneath.
  const inheritedCovers = parts.flatMap((part) => part.item
    ? (part.item.coverRects?.length ? part.item.coverRects : [part.item.originalRect])
    : []);
  const coverRects = [...geometry.coverRects, ...inheritedCovers]
    .filter((rect) => Number.isFinite(Number(rect?.x)) && Number.isFinite(Number(rect?.y))
      && Number(rect.width) > 0 && Number(rect.height) > 0);
  return {
    text: joinVisualTextParts(parts, 'text'),
    sourceText: joinVisualTextParts(parts.map((part) => ({ ...part, sourceText: part.sourceText || part.text })), 'sourceText'),
    geometry: { ...geometry, coverRects },
    parts,
    supersedesIds: [...new Set(parts.map((part) => part.item?.id).filter(Boolean))],
    range
  };
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
  textAddMode = false,
  tableAddMode = false,
  textReplaceMode = false,
  areaTextReplaceMode = false,
  editingEnabled = false,
  movableTexts = [],
  imageAttachments = [],
  tables = [],
  removedTables = [],
  selectedTableId = null,
  selectedTableCell = null,
  onCreateTable,
  onSelectTable,
  onSelectTableCell,
  onUpdateTable,
  onDeleteTable,
  onCopyTable,
  selectedMovableTextId = null,
  editingMovableText = null,
  onCreateMovableText,
  onCreateMovableTexts,
  onUpdateMovableTextPreviewFont,
  onMoveMovableText,
  onMoveMovableTextEnd,
  onResizeMovableText,
  onResizeMovableTextEnd,
  onSelectMovableText,
  onBeginEditMovableText,
  onChangeEditMovableText,
  onChangeEditMovableTextStyle,
  onEditSelectionChange,
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
  const [hoveredReplacementLine, setHoveredReplacementLine] = useState(null);
  const moveRef = useRef(null);
  const resizeRef = useRef(null);
  const areaSelectionRef = useRef(null);
  const hoveredReplacementLineKeyRef = useRef('');
  const imageMoveRef = useRef(null);
  const tableMoveRef = useRef(null);
  const textDragRef = useRef(null);
  const suppressReplacementClickRef = useRef(false);
  const handledBatchRequestRef = useRef('');
  const batchSelectionActiveRef = useRef(false);
  const handleTextLayerRendered = useCallback(() => {
    setTextLayerVersion((version) => version + 1);
  }, []);

  const handleTextSelection = useCallback((lineSelection = null) => {
    const isBatchSelection = batchSelectionActiveRef.current;
    const paragraphEditMode = editingEnabled && !textMoveMode;
    // Text Move only repositions an existing movable object. Selecting source
    // PDF text in that mode must never create a new editor/movable object.
    if ((!paragraphEditMode && !textReplaceMode && !isBatchSelection) || !pageRef.current) return;

    const selection = window.getSelection();
    if (!selection || (!lineSelection && selection.rangeCount === 0)) return;

    const range = lineSelection
      ? (lineSelection.range || null)
      : (selection.rangeCount ? selection.getRangeAt(0) : null);
    if (!range && !lineSelection) return;
    const textLayer = pageRef.current.querySelector('.textLayer');
    const commonNode = range && (range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer);
    if (!textLayer || (commonNode && !textLayer.contains(commonNode))) return;
    if (!lineSelection && rangeIntersectsMovedTextSource(textLayer, range, pageRef.current, scale, movableTexts)) {
      selection.removeAllRanges();
      setSelectionBoxes([]);
      return;
    }
    const rangeSpans = !lineSelection
      ? getSelectedTextLayerSpans(textLayer, range, pageRef.current, scale, movableTexts)
      : [];
    const selectedSpans = lineSelection
      ? lineSelection.parts.map((part) => part.span).filter(Boolean)
      : getVisualRangeTextSpans(textLayer, range, pageRef.current, scale, movableTexts, textDragRef.current);
    const selectionText = lineSelection?.text || selection.toString().trim();
    const spanText = selectedSpans.map((span) => span.dataset.unicodeText || span.textContent || '').join('').trim();
    const wholeSpanRange = selectedSpans.length === 1 ? document.createRange() : null;
    if (wholeSpanRange) wholeSpanRange.selectNodeContents(selectedSpans[0]);
    const wholeSpan = selectedSpans.length === 1
      && wholeSpanRange.toString().trim() === selectionText;
    // PDF.js item.str is the authoritative Unicode value for a complete item.
    // For partial/multi-item selections, retain the browser's selected range.
    const selectedText = lineSelection
      ? lineSelection.text
      : (selectedSpans.length > rangeSpans.length
        ? spanText
        : (wholeSpan ? spanText : selectionText)) || spanText;
    const fontRunSelection = buildSelectionFontRuns(
      lineSelection?.parts || selectedSpans.map((span) => ({ span, rect: span.getBoundingClientRect(), text: span.dataset.unicodeText || span.textContent || '' })),
      range,
      textContent,
      scale,
      Boolean(lineSelection || selectedSpans.length > rangeSpans.length)
    );
    // The browser-selected string and the visually reconstructed line can
    // differ only in spaces/newlines. Keep the per-span source font runs in
    // that case; PdfJsViewer reconciles their text to selectedText while
    // retaining each run's font metadata. Falling back to sourceFont here
    // made every mixed-font line inherit the first span's font.
    let fontRuns = !isBatchSelection && fontRunSelection?.runs?.length
      ? fontRunSelection.runs : [];
    const displayText = String(isBatchSelection ? batchReplaceRequest?.newText : selectedText);
    const batchTarget = isBatchSelection
      ? (batchReplaceRequest?.targets || []).find((target) => Number(target?.pageNumber ?? target?.page) === pageNumber) || null
      : null;
    // Do not block a user-selected range because PDF.js exposed unusual
    // Unicode. The export layer will choose direct removal or overlay
    // fallback based on whether the source can be safely identified.
    if (!String(selectedText || '').length) return;

    const geometry = lineSelection?.geometry
      || (selectedSpans.length > rangeSpans.length ? getSelectionGeometryFromClientRects(
        selectedSpans.flatMap((span) => {
          const rect = span.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 ? [rect] : [];
        }), pageRef.current, scale
      ) : getSelectionGeometry(range, pageRef.current, scale, textLayer, movableTexts));
    // Text-move mode does not create selections; it only moves an existing
    // editable object. Replacement selections may use overlay fallback when
    // their source cannot be removed directly from the PDF stream.
    if (!geometry) {
      return;
    }
    const { currentRect, coverRects } = geometry;
    if (currentRect.width < 2 || currentRect.height < 2) return;

    const lineSourceItem = lineSelection?.parts.find((part) => part.item)?.item || null;
    const startElement = lineSelection?.parts.find((part) => part.span)?.span || (range
      ? (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer)
      : null);
    const sourceElement = startElement?.closest('.textLayer span') || startElement;
    const computedStyle = sourceElement ? window.getComputedStyle(sourceElement) : null;
    // Only a complete PDF.js text item provides evidence for the first direct
    // removal implementation. Partial/multi-span selections still use overlay.
    let sourceSelection = null;
    const sourceInfo = sourceElement?.dataset.pdfSource ? JSON.parse(sourceElement.dataset.pdfSource) : null;
    if (sourceElement?.dataset.pdfSource && (lineSelection
      ? selectedSpans.length === 1 && !lineSelection.supersedesIds?.length && Boolean(range)
      : sourceElement.contains(range.endContainer))) {
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
        : Number(lineSourceItem?.fontSize) * scale || currentRect.height * scale * 0.82) / scale
    );
    const sourceBaselineOffset = lineSourceItem?.baselineOffset != null
      && Number.isFinite(Number(lineSourceItem.baselineOffset))
      ? Number(lineSourceItem.baselineOffset)
      : getPdfLineBaselineOffset(sourceInfo, textContent, viewport, scale, currentRect, fontSize);
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
    const resolvedSourceFont = getSelectionSourceFont(sourceInfo, textContent, selectedText)
      || lineSourceItem?.sourceFont || null;
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
    if (!isBatchSelection && !fontRuns.length) {
      fontRuns = [{
        text: String(selectedText),
        fontCandidates,
        originalFontCandidates: fontCandidates,
        fontFamily: computedStyle?.fontFamily || sourceFont?.fontFamily || 'DocPilotReplacement',
        originalFontFamily: computedStyle?.fontFamily || sourceFont?.fontFamily || 'DocPilotReplacement',
        fontSize: Number(sourceFont?.fontSize) || fontSize,
        fontWeight: sourceFontWeight,
        fontStyle: sourceFont?.fontStyle || computedStyle?.fontStyle || 'normal',
        textDecoration: computedStyle?.textDecorationLine || 'none',
        color: sourceFont?.textColor || color,
        preferBoldFont: sourceFont?.preferBoldFont === true,
        originalPreferBoldFont: sourceFont?.preferBoldFont === true
      }];
    }
    // Batch replacements use the source selection width just like a manual
    // text replacement. Measuring the replacement value here made the batch
    // editor grow to the right before the user edited it.
    const measuredText = measureDisplayText(isBatchSelection ? selectedText : displayText, fontSize, {
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
      type: (paragraphEditMode || textReplaceMode || isBatchSelection) ? 'replacementText' : 'movableText',
      pageNumber,
      searchLineNumber: batchTarget?.lineNumber ?? batchTarget?.line ?? null,
      displayText,
      text: displayText,
      // PDF.js can expose a compact source string while browser selection
      // presents layout spaces between glyphs. Retain both representations.
      // Keep layout/source text separately, but use the actual selected word
      // for deletion matching. This prevents a leading space in the PDF text
      // item from turning a text-only selection into a mismatched range.
      sourceText: lineSelection?.sourceText || sourceSelection?.selectedText || selectedText,
      originalText: lineSelection?.sourceText || sourceSelection?.selectedText || selectedText,
      supersedesIds: lineSelection?.supersedesIds || [],
      originalRect: currentRect,
      fitTextWidth: currentRect.width,
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
      // Replacement selections and batch replacements are anchored edits.
      // Text Move can reposition the resulting editable object later.
      allowMove: textMoveMode && !textReplaceMode && !isBatchSelection,
      autoEdit: (paragraphEditMode || textReplaceMode) && !isBatchSelection,
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
      fontRuns,
      originalPreferBoldFont: preferBoldFont,
      glyphText: sourceFont?.glyphText || null,
      originalGlyphText: sourceFont?.glyphText || null,
      originalEncodedText: sourceInfo?.encodedText || null,
      originalUnicodeText: selectedText,
      fontAnalysis: sourceInfo?.sourceFont || null,
      glyphScaleX,
      // Preserve a baseline derived from this source PDF text line. The line
      // consensus also corrects small baseline drift in previously replaced
      // glyphs when they are edited again.
      baselineOffset: Number.isFinite(sourceBaselineOffset)
        ? sourceBaselineOffset
        : (textReplaceMode || isBatchSelection)
          ? Math.max(0, (currentRect.height - fontSize) / 2) + fontSize * 0.88
          : null,
      baselineFromPdfLine: Number.isFinite(sourceBaselineOffset),
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
    return createdTextId || null;
  }, [batchReplaceRequest, editingEnabled, onCreateMovableText, onUpdateMovableTextPreviewFont, pageNumber, pageSize, scale, textContent, textMoveMode, textReplaceMode, viewport]);

  const getReplacementLineAtTarget = useCallback((target) => {
    if ((!editingEnabled && !textReplaceMode && !textMoveMode) || !pageRef.current || !target?.closest) return null;
    const span = target.closest('.textLayer span[data-text-item-index]');
    const movableTextId = target.closest('.movable-text-object[data-movable-text-id]')?.dataset.movableTextId;
    const movableItem = movableTextId ? movableTexts.find((item) => item.id === movableTextId) : null;
    if (!span && !movableItem) return null;
    const textLayer = pageRef.current.querySelector('.textLayer');
    const pageRect = pageRef.current.getBoundingClientRect();
    if (!textLayer) return null;
    const spanRect = span?.getBoundingClientRect();
    const itemFontSize = Math.max(1, Number(movableItem?.fontSize) || 10);
    const itemBaselineOffset = Number.isFinite(Number(movableItem?.baselineOffset))
      ? Number(movableItem.baselineOffset) : itemFontSize * 0.88;
    const itemTop = pageRect.top + (Number(movableItem?.currentRect?.y || 0)
      + itemBaselineOffset - itemFontSize * 0.88) * scale;
    const itemHeight = itemFontSize * 1.25 * scale;
    const centerY = spanRect
      ? (spanRect.top + spanRect.bottom) / 2
      : itemTop + itemHeight / 2;
    if (spanRect && (spanRect.width <= 0 || spanRect.height <= 0)) return null;
    const targetHeight = spanRect?.height || itemHeight;
    const verticalTolerance = Math.max(2, targetHeight * 0.45);
    const groups = getAreaTextLineGroups(textLayer, {
      left: pageRect.left,
      right: pageRect.right,
      top: centerY - verticalTolerance,
      bottom: centerY + verticalTolerance
    }, pageRef.current, scale, movableTexts, true, true);
    return groups.find((line) => (span && line.parts.some((part) => part.span === span))
      || (movableItem && line.parts.some((part) => part.item?.id === movableItem.id))) || null;
  }, [editingEnabled, movableTexts, scale, textMoveMode, textReplaceMode]);

  const handleReplacementLineHover = useCallback((event) => {
    if (textAddMode || tableAddMode || ((!editingEnabled || textMoveMode) && !textReplaceMode)) {
      hoveredReplacementLineKeyRef.current = '';
      setHoveredReplacementLine(null);
      return;
    }
    const line = getReplacementLineAtTarget(event.target);
    if (!line) {
      hoveredReplacementLineKeyRef.current = '';
      setHoveredReplacementLine(null);
      return;
    }
    const bounds = line.geometry.currentRect;
    const key = `${line.text}:${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}`;
    if (key === hoveredReplacementLineKeyRef.current) return;
    hoveredReplacementLineKeyRef.current = key;
    setHoveredReplacementLine(line);
  }, [editingEnabled, getReplacementLineAtTarget, tableAddMode, textAddMode, textMoveMode, textReplaceMode]);

  const clearHoveredReplacementLine = useCallback(() => {
    hoveredReplacementLineKeyRef.current = '';
    setHoveredReplacementLine(null);
  }, []);

  const handleReplacementLineClick = useCallback((event) => {
    if (textAddMode || tableAddMode || ((!editingEnabled || textMoveMode) && !textReplaceMode)) return;
    if (suppressReplacementClickRef.current) {
      const suppressedClick = suppressReplacementClickRef.current;
      suppressReplacementClickRef.current = false;
      const isPostDragClick = Date.now() <= suppressedClick.expiresAt
        && Math.hypot(event.clientX - suppressedClick.x, event.clientY - suppressedClick.y) <= 12;
      if (isPostDragClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (event.target.closest?.('.movable-text-edit-input, .movable-text-format-toolbar, .movable-text-resize-handle, button')) return;
    const existingTextId = event.target.closest?.('.movable-text-object[data-movable-text-id]')?.dataset.movableTextId;
    if (existingTextId) {
      event.preventDefault();
      event.stopPropagation();
      clearHoveredReplacementLine();
      onBeginEditMovableText?.(existingTextId);
      return;
    }
    const line = getReplacementLineAtTarget(event.target);
    if (!line) return;
    event.preventDefault();
    event.stopPropagation();
    const spans = line.parts.map((part) => part.span).filter(Boolean);
    if (!spans.length && !line.parts.some((part) => part.item)) return;
    const orderedSpans = [...spans].sort((first, second) => {
      const relation = first.compareDocumentPosition(second);
      return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1
        : relation & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
    const range = orderedSpans.length ? document.createRange() : null;
    if (orderedSpans.length === 1) range.selectNodeContents(orderedSpans[0]);
    else if (orderedSpans.length > 1) {
      range.setStartBefore(orderedSpans[0]);
      range.setEndAfter(orderedSpans[orderedSpans.length - 1]);
    }
    clearHoveredReplacementLine();
    handleTextSelection({ ...line, range });
  }, [clearHoveredReplacementLine, editingEnabled, getReplacementLineAtTarget, handleTextSelection, onBeginEditMovableText, tableAddMode, textAddMode, textMoveMode, textReplaceMode]);

  const createAreaReplacementItems = useCallback((area) => {
    const pageElement = pageRef.current;
    const textLayer = pageElement?.querySelector('.textLayer');
    if (!pageElement || !textLayer || !textContent) return;
    const groups = getAreaTextLineGroups(textLayer, area, pageElement, scale, movableTexts);
    if (!groups.length) return;

    const selections = groups.map((group, index) => {
      const { text, geometry, sourceElement } = group;
      const { currentRect, coverRects } = geometry;
      const fontRuns = buildSelectionFontRuns(group.parts, null, textContent, scale, true)?.runs || [];
      let sourceInfo = null;
      try { sourceInfo = sourceElement?.dataset.pdfSource ? JSON.parse(sourceElement.dataset.pdfSource) : null; } catch { sourceInfo = null; }
      const computedStyle = sourceElement ? window.getComputedStyle(sourceElement) : null;
      const computedFontSize = Number.parseFloat(computedStyle?.fontSize);
      const fontSize = Math.max(1, (Number.isFinite(computedFontSize) && computedFontSize > 1
        ? computedFontSize : currentRect.height * scale * 0.82) / scale);
      const sourceBaselineOffset = getPdfLineBaselineOffset(sourceInfo, textContent, viewport, scale, currentRect, fontSize);
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
        originalRect: currentRect, fitTextWidth: currentRect.width, displayRect, movedRect: displayRect, currentRect: displayRect, coverRects,
        sourcePageWidth: pageSize.width / scale, sourcePageHeight: pageSize.height / scale,
        backgroundColor, coverPadding: Math.max(1 / scale, fontSize * 0.06), color, renderFontFamily: 'DocPilotReplacement', fontSize,
        fontFamily: computedStyle?.fontFamily || 'Helvetica, Arial, sans-serif', fontWeight: 'normal',
        preferBoldFont, fontStyle: computedStyle?.fontStyle || 'normal', letterSpacing: 0,
        verticalAlign: 'middle', textAlign: 'left', allowMove: false, autoEdit: index === 0,
        forceUnicodeFallback: true, sourceSelection: null, sourceFont: sourceFont || null,
        fontCandidates, originalFontCandidates: fontCandidates, fontRuns, originalPreferBoldFont: preferBoldFont,
        originalGlyphText: sourceFont?.glyphText || null, originalEncodedText: sourceInfo?.encodedText || null,
        fontAnalysis: sourceInfo?.sourceFont || null,
        baselineOffset: Number.isFinite(sourceBaselineOffset)
          ? sourceBaselineOffset : Math.max(0, (currentRect.height - fontSize) / 2) + fontSize * 0.88,
        baselineFromPdfLine: Number.isFinite(sourceBaselineOffset),
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

  const createAddedTextItem = useCallback((area) => {
    const pageElement = pageRef.current;
    if (!pageElement || !pageSize.width || !pageSize.height) return;
    const pageRect = pageElement.getBoundingClientRect();
    const currentRect = {
      x: Math.max(0, (area.left - pageRect.left) / scale),
      y: Math.max(0, (area.top - pageRect.top) / scale),
      width: Math.max(24, (area.right - area.left) / scale),
      height: Math.max(16, (area.bottom - area.top) / scale)
    };
    const fontSize = 12;
    onCreateMovableText?.({
      type: 'addedText',
      pageNumber,
      displayText: '',
      text: '',
      sourceText: '',
      originalText: '',
      originalUnicodeText: '',
      originalRect: currentRect,
      displayRect: currentRect,
      movedRect: currentRect,
      currentRect,
      fitTextWidth: currentRect.width,
      coverRects: [],
      sourcePageWidth: pageSize.width / scale,
      sourcePageHeight: pageSize.height / scale,
      backgroundColor: '#ffffff',
      color: '#111111',
      renderFontFamily: 'Arial, sans-serif',
      fontFamily: 'Arial, sans-serif',
      fontCandidates: [],
      fontRuns: [],
      fontSize,
      fontWeight: 'normal',
      fontStyle: 'normal',
      letterSpacing: 0,
      verticalAlign: 'top',
      baselineOffset: fontSize * 0.88,
      textAlign: 'left',
      allowMove: true,
      autoEdit: true,
      forceUnicodeFallback: true,
      sourceSelection: null,
      coverPadding: 0
    });
  }, [onCreateMovableText, pageNumber, pageSize, scale]);

  const handleAreaSelectionPointerDown = useCallback((event) => {
    if ((!areaTextReplaceMode && !textAddMode && !tableAddMode) || event.button !== 0 || !pageRef.current) return;
    if (event.target.closest?.('.movable-text-object, .movable-text-edit-input, .movable-text-format-toolbar, .pdf-image-attachment, .pdf-table-object, button')) return;
    if (!textAddMode && !tableAddMode && event.target.closest?.('.textLayer span[data-text-item-index]')) return;
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
      const selectedArea = {
        left: active.pageRect.left + box.x, top: active.pageRect.top + box.y,
        right: active.pageRect.left + box.x + box.width, bottom: active.pageRect.top + box.y + box.height
      };
      if (tableAddMode) onCreateTable?.({
        pageNumber,
        sourcePageWidth: pageSize.width / scale,
        sourcePageHeight: pageSize.height / scale,
        currentRect: { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale }
      });
      else if (textAddMode) createAddedTextItem(selectedArea);
      else createAreaReplacementItems(selectedArea);
    };
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish, { once: true });
  }, [areaTextReplaceMode, createAddedTextItem, createAreaReplacementItems, onCreateTable, pageNumber, pageSize, scale, tableAddMode, textAddMode]);

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
      if (rangeIntersectsMovedTextSource(textLayer, range, pageRef.current, scale, movableTexts)) {
        setSelectionBoxes([]);
        return;
      }
      const geometry = getSelectionGeometry(range, pageRef.current, scale, textLayer, movableTexts);
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
      startRect: item.currentRect,
      baselineOffset: Number.isFinite(Number(item.baselineOffset))
        ? Number(item.baselineOffset) : Number(item.fontSize || 10) * 0.88,
      lineBaselines: getNearbyLineBaselines(textContent, viewport, scale, movableTexts, pageNumber, item.id),
      horizontalGuides: getHorizontalTextGuides(textContent, viewport, scale, movableTexts, pageNumber, item.id),
      snapDistance: Math.max(3, Math.min(8, Number(item.fontSize || 10) * 0.55))
    };
  };

  const handleResizeMovableTextPointerDown = (event, item, direction) => {
    if (!editingEnabled || textMoveMode || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectMovableText?.(item.id);
    resizeRef.current = {
      id: item.id,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startRect: item.currentRect,
      minWidth: Math.max(24, Number(item.fontSize || 10) * 2),
      minHeight: Math.max(16, Number(item.fontSize || 10) * 1.2)
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

  const handleTablePointerDown = (event, item, action = 'select') => {
    if (!editingEnabled || event.button !== 0) return;
    event.stopPropagation();
    if (action === 'select') return;
    event.preventDefault();
    event.currentTarget.closest('.pdf-table-object')?.focus();
    onSelectTable?.(item.id);
    tableMoveRef.current = {
      id: item.id, action, startX: event.clientX, startY: event.clientY, startRect: item.currentRect,
      guides: tableAlignmentGuides(textContent, viewport, scale, movableTexts, tables, pageNumber, item.id, pageSize.width / scale, pageSize.height / scale),
      snapDistance: 5 / scale
    };
  };

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (moveRef.current) {
        const { id, startX, startY, startRect, baselineOffset, lineBaselines, horizontalGuides, snapDistance } = moveRef.current;
        const pageWidth = pageSize.width / scale;
        const pageHeight = pageSize.height / scale;
        const draggedRect = {
          ...startRect,
          x: Math.min(Math.max(0, startRect.x + (event.clientX - startX) / scale), Math.max(0, pageWidth - startRect.width)),
          y: Math.min(Math.max(0, startRect.y + (event.clientY - startY) / scale), Math.max(0, pageHeight - startRect.height))
        };
        // Keep the snapped page rect as the preview and the value committed on pointerup.
        const verticallySnapped = snapMovedTextToLine(
          draggedRect, baselineOffset, lineBaselines, snapDistance, pageHeight
        );
        const currentRect = snapMovedTextHorizontally(
          verticallySnapped, horizontalGuides, snapDistance, pageWidth
        );
        moveRef.current.currentRect = currentRect;
        onMoveMovableText?.(id, currentRect);
      }
      if (resizeRef.current) {
        event.preventDefault();
        const active = resizeRef.current;
        const pageWidth = pageSize.width / scale;
        const pageHeight = pageSize.height / scale;
        const dx = (event.clientX - active.startX) / scale;
        const dy = (event.clientY - active.startY) / scale;
        const { x, y, width, height } = active.startRect;
        let left = x;
        let top = y;
        let right = x + width;
        let bottom = y + height;
        if (active.direction.includes('w')) left = Math.max(0, Math.min(right - active.minWidth, x + dx));
        if (active.direction.includes('e')) right = Math.min(pageWidth, Math.max(left + active.minWidth, x + width + dx));
        if (active.direction.includes('n')) top = Math.max(0, Math.min(bottom - active.minHeight, y + dy));
        if (active.direction.includes('s')) bottom = Math.min(pageHeight, Math.max(top + active.minHeight, y + height + dy));
        const currentRect = {
          ...active.startRect,
          x: left,
          y: top,
          width: right - left,
          height: bottom - top
        };
        active.currentRect = currentRect;
        onResizeMovableText?.(active.id, currentRect);
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
      if (tableMoveRef.current) {
        const active = tableMoveRef.current;
        const pageWidth = pageSize.width / scale;
        const pageHeight = pageSize.height / scale;
        const dx = (event.clientX - active.startX) / scale;
        const dy = (event.clientY - active.startY) / scale;
        const draggedRect = active.action === 'resize'
          ? { ...active.startRect,
            width: Math.max(24, Math.min(pageWidth - active.startRect.x, active.startRect.width + dx)),
            height: Math.max(24, Math.min(pageHeight - active.startRect.y, active.startRect.height + dy)) }
          : { ...active.startRect,
            x: Math.max(0, Math.min(pageWidth - active.startRect.width, active.startRect.x + dx)),
            y: Math.max(0, Math.min(pageHeight - active.startRect.height, active.startRect.y + dy)) };
        const resizing = active.action === 'resize';
        const xSnapped = snapRectAxis(draggedRect, 'x', active.guides.x, active.snapDistance, pageWidth, resizing);
        const currentRect = snapRectAxis(xSnapped, 'y', active.guides.y, active.snapDistance, pageHeight, resizing);
        active.currentRect = currentRect;
        onUpdateTable?.(active.id, { currentRect });
      }
    };
    const handlePointerUp = () => {
      if (moveRef.current?.currentRect) {
        onMoveMovableTextEnd?.(moveRef.current.id, moveRef.current.currentRect);
      }
      moveRef.current = null;
      if (resizeRef.current?.currentRect) {
        onResizeMovableTextEnd?.(resizeRef.current.id, resizeRef.current.currentRect);
      }
      resizeRef.current = null;
      if (imageMoveRef.current?.currentRect) onMoveImageEnd?.(imageMoveRef.current.id, imageMoveRef.current.currentRect);
      imageMoveRef.current = null;
      if (tableMoveRef.current?.currentRect) onUpdateTable?.(tableMoveRef.current.id, { currentRect: tableMoveRef.current.currentRect }, true);
      tableMoveRef.current = null;
    };
    const handleKeyDown = (event) => {
      if (!selectedMovableTextId && !selectedImageId && !selectedTableId) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'Escape') {
        onSelectMovableText?.(null);
        onSelectImage?.(null);
        onSelectTable?.(null);
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        if (selectedTableId && tables.some((table) => table.id === selectedTableId)) onDeleteTable?.(selectedTableId);
        else if (selectedImageId) onDeleteImage?.(selectedImageId);
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
  }, [handleTextSelection, onDeleteImage, onDeleteMovableText, onDeleteTable, onMoveImage, onMoveImageEnd, onMoveMovableText, onMoveMovableTextEnd, onResizeMovableText, onResizeMovableTextEnd, onSelectImage, onSelectMovableText, onSelectTable, onUpdateTable, pageSize, scale, selectedImageId, selectedMovableTextId, selectedTableId, tables]);

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

  const handleTextMouseDown = useCallback((event) => {
    if (tableAddMode) return;
    if (event.target.closest?.('.movable-text-edit-input, .movable-text-format-toolbar, .movable-text-resize-handle, button')) {
      textDragRef.current = null;
      return;
    }
    setSelectionBoxes([]);
    if (textReplaceMode && !batchSelectionActiveRef.current) {
      // Text Replace is a hover-and-click action. Prevent native text
      // selection so a downward drag cannot accidentally combine rows.
      if (event.button !== 0) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      textDragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        replacementClick: true
      };
      return;
    }
    textDragRef.current = { startX: event.clientX, startY: event.clientY };
  }, [tableAddMode, textReplaceMode]);

  const handleTextMouseUp = useCallback((event) => {
    if (tableAddMode) return;
    if (textReplaceMode && !batchSelectionActiveRef.current) {
      const gesture = textDragRef.current;
      textDragRef.current = null;
      if (!gesture?.replacementClick) return;
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (distance > 6) {
        suppressReplacementClickRef.current = {
          x: event.clientX,
          y: event.clientY,
          expiresAt: Date.now() + 250
        };
        window.getSelection()?.removeAllRanges();
        setSelectionBoxes([]);
      }
      return;
    }
    textDragRef.current = textDragRef.current
      ? { ...textDragRef.current, endX: event.clientX, endY: event.clientY }
      : null;
    let combinedLine = null;
    if ((textReplaceMode || batchSelectionActiveRef.current) && textDragRef.current) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const textLayer = pageRef.current?.querySelector('.textLayer');
      combinedLine = getOverlayAwareDragLineSelection(
        range, textDragRef.current, textLayer, pageRef.current, scale, movableTexts,
        textReplaceMode || batchSelectionActiveRef.current
      );
    }
    if (textReplaceMode || batchSelectionActiveRef.current) handleTextSelection(combinedLine);
    textDragRef.current = null;
  }, [handleTextSelection, movableTexts, scale, tableAddMode, textReplaceMode]);

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
      className={`pdf-page${editingEnabled || textMoveMode || textReplaceMode ? ' is-text-selection-mode' : ''}${areaTextReplaceMode ? ' is-area-text-selection-mode' : ''}${textAddMode ? ' is-add-text-mode' : ''}${tableAddMode ? ' is-add-table-mode' : ''}`}
      data-page-number={pageNumber}
      onMouseDown={handleTextMouseDown}
      onMouseUp={handleTextMouseUp}
      onMouseMove={handleReplacementLineHover}
      onMouseLeave={clearHoveredReplacementLine}
      onClick={handleReplacementLineClick}
      onPointerDown={handleAreaSelectionPointerDown}
      style={{
        width: pageSize.width ? `${pageSize.width}px` : undefined,
        height: pageSize.height ? `${pageSize.height}px` : undefined,
        minHeight: pageSize.height ? `${pageSize.height}px` : undefined
      }}
    >
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
      {!textAddMode && (textReplaceMode || (editingEnabled && !textMoveMode)) && hoveredReplacementLine ? (
        <HighlightLayer boxes={hoveredReplacementLine.geometry.previewBoxes} width={pageSize.width} height={pageSize.height} color="blue" />
      ) : null}
      <ReplacementPreviewLayer items={replacementPreviewItems} width={pageSize.width} height={pageSize.height} />
      <MovableTextLayer
        items={movableTexts}
        scale={scale}
        selectedId={selectedMovableTextId}
        editingMovableText={editingMovableText}
        textMoveMode={textMoveMode}
        editingEnabled={editingEnabled}
        onPointerDown={handleMovableTextPointerDown}
        onResizePointerDown={handleResizeMovableTextPointerDown}
        onDoubleClick={editingEnabled && !textMoveMode ? onBeginEditMovableText : undefined}
        onEditChange={onChangeEditMovableText}
        onEditStyleChange={onChangeEditMovableTextStyle}
        onEditSelectionChange={onEditSelectionChange}
        onEditCommit={onCommitEditMovableText}
        onEditCancel={onCancelEditMovableText}
      />
      <ImageAttachmentLayer items={imageAttachments} scale={scale} selectedId={selectedImageId} onPointerDown={handleImagePointerDown} />
      <TableLayer items={tables} removedItems={removedTables} scale={scale} selectedId={selectedTableId} selectedCell={selectedTableCell} editingEnabled={editingEnabled} onPointerDown={handleTablePointerDown} onSelect={onSelectTable} onSelectCell={onSelectTableCell} onCopy={onCopyTable} onDelete={onDeleteTable} onUpdate={onUpdateTable} />
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

function tableCellTopPadding(value, style, width, height, size) {
  if (style.verticalAlign === 'top' || !value) return 2;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return 2;
  context.font = `${style.bold ? '700' : '400'} ${size}px 'Noto Sans KR', 'Malgun Gothic', sans-serif`;
  const innerWidth = Math.max(1, width - 8);
  const lines = String(value).split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(context.measureText(line).width / innerWidth)), 0);
  const spare = Math.max(0, height - lines * size * 1.2 - 4);
  return Math.max(2, style.verticalAlign === 'bottom' ? spare : spare / 2);
}

function TableLayer({ items, removedItems = [], scale, selectedId, selectedCell, editingEnabled, onPointerDown, onSelect, onSelectCell, onCopy, onDelete, onUpdate }) {
  const resizeRef = useRef(null);
  const dragRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);
  useEffect(() => {
    if (!contextMenu) return undefined;
    const dismiss = (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.pdf-table-context-menu')) setContextMenu(null);
    };
    const escape = (event) => { if (event.key === 'Escape') setContextMenu(null); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [contextMenu]);
  useEffect(() => {
    const move = (event) => {
      const drag = dragRef.current;
      if (drag) {
        const bounds = drag.element.getBoundingClientRect();
        const horizontal = Math.max(0, Math.min(0.999999, (event.clientX - bounds.left) / bounds.width));
        const vertical = Math.max(0, Math.min(0.999999, (event.clientY - bounds.top) / bounds.height));
        const findTrack = (sizes, position) => {
          let limit = 0;
          return Math.max(0, sizes.findIndex((size) => { limit += size; return position < limit; }));
        };
        const row = findTrack(tableSizes(drag.table.rowHeights, drag.table.rows), vertical);
        const column = findTrack(tableSizes(drag.table.columnWidths, drag.table.columns), horizontal);
        const target = tableCellAt(drag.table, row, column);
        if (target.row !== drag.startRow || target.column !== drag.startColumn) {
          if (!drag.crossed) {
            drag.crossed = true;
            drag.input.blur();
            window.getSelection()?.removeAllRanges();
          }
          event.preventDefault();
          if (target.row !== drag.focusRow || target.column !== drag.focusColumn) {
            drag.focusRow = target.row;
            drag.focusColumn = target.column;
            onSelectCell?.(drag.table.id, target.row, target.column, true);
          }
        }
      }
      const active = resizeRef.current;
      if (!active) return;
      event.preventDefault();
      const delta = (active.axis === 'row' ? event.clientY - active.start : event.clientX - active.start) / scale;
      const next = tableResizeBoundary(active.table, active.axis, active.boundary, delta);
      if (next !== active.table) {
        active.preview = next;
        onUpdate?.(active.table.id, { [active.axis === 'row' ? 'rowHeights' : 'columnWidths']: next[active.axis === 'row' ? 'rowHeights' : 'columnWidths'] });
      }
    };
    const end = () => {
      const active = resizeRef.current;
      if (active?.preview) onUpdate?.(active.table.id, { [active.axis === 'row' ? 'rowHeights' : 'columnWidths']: active.preview[active.axis === 'row' ? 'rowHeights' : 'columnWidths'] }, true);
      resizeRef.current = null;
      if (dragRef.current) onSelect?.(dragRef.current.table.id);
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
  }, [onSelect, onSelectCell, onUpdate, scale]);
  if (!items.length && !removedItems.length) return null;
  return <div className="pdf-table-layer" aria-label="추가한 표">
    {removedItems.map((item) => <div key={`removed-${item.id}`} className="pdf-table-old-cover" style={{ left: `${item.currentRect.x * scale}px`, top: `${item.currentRect.y * scale}px`, width: `${item.currentRect.width * scale}px`, height: `${item.currentRect.height * scale}px` }} />)}
    {items.map((item) => {
      const selected = selectedId === item.id && editingEnabled;
      const columns = tableSizes(item.columnWidths, item.columns);
      const rows = tableSizes(item.rowHeights, item.rows);
      const gridColumns = columns.map((value) => `${value * 100}%`).join(' ');
      const gridRows = rows.map((value) => `${value * 100}%`).join(' ');
      const range = selectedCell?.tableId === item.id ? selectedCell : null;
      return <Fragment key={item.id}>
      {item.persistedToPdf && item.hasChanges && item.savedRect ? <div className="pdf-table-old-cover" style={{ left: `${item.savedRect.x * scale}px`, top: `${item.savedRect.y * scale}px`, width: `${item.savedRect.width * scale}px`, height: `${item.savedRect.height * scale}px` }} /> : null}
      <div className={`pdf-table-object${selected ? ' is-selected' : ''}${item.persistedToPdf ? ' is-baked' : ''}`}
        data-table-id={item.id}
        tabIndex={editingEnabled ? 0 : -1}
        style={{ left: `${item.currentRect.x * scale}px`, top: `${item.currentRect.y * scale}px`, width: `${item.currentRect.width * scale}px`, height: `${item.currentRect.height * scale}px` }}
        onPointerDown={(event) => { onPointerDown?.(event, item); if (event.target === event.currentTarget) event.currentTarget.focus(); }}
        onContextMenu={(event) => {
          if (!editingEnabled) return;
          event.preventDefault();
          event.stopPropagation();
          onSelect?.(item.id);
          setContextMenu({ id: item.id, x: Math.min(event.clientX, window.innerWidth - 150), y: Math.min(event.clientY, window.innerHeight - 95) });
        }}
        onPointerUp={() => onSelect?.(item.id)}>
        {selected ? <div className="pdf-table-move-handle" onPointerDown={(event) => onPointerDown?.(event, item, 'move')}>이동</div> : null}
        {(!item.persistedToPdf || item.hasChanges || selected) ? <div className="pdf-table-grid" style={{ gridTemplateColumns: gridColumns, gridTemplateRows: gridRows, borderColor: item.borderColor }}>
          {tableVisibleCells(item).map((cell) => {
            const style = tableStyle(item.cellStyles?.[cell.index]);
            const cellWidth = columns.slice(cell.column, cell.column + cell.colSpan).reduce((sum, value) => sum + value, 0) * item.currentRect.width * scale;
            const cellHeight = rows.slice(cell.row, cell.row + cell.rowSpan).reduce((sum, value) => sum + value, 0) * item.currentRect.height * scale;
            const fontSize = Math.max(5, (style.fontSize || item.fontSize) * scale);
            const inRange = range && cell.row <= Math.max(range.anchor.row, range.focus.row) && cell.row + cell.rowSpan - 1 >= Math.min(range.anchor.row, range.focus.row)
              && cell.column <= Math.max(range.anchor.column, range.focus.column) && cell.column + cell.colSpan - 1 >= Math.min(range.anchor.column, range.focus.column);
            return <textarea key={cell.index} className={`pdf-table-cell${inRange ? ' is-in-range' : ''}`}
              aria-label={`${cell.row + 1}행 ${cell.column + 1}열`}
              value={item.cells[cell.index] || ''} readOnly={!selected}
              onPointerDown={(event) => {
                event.stopPropagation();
                onPointerDown?.(event, item);
                onSelectCell?.(item.id, cell.row, cell.column, event.shiftKey);
                if (event.button === 0) dragRef.current = { table: item, element: event.currentTarget.closest('.pdf-table-object'), input: event.currentTarget,
                  startRow: cell.row, startColumn: cell.column, focusRow: cell.row, focusColumn: cell.column, crossed: false };
              }}
              onChange={(event) => { const cells = [...item.cells]; cells[cell.index] = event.target.value; onUpdate?.(item.id, { cells }); }}
              onBlur={() => onUpdate?.(item.id, {}, true)}
              onPaste={(event) => { const next = tablePaste(item, cell.row, cell.column, event.clipboardData.getData('text/plain')); if (next) { event.preventDefault(); onUpdate?.(item.id, next, true); } }}
              onKeyDown={(event) => {
                if (event.key !== 'Tab') return;
                event.preventDefault();
                const visible = tableVisibleCells(item);
                const position = visible.findIndex((entry) => entry.index === cell.index);
                const target = visible[position + (event.shiftKey ? -1 : 1)];
                if (target) {
                  onSelectCell?.(item.id, target.row, target.column, false);
                  event.currentTarget.closest('.pdf-table-grid')?.querySelector(`[data-cell-index="${target.index}"]`)?.focus();
                }
              }}
              data-cell-index={cell.index}
              style={{ gridColumn: `${cell.column + 1} / span ${cell.colSpan}`, gridRow: `${cell.row + 1} / span ${cell.rowSpan}`,
                fontSize: `${fontSize}px`, fontWeight: style.bold ? 700 : 400,
                textAlign: style.align, color: style.color, backgroundColor: style.fill || (cell.row === 0 ? item.headerFill : '#ffffff'),
                paddingTop: `${tableCellTopPadding(item.cells[cell.index], style, cellWidth, cellHeight, fontSize)}px` }} />;
          })}
        </div> : null}
        {(!item.persistedToPdf || item.hasChanges || selected) ? <svg className="pdf-table-border-overlay" aria-hidden="true">
          {tableBorderSegments(item).map((edge, index) => {
            const strokeWidth = Math.max(1, edge.width * scale);
            const dashArray = tableBorderDashArray(edge.style, strokeWidth)?.join(' ');
            const double = edge.style === 'double';
            const offsets = double ? [-0.45, 0.45] : [0];
            return <Fragment key={index}>{offsets.map((offset) => {
              const dx = (edge.x2 - edge.x1) * item.currentRect.width * scale;
              const dy = (edge.y2 - edge.y1) * item.currentRect.height * scale;
              const length = Math.hypot(dx, dy) || 1;
              const xOffset = -dy / length * offset * strokeWidth;
              const yOffset = dx / length * offset * strokeWidth;
              return <line key={offset} x1={`${edge.x1 * 100}%`} y1={`${edge.y1 * 100}%`}
                x2={`${edge.x2 * 100}%`} y2={`${edge.y2 * 100}%`}
                transform={`translate(${xOffset} ${yOffset})`}
                stroke={edge.color} strokeWidth={double ? Math.max(0.5, strokeWidth / 3) : strokeWidth}
                strokeDasharray={dashArray} />;
            })}</Fragment>;
          })}
        </svg> : null}
        {selected && columns.slice(0, -1).map((_, index) => <div key={`col-${index}`} className="pdf-table-column-handle" style={{ left: `${columns.slice(0, index + 1).reduce((sum, value) => sum + value, 0) * 100}%` }}
          title="열 너비 조절" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); resizeRef.current = { table: item, axis: 'column', boundary: index + 1, start: event.clientX }; }} />)}
        {selected && rows.slice(0, -1).map((_, index) => <div key={`row-${index}`} className="pdf-table-row-handle" style={{ top: `${rows.slice(0, index + 1).reduce((sum, value) => sum + value, 0) * 100}%` }}
          title="행 높이 조절" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); resizeRef.current = { table: item, axis: 'row', boundary: index + 1, start: event.clientY }; }} />)}
        {selected ? <button type="button" className="pdf-table-resize-handle" aria-label="표 크기 조절" onPointerDown={(event) => onPointerDown?.(event, item, 'resize')} /> : null}
      </div></Fragment>;
    })}
    {contextMenu ? createPortal(<div className="pdf-table-context-menu" role="menu" aria-label="표 메뉴" style={{ left: contextMenu.x, top: contextMenu.y }}>
      <button type="button" role="menuitem" onClick={() => { onCopy?.(contextMenu.id); setContextMenu(null); }}>표 복사</button>
      <button type="button" role="menuitem" onClick={() => { onDelete?.(contextMenu.id); setContextMenu(null); }}>표 삭제</button>
    </div>, document.body) : null}
  </div>;
}
function MovableTextLayer({ items, scale, selectedId, editingMovableText, textMoveMode, editingEnabled, onPointerDown, onResizePointerDown, onDoubleClick, onEditChange, onEditStyleChange, onEditSelectionChange, onEditCommit, onEditCancel }) {
  if (!items.length) return null;

  return (
    <div className={`movable-text-layer${textMoveMode ? ' is-move-mode' : ''}`} aria-hidden="true">
      {items.map((item) => (
        <div key={item.id}>
          {(item.type === 'addedText' || (item.persistedToPdf && !item.hasChanges)
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
            className={`movable-text-object ${selectedId === item.id ? 'is-selected' : ''} ${item.persistedToPdf && !item.hasChanges ? 'is-review-selection' : ''} ${item.type === 'addedText' ? 'is-added-text' : ''}`}
            data-movable-text-id={item.id}
            style={{
              left: `${item.currentRect.x * scale}px`,
              top: `${(
                item.currentRect.y + (
                  Number.isFinite(Number(editingMovableText?.id === item.id ? editingMovableText.baselineOffset : item.baselineOffset))
                    ? Number(editingMovableText?.id === item.id ? editingMovableText.baselineOffset : item.baselineOffset)
                      - Number(editingMovableText?.id === item.id ? editingMovableText.fontSize : item.fontSize) * 0.88
                    : Number(editingMovableText?.id === item.id ? editingMovableText.fontSize : item.fontSize) * 0.02
                )
              ) * scale}px`,
              width: `${item.currentRect.width * scale}px`,
              height: `${item.currentRect.height * scale}px`,
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
              fontWeight: item.fontWeight === 'bold' ? 700 : (item.fontWeight || 'normal'),
              fontStyle: item.fontStyle || 'normal',
              textDecoration: item.textDecoration || 'none',
              letterSpacing: `${(Number(item.letterSpacing) || 0) * scale}px`,
              textAlign: editingMovableText?.id === item.id ? (editingMovableText.textAlign || 'left') : (item.textAlign || 'left'),
              textShadow: 'none'
            }}
            onPointerDown={(event) => onPointerDown(event, item)}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (textMoveMode || event.target.closest?.('.movable-text-resize-handle')) return;
              onDoubleClick?.(item.id);
            }}
          >
            {editingMovableText?.id === item.id ? (
              <div className="movable-text-editor" onPointerDown={(event) => event.stopPropagation()}>
                {item.type === 'addedText' || (Array.isArray(item.fontRuns) && item.fontRuns.length > 0)
                  || (Array.isArray(editingMovableText.fontRuns) && editingMovableText.fontRuns.length > 0) ? (
                  <RichMovableTextEditor
                    editing={editingMovableText}
                    item={item}
                    scale={scale}
                    onChange={onEditChange}
                    onSelectionChange={onEditSelectionChange}
                    onCommit={onEditCommit}
                    onCancel={onEditCancel}
                  />
                ) : (
                  <input
                    className="movable-text-edit-input"
                    value={editingMovableText.value}
                    style={{
                      fontFamily: item.renderFontFamily || 'DocPilotReplacement',
                      fontWeight: editingMovableText.fontWeight === 'bold' ? 700 : (editingMovableText.fontWeight || 'normal'),
                      fontStyle: editingMovableText.fontStyle || 'normal',
                      textDecoration: editingMovableText.textDecoration || 'none',
                      color: editingMovableText.color || '#111111',
                      letterSpacing: `${Number(editingMovableText.letterSpacing) || 0}px`,
                      textAlign: editingMovableText.textAlign || 'left',
                      textShadow: 'none'
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
                )}
              </div>
            ) : (item.persistedToPdf && !item.hasChanges ? null : (
              Array.isArray(item.fontRuns) && item.fontRuns.length > 0
                ? item.fontRuns.map((run, index) => (
                  <span
                    key={`${item.id}-font-run-${index}`}
                    style={{
                      fontFamily: item.selectedFontFamily
                        ? (item.renderFontFamily || 'DocPilotReplacement')
                        : (run.fontFamily || item.renderFontFamily || 'DocPilotReplacement'),
                      fontSize: `${Math.max(1, Number(run.fontSize || item.fontSize) || 10)
                        * (Number(item.fontSize) || 10) / Math.max(1, Number(item.autoFitBaseFontSize || item.fontSize) || 10) * scale}px`,
                      fontWeight: run.fontWeight === 'bold' ? '700' : (run.fontWeight || 'normal'),
                      fontStyle: run.fontStyle || 'normal',
                      lineHeight: 'normal',
                      textDecoration: run.textDecoration || item.textDecoration || 'none',
                      color: run.color || item.color,
                      letterSpacing: `${Number(item.letterSpacing || run.letterSpacing) * scale}px`,
                      whiteSpace: item.type === 'addedText' ? 'pre-wrap' : 'pre'
                    }}
                  >
                    {run.text}
                  </span>
                ))
                : (item.displayText || item.text)
            ))}
            {editingEnabled && !textMoveMode && selectedId === item.id
              ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((direction) => (
                <span
                  key={direction}
                  className={`movable-text-resize-handle is-${direction}`}
                  data-resize-direction={direction}
                  onPointerDown={(event) => onResizePointerDown?.(event, item, direction)}
                />
              ))
              : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function readEditableFontRuns(root, baseRuns) {
  const collected = [];
  const append = (text, baseIndex, overrides = {}) => {
    if (!text) return;
    const base = baseRuns[baseIndex] || baseRuns[0] || {};
    const run = { ...base, ...overrides, sourceRunIndex: base.sourceRunIndex ?? baseIndex, text };
    const key = JSON.stringify([
      baseIndex, run.fontCandidates, run.fontFamily, run.fontSize, run.fontWeight,
      run.fontStyle, run.textDecoration, run.color, run.selectedFontFamily
    ]);
    const last = collected[collected.length - 1];
    if (last?.key === key) last.text += text;
    else collected.push({ ...run, key });
  };
  const visit = (node, baseIndex = 0, overrides = {}) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.nodeValue || '', baseIndex, overrides);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') {
      append('\n', baseIndex, overrides);
      return;
    }
    const index = Number.isInteger(Number(node.dataset?.fontRunIndex))
      ? Number(node.dataset.fontRunIndex) : baseIndex;
    const next = { ...overrides };
    if (node.tagName === 'B' || node.tagName === 'STRONG') next.fontWeight = 'bold';
    if (node.tagName === 'I' || node.tagName === 'EM') next.fontStyle = 'italic';
    if (node.tagName === 'U') next.textDecoration = 'underline';
    if (node.style?.fontFamily) next.fontFamily = node.style.fontFamily;
    if (node.style?.fontWeight) next.fontWeight = node.style.fontWeight;
    if (node.style?.fontStyle) next.fontStyle = node.style.fontStyle;
    if (node.style?.textDecoration) next.textDecoration = node.style.textDecoration;
    if (node.style?.color) next.color = node.style.color;
    Array.from(node.childNodes).forEach((child) => visit(child, index, next));
  };
  Array.from(root.childNodes).forEach((child) => visit(child));
  return collected.map(({ key, ...run }) => run);
}

function restoreEditableSelection(root, savedRange) {
  if (!savedRange || !Number.isFinite(savedRange.start) || !Number.isFinite(savedRange.end)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  const locate = (target) => {
    let consumed = 0;
    for (const node of textNodes) {
      const length = node.nodeValue?.length || 0;
      if (target <= consumed + length) return { node, offset: target - consumed };
      consumed += length;
    }
    const last = textNodes[textNodes.length - 1];
    return last ? { node: last, offset: last.nodeValue?.length || 0 } : { node: root, offset: 0 };
  };
  const first = locate(savedRange.start);
  const last = locate(savedRange.end);
  const range = document.createRange();
  range.setStart(first.node, Math.min(first.offset, first.node.nodeType === Node.TEXT_NODE ? first.node.nodeValue.length : 0));
  range.setEnd(last.node, Math.min(last.offset, last.node.nodeType === Node.TEXT_NODE ? last.node.nodeValue.length : 0));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function RichMovableTextEditor({ editing, item, scale, onChange, onSelectionChange, onCommit, onCancel }) {
  const editorRef = useRef(null);
  const baseRunsRef = useRef([]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.replaceChildren();
    const runs = editing.fontRuns || [];
    baseRunsRef.current = runs.map((run, index) => ({ ...run, sourceRunIndex: run.sourceRunIndex ?? index }));
    const sizeRatio = Number(editing.fontSize || item.fontSize || 10)
      / Math.max(1, Number(item.autoFitBaseFontSize || item.fontSize) || 10);
    runs.forEach((run, index) => {
      const span = document.createElement('span');
      span.dataset.fontRunIndex = String(index);
      span.textContent = String(run.text || '');
      span.style.fontFamily = item.selectedFontFamily
        ? (item.renderFontFamily || 'DocPilotReplacement')
        : (run.fontFamily || item.renderFontFamily || 'DocPilotReplacement');
      span.style.fontSize = `${Math.max(1, Number(run.fontSize || item.fontSize || 10) * sizeRatio * scale)}px`;
      span.style.fontWeight = run.fontWeight === 'bold' ? '700' : (run.fontWeight || 'normal');
      span.style.fontStyle = run.fontStyle || 'normal';
      span.style.lineHeight = 'normal';
      span.style.textDecoration = run.textDecoration || editing.textDecoration || 'none';
      span.style.color = run.color || editing.color || '#111111';
      editor.append(span);
    });
    const hadEditorFocus = editor.contains(document.activeElement);
    const isNewEditor = editor.dataset.editingId !== String(editing.id);
    editor.dataset.editingId = String(editing.id);
    if (isNewEditor || hadEditorFocus || document.activeElement === document.body) editor.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    restoreEditableSelection(editor, editing.selectionRange);
    const restoredSelection = window.getSelection();
    if (restoredSelection?.rangeCount && editor.contains(restoredSelection.anchorNode)
      && (restoredSelection.isCollapsed || editor.contains(restoredSelection.focusNode))) {
      const range = restoredSelection.getRangeAt(0);
      const before = range.cloneRange();
      before.selectNodeContents(editor);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      onSelectionChange?.({ start, end: start + range.toString().length });
    }
  }, [editing.id, editing.fontRunsRevision]);

  const reportSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount || !editor.contains(selection.anchorNode)
      || (!selection.isCollapsed && !editor.contains(selection.focusNode))) return;
    const range = selection.getRangeAt(0);
    const before = range.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    onSelectionChange?.({ start, end: start + range.toString().length });
  };

  const handleInput = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const fontRuns = readEditableFontRuns(editor, baseRunsRef.current);
    const value = fontRuns.map((run) => run.text).join('');
    onChange?.(value, fontRuns);
  };

  return (
    <div
      ref={editorRef}
      className="movable-text-edit-input movable-text-edit-rich"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={item.type === 'addedText' ? 'true' : 'false'}
      aria-label="혼합 글꼴 PDF 텍스트 편집"
      spellCheck={false}
      onInput={handleInput}
      onMouseUp={reportSelection}
      onKeyUp={reportSelection}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (item.type === 'addedText' && !event.ctrlKey && !event.metaKey) {
            document.execCommand('insertLineBreak');
            handleInput();
          } else {
            onCommit?.();
          }
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel?.();
        } else if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          document.execCommand(event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : 'underline');
          handleInput();
        }
      }}
      onBlur={() => {
        window.setTimeout(() => {
          if (!document.activeElement?.closest?.('.pdf-text-edit-toolbar')) onCommit?.();
        }, 0);
      }}
    />
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
