import { jsPDF } from 'jspdf';
import * as pdfjsLib from 'pdfjs-dist';
import { loadPdfDocument } from './pdfService';
import { isPdfFile } from '../utils/fileUtils';

console.log('========== [ConvertTrace] pdfHtmlStructureService.js loaded ==========');

const PDF_OPS = pdfjsLib?.OPS ?? {};
const PDF_UTIL = pdfjsLib?.Util ?? null;
const OP_CODES = {
  setLineWidth: PDF_OPS.setLineWidth ?? 2,
  moveTo: PDF_OPS.moveTo ?? 13,
  lineTo: PDF_OPS.lineTo ?? 14,
  closePath: PDF_OPS.closePath ?? 18,
  rectangle: PDF_OPS.rectangle ?? 19,
  stroke: PDF_OPS.stroke ?? 20,
  closeStroke: PDF_OPS.closeStroke ?? 21,
  fill: PDF_OPS.fill ?? 22,
  eoFill: PDF_OPS.eoFill ?? 23,
  fillStroke: PDF_OPS.fillStroke ?? 24,
  eoFillStroke: PDF_OPS.eoFillStroke ?? 25,
  closeFillStroke: PDF_OPS.closeFillStroke ?? 26,
  closeEOFillStroke: PDF_OPS.closeEOFillStroke ?? 27,
  endPath: PDF_OPS.endPath ?? 29,
  constructPath: PDF_OPS.constructPath ?? 91,
  paintFormXObjectBegin: PDF_OPS.paintFormXObjectBegin ?? 74,
  paintFormXObjectEnd: PDF_OPS.paintFormXObjectEnd ?? 75,
  paintImageXObject: PDF_OPS.paintImageXObject ?? 85,
  paintInlineImageXObject: PDF_OPS.paintInlineImageXObject ?? 86
};
const DRAW_OPS = {
  moveTo: 0,
  lineTo: 1,
  curveTo: 2,
  quadraticCurveTo: 3,
  closePath: 4,
  rectangle: PDF_OPS.rectangle ?? 19
};

const LINE_TOLERANCE = 1.2;
const MIN_LINE_LENGTH = 4;
const EDGE_MARGIN = 3;
const RIGHT_EDGE_ARTIFACT_TOLERANCE = 2;
const LINE_DEDUPE_TOLERANCE = 0.7;
const MAX_CONSTRUCT_PATH_DEBUG_LOGS = 5;
const LINE_TEXT_Y_TOLERANCE = 3;
const TEXT_MERGE_GAP_RATIO = 0.65;
const TEXT_BASELINE_RATIO = 0.85;
const TEXT_CANVAS_SCALE = 3;
const DEBUG_TEXT_DRAW = false;
const STROKE_OPERATIONS = new Set([
  OP_CODES.stroke,
  OP_CODES.closeStroke,
  OP_CODES.fillStroke,
  OP_CODES.eoFillStroke,
  OP_CODES.closeFillStroke,
  OP_CODES.closeEOFillStroke,
  OP_CODES.fill,
  OP_CODES.eoFill,
  OP_CODES.endPath
].filter((value) => typeof value === 'number'));
const KOREAN_FONT_FILE = 'NotoSansKR-Regular.ttf';
const KOREAN_FONT_NAME = 'NotoSansKR';
let koreanFontRegistrationAttempted = false;
let koreanFontRegistered = false;

function round(value, precision = 3) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function normalizeExtractedPdfFont(fontName, styleInfo) {
  const raw = [
    fontName,
    styleInfo?.fontFamily,
    styleInfo?.fontSubstitution,
    styleInfo?.loadedName
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    raw.includes('malgun') ||
    raw.includes('gothic') ||
    raw.includes('맑은') ||
    raw.includes('malgun gothic')
  ) {
    return {
      cssFontFamily: 'Malgun Gothic',
      pdfFontName: 'MalgunGothic',
      dataFontFamily: 'MalgunGothic',
      sourceFontName: fontName || ''
    };
  }

  if (
    raw.includes('noto') ||
    raw.includes('noto sans kr') ||
    raw.includes('notosanskr')
  ) {
    return {
      cssFontFamily: 'Noto Sans KR',
      pdfFontName: 'NotoSansKR',
      dataFontFamily: 'NotoSansKR',
      sourceFontName: fontName || ''
    };
  }

  return {
    cssFontFamily: 'Malgun Gothic',
    pdfFontName: 'MalgunGothic',
    dataFontFamily: 'MalgunGothic',
    sourceFontName: fontName || ''
  };
}

function normalizePdfFontName(fontName) {
  return normalizeExtractedPdfFont(fontName, null);
}

function getViewportPoint(viewport, x, y) {
  if (!viewport || typeof viewport.convertToViewportPoint !== 'function') {
    return {
      x: round(x),
      y: round(y)
    };
  }

  const [viewX, viewY] = viewport.convertToViewportPoint(x, y);

  return {
    x: round(viewX),
    y: round(viewY)
  };
}

function toArrayLike(value) {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return Array.from(value);
  }

  if (typeof value.length === 'number') {
    try {
      return Array.from(value);
    } catch (error) {
      console.warn('[LineExtract] failed to convert array-like value:', value, error);
      return null;
    }
  }

  return null;
}

function createOpsNameMap(opsObject) {
  const map = {};

  Object.entries(opsObject || {}).forEach(([name, value]) => {
    map[value] = name;
  });

  Object.entries(OP_CODES).forEach(([name, value]) => {
    if (typeof value === 'number' && !map[value]) {
      map[value] = name;
    }
  });

  return map;
}

function createPathOpsNameMap() {
  return {
    [DRAW_OPS.moveTo]: 'moveTo',
    [DRAW_OPS.lineTo]: 'lineTo',
    [DRAW_OPS.closePath]: 'closePath',
    [DRAW_OPS.rectangle]: 'rectangle'
  };
}

function parseConstructPathArgs(args) {
  if (!Array.isArray(args)) {
    console.warn('[LineExtract] constructPath args is not array:', args);
    return null;
  }

  // pdfjs-dist v6 uses constructPath(paintOp, data, minMax), where data[0]
  // is a flat DrawOPS stream: [moveTo, x, y, lineTo, x, y, ...].
  if (typeof args[0] === 'number' && Array.isArray(args[1])) {
    const flatPathData = toArrayLike(args[1]?.[0] ?? args[1]);

    if (flatPathData) {
      return {
        kind: 'flatDrawOps',
        paintOp: args[0],
        pathData: flatPathData,
        minMax: args[2] ?? null
      };
    }
  }

  const pathOps = toArrayLike(args[0]);
  const pathArgs = toArrayLike(args[1]);

  if (!pathOps || !pathArgs) {
    console.warn('[LineExtract] invalid constructPath args');
    console.warn({
      args: args,
      arg0: args[0],
      arg1: args[1],
      arg0Type: Object.prototype.toString.call(args[0]),
      arg1Type: Object.prototype.toString.call(args[1]),
      isArg0Array: Array.isArray(args[0]),
      isArg1Array: Array.isArray(args[1]),
      isArg0TypedArray: ArrayBuffer.isView(args[0]),
      isArg1TypedArray: ArrayBuffer.isView(args[1])
    });
    return null;
  }

  return {
    kind: 'splitOps',
    pathOps,
    pathArgs
  };
}

function normalizeLine(rawLine) {
  if (!rawLine) {
    return null;
  }

  const values = [rawLine.x1, rawLine.y1, rawLine.x2, rawLine.y2];

  if (values.some((value) => typeof value !== 'number' || Number.isNaN(value))) {
    console.warn('[HtmlStructure] skip invalid line:', rawLine);
    return null;
  }

  const isHorizontal = Math.abs(rawLine.y1 - rawLine.y2) <= LINE_TOLERANCE;
  const isVertical = Math.abs(rawLine.x1 - rawLine.x2) <= LINE_TOLERANCE;

  if (!isHorizontal && !isVertical) {
    return null;
  }

  const x = Math.min(rawLine.x1, rawLine.x2);
  const y = Math.min(rawLine.y1, rawLine.y2);
  const width = Math.abs(rawLine.x2 - rawLine.x1);
  const height = Math.abs(rawLine.y2 - rawLine.y1);
  const length = Math.max(width, height);

  if (length < MIN_LINE_LENGTH) {
    return null;
  }

  return {
    type: isHorizontal ? 'h' : 'v',
    x1: round(rawLine.x1),
    y1: round(rawLine.y1),
    x2: round(rawLine.x2),
    y2: round(rawLine.y2),
    x: round(x),
    y: round(y),
    width: round(isHorizontal ? width : Math.max(rawLine.lineWidth || 0.5, 0.5)),
    height: round(isVertical ? height : Math.max(rawLine.lineWidth || 0.5, 0.5)),
    lineWidth: round(rawLine.lineWidth || 0.5),
    color: rawLine.color || '#000000'
  };
}

function isConnectedToHorizontalLine(verticalLine, horizontalLines) {
  return horizontalLines.some((horizontalLine) => {
    const touchesX =
      Math.abs(verticalLine.x - horizontalLine.x) <= LINE_TOLERANCE ||
      Math.abs(verticalLine.x - (horizontalLine.x + horizontalLine.width)) <= LINE_TOLERANCE;
    const overlapsY =
      verticalLine.y <= horizontalLine.y + LINE_TOLERANCE &&
      verticalLine.y + verticalLine.height >= horizontalLine.y - LINE_TOLERANCE;

    return touchesX && overlapsY;
  });
}

function isNearText(line, texts) {
  if (!texts.length) {
    return true;
  }

  const textBounds = texts.reduce(
    (bounds, text) => ({
      minX: Math.min(bounds.minX, text.x),
      maxX: Math.max(bounds.maxX, text.x + text.width),
      minY: Math.min(bounds.minY, text.y),
      maxY: Math.max(bounds.maxY, text.y + text.height)
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );

  const marginX = 80;
  const marginY = 60;

  return (
    line.x + line.width >= textBounds.minX - marginX &&
    line.x <= textBounds.maxX + marginX &&
    line.y + line.height >= textBounds.minY - marginY &&
    line.y <= textBounds.maxY + marginY
  );
}

export function filterTableLines(lines, pageWidth, pageHeight, texts) {
  const normalizedLines = (Array.isArray(lines) ? lines : [])
    .map((line) => normalizeLine(line))
    .filter((line) => !isPageEdgeArtifactLine(line, pageWidth, pageHeight))
    .filter(Boolean);
  const horizontalLines = normalizedLines.filter((line) => line.type === 'h');

  const filteredLines = normalizedLines.filter((line) => {
    if (line.type === 'v' && line.x <= EDGE_MARGIN) {
      return false;
    }

    if (line.type === 'h' && line.width >= pageWidth - EDGE_MARGIN * 2) {
      return false;
    }

    if (line.type === 'v' && line.height >= pageHeight * 0.85) {
      return false;
    }

    if (line.type === 'v') {
      return isNearText(line, texts) || isConnectedToHorizontalLine(line, horizontalLines);
    }

    return isNearText(line, texts);
  });

  return dedupeLines(filteredLines);
}

export function isPageEdgeArtifactLine(line, pageWidth, pageHeight) {
  const x = Number(line?.x ?? line?.left);
  const width = Number(line?.width);
  const height = Number(line?.height);
  const isVertical = line?.type === 'v' || (height > width && height > 1);

  if (!isVertical) {
    return false;
  }

  if (x >= pageWidth - RIGHT_EDGE_ARTIFACT_TOLERANCE) {
    console.warn('[LineFilter] removed artifact line:', {
      line,
      pageWidth,
      pageHeight,
      reason: 'right-page-edge'
    });
    return true;
  }

  if (x < 0 || x > pageWidth) {
    console.warn('[LineFilter] removed artifact line:', {
      line,
      pageWidth,
      pageHeight,
      reason: 'out-of-page'
    });
    return true;
  }

  return false;
}

function dedupeLines(lines) {
  const result = [];

  (Array.isArray(lines) ? lines : []).forEach((line) => {
    const duplicated = result.some((existing) => (
      existing.type === line.type &&
      Math.abs(existing.x - line.x) <= LINE_DEDUPE_TOLERANCE &&
      Math.abs(existing.y - line.y) <= LINE_DEDUPE_TOLERANCE &&
      Math.abs(existing.width - line.width) <= LINE_DEDUPE_TOLERANCE &&
      Math.abs(existing.height - line.height) <= LINE_DEDUPE_TOLERANCE
    ));

    if (!duplicated) {
      result.push(line);
    }
  });

  return result;
}

function extractTexts(textItems, viewport, styles = {}) {
  if (!PDF_UTIL?.transform) {
    console.warn('[HtmlStructure] pdfjs Util.transform is not available');
    return [];
  }

  return textItems
    .map((item, index) => {
      const text = String(item?.str ?? '');

      if (!text.trim() || !Array.isArray(item.transform)) {
        return null;
      }

      const tx = PDF_UTIL.transform(viewport.transform, item.transform);
      const fontSize = Math.hypot(tx[2], tx[3]) || item.height || 12;
      const height = item.height || fontSize;
      const width = item.width || text.length * fontSize * 0.55;
      const x = tx[4];
      const y = tx[5] - height;
      const styleInfo = styles?.[item.fontName];
      const fontInfo = normalizeExtractedPdfFont(item.fontName, styleInfo);

      console.log('[PdfFontExtract] item fontName:', item.fontName);
      console.log('[PdfFontExtract] styles:', styleInfo);
      console.log('[PdfFontExtract] source font:', {
        itemFontName: item.fontName,
        styleInfo,
        normalized: fontInfo
      });

      return {
        id: `text-${index}`,
        text,
        x: round(x),
        y: round(y),
        width: round(width),
        height: round(height),
        fontSize: round(fontSize),
        fontFamily: fontInfo.dataFontFamily,
        normalizedFont: fontInfo,
        sourceFontName: fontInfo.sourceFontName
      };
    })
    .filter(Boolean);
}

function mergeTextItemsIntoLineTexts(texts) {
  const sortedTexts = [...(Array.isArray(texts) ? texts : [])].sort((a, b) => {
    if (Math.abs((a?.y ?? 0) - (b?.y ?? 0)) > LINE_TEXT_Y_TOLERANCE) {
      return (a?.y ?? 0) - (b?.y ?? 0);
    }

    return (a?.x ?? 0) - (b?.x ?? 0);
  });
  const lines = [];

  sortedTexts.forEach((item) => {
    const existingLine = lines.find((line) => Math.abs(line.y - (item?.y ?? 0)) <= LINE_TEXT_Y_TOLERANCE);

    if (existingLine) {
      existingLine.items.push(item);
      existingLine.y = Math.min(existingLine.y, item?.y ?? existingLine.y);
      return;
    }

    lines.push({
      y: item?.y ?? 0,
      items: [item]
    });
  });

  return lines.flatMap((line, lineIndex) => {
    const sortedItems = [...line.items].sort((a, b) => (a?.x ?? 0) - (b?.x ?? 0));
    const groups = [];

    sortedItems.forEach((item) => {
      const lastGroup = groups[groups.length - 1];

      if (!lastGroup) {
        groups.push([item]);
        return;
      }

      const previousItem = lastGroup[lastGroup.length - 1];
      const previousRight = (previousItem?.x ?? 0) + (previousItem?.width ?? 0);
      const gap = (item?.x ?? 0) - previousRight;
      const threshold = Math.max(
        2,
        Math.min(previousItem?.fontSize || 10, item?.fontSize || 10) * TEXT_MERGE_GAP_RATIO
      );

      if (gap <= threshold) {
        lastGroup.push(item);
        return;
      }

      groups.push([item]);
    });

    return groups.map((items, groupIndex) => {
      const text = items.map((item) => item?.text ?? '').join('');
      const x = Math.min(...items.map((item) => item?.x ?? 0));
      const y = Math.min(...items.map((item) => item?.y ?? 0));
      const right = Math.max(...items.map((item) => (item?.x ?? 0) + (item?.width ?? 0)));
      const bottom = Math.max(
        ...items.map((item) => (item?.y ?? 0) + (item?.height || item?.fontSize || 10))
      );
      const fontSize = Math.max(...items.map((item) => item?.fontSize || 10));
      const representativeItem = items.find((item) => item?.fontFamily) || items[0] || {};
      const fontFamily = representativeItem.fontFamily || 'MalgunGothic';
      const normalizedFont = representativeItem.normalizedFont || normalizePdfFontName(fontFamily);

      return {
        id: `merged-text-${lineIndex}-${groupIndex}`,
        text,
        x: round(x),
        y: round(y),
        width: round(right - x),
        height: round(bottom - y),
        fontSize: round(fontSize),
        fontFamily,
        normalizedFont,
        sourceFontName: representativeItem.sourceFontName || normalizedFont.sourceFontName || '',
        sourceItems: items
      };
    });
  });
}

function extractRawLinesFromConstructPath(pathOps, pathArgs, viewport, currentLineWidth, pathOpsNameMap) {
  const rawLines = [];
  let argIndex = 0;
  let currentX = null;
  let currentY = null;
  let startX = null;
  let startY = null;

  pathOps.forEach((op) => {
    if (op === DRAW_OPS.moveTo || op === PDF_OPS.moveTo) {
      const x = pathArgs[argIndex++];
      const y = pathArgs[argIndex++];

      currentX = x;
      currentY = y;
      startX = x;
      startY = y;
      return;
    }

    if (op === DRAW_OPS.lineTo || op === PDF_OPS.lineTo) {
      const x = pathArgs[argIndex++];
      const y = pathArgs[argIndex++];

      if (currentX !== null && currentY !== null) {
        const from = getViewportPoint(viewport, currentX, currentY);
        const to = getViewportPoint(viewport, x, y);
        rawLines.push({
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          lineWidth: currentLineWidth || 0.5
        });
      }

      currentX = x;
      currentY = y;
      return;
    }

    if (op === DRAW_OPS.rectangle || op === PDF_OPS.rectangle) {
      const x = pathArgs[argIndex++];
      const y = pathArgs[argIndex++];
      const width = pathArgs[argIndex++];
      const height = pathArgs[argIndex++];

      const p1 = getViewportPoint(viewport, x, y);
      const p2 = getViewportPoint(viewport, x + width, y);
      const p3 = getViewportPoint(viewport, x + width, y + height);
      const p4 = getViewportPoint(viewport, x, y + height);

      rawLines.push(
        { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, lineWidth: currentLineWidth || 0.5 },
        { x1: p2.x, y1: p2.y, x2: p3.x, y2: p3.y, lineWidth: currentLineWidth || 0.5 },
        { x1: p3.x, y1: p3.y, x2: p4.x, y2: p4.y, lineWidth: currentLineWidth || 0.5 },
        { x1: p4.x, y1: p4.y, x2: p1.x, y2: p1.y, lineWidth: currentLineWidth || 0.5 }
      );

      currentX = x;
      currentY = y;
      startX = x;
      startY = y;
      return;
    }

    if (op === DRAW_OPS.closePath || op === PDF_OPS.closePath) {
      if (currentX !== null && currentY !== null && startX !== null && startY !== null) {
        const from = getViewportPoint(viewport, currentX, currentY);
        const to = getViewportPoint(viewport, startX, startY);
        rawLines.push({
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          lineWidth: currentLineWidth || 0.5
        });
      }
      return;
    }

    console.log('[LineExtract] unhandled path op:', {
      op,
      name: pathOpsNameMap?.[op] || `UNKNOWN_PATH_${op}`
    });
  });

  return rawLines;
}

function extractRawLinesFromFlatDrawOps(pathData, viewport, currentLineWidth, pathOpsNameMap) {
  const rawLines = [];
  let index = 0;
  let currentX = null;
  let currentY = null;
  let startX = null;
  let startY = null;

  const pushLine = (fromX, fromY, toX, toY) => {
    if ([fromX, fromY, toX, toY].some((value) => typeof value !== 'number' || Number.isNaN(value))) {
      return;
    }

    const from = getViewportPoint(viewport, fromX, fromY);
    const to = getViewportPoint(viewport, toX, toY);

    rawLines.push({
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      lineWidth: currentLineWidth || 0.5
    });
  };

  while (index < pathData.length) {
    const op = pathData[index];
    index += 1;

    if (op === DRAW_OPS.moveTo) {
      const x = pathData[index];
      const y = pathData[index + 1];
      index += 2;
      currentX = x;
      currentY = y;
      startX = x;
      startY = y;
      continue;
    }

    if (op === DRAW_OPS.lineTo) {
      const x = pathData[index];
      const y = pathData[index + 1];
      index += 2;

      if (typeof currentX === 'number' && typeof currentY === 'number') {
        pushLine(currentX, currentY, x, y);
      }

      currentX = x;
      currentY = y;
      continue;
    }

    if (op === DRAW_OPS.curveTo) {
      currentX = pathData[index + 4];
      currentY = pathData[index + 5];
      index += 6;
      continue;
    }

    if (op === DRAW_OPS.quadraticCurveTo) {
      currentX = pathData[index + 2];
      currentY = pathData[index + 3];
      index += 4;
      continue;
    }

    if (op === DRAW_OPS.closePath) {
      if (
        typeof currentX === 'number' &&
        typeof currentY === 'number' &&
        typeof startX === 'number' &&
        typeof startY === 'number'
      ) {
        pushLine(currentX, currentY, startX, startY);
      }
      continue;
    }

    console.log('[LineExtract] unhandled flat draw op:', {
      op,
      name: pathOpsNameMap?.[op] || `UNKNOWN_DRAW_${op}`,
      index: index - 1
    });
  }

  return rawLines;
}

function extractLinesFromOperatorList(operatorList, viewport, opsNameMap) {
  if (!operatorList || !Array.isArray(operatorList.fnArray) || !Array.isArray(operatorList.argsArray)) {
    console.warn('[HtmlStructure] skip invalid operatorList:', operatorList);
    return [];
  }

  const lines = [];
  let currentLineWidth = 0.5;
  let constructPathLogCount = 0;
  const pathOpsNameMap = createPathOpsNameMap();
  let directCurrentX = null;
  let directCurrentY = null;
  let directStartX = null;
  let directStartY = null;

  const pushDirectLine = (fromX, fromY, toX, toY) => {
    if ([fromX, fromY, toX, toY].some((value) => typeof value !== 'number' || Number.isNaN(value))) {
      return;
    }

    const from = getViewportPoint(viewport, fromX, fromY);
    const to = getViewportPoint(viewport, toX, toY);

    lines.push({
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      lineWidth: currentLineWidth || 0.5
    });
  };

  operatorList.fnArray.forEach((fn, index) => {
    const args = operatorList.argsArray[index];

    if (fn === OP_CODES.setLineWidth) {
      const normalizedArgs = toArrayLike(args);
      const lineWidthArg = normalizedArgs?.[0] ?? null;
      if (typeof lineWidthArg === 'number' && Number.isFinite(lineWidthArg)) {
        currentLineWidth = lineWidthArg;
      }
      return;
    }

    if (fn === OP_CODES.moveTo) {
      const normalizedArgs = toArrayLike(args);
      const x = normalizedArgs?.[0];
      const y = normalizedArgs?.[1];

      if (typeof x === 'number' && typeof y === 'number') {
        directCurrentX = x;
        directCurrentY = y;
        directStartX = x;
        directStartY = y;
      }
      return;
    }

    if (fn === OP_CODES.lineTo) {
      const normalizedArgs = toArrayLike(args);
      const x = normalizedArgs?.[0];
      const y = normalizedArgs?.[1];

      if (
        typeof x === 'number' &&
        typeof y === 'number' &&
        typeof directCurrentX === 'number' &&
        typeof directCurrentY === 'number'
      ) {
        pushDirectLine(directCurrentX, directCurrentY, x, y);
        directCurrentX = x;
        directCurrentY = y;
      }
      return;
    }

    if (fn === OP_CODES.rectangle) {
      const normalizedArgs = toArrayLike(args);
      const x = normalizedArgs?.[0];
      const y = normalizedArgs?.[1];
      const width = normalizedArgs?.[2];
      const height = normalizedArgs?.[3];

      if ([x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
        pushDirectLine(x, y, x + width, y);
        pushDirectLine(x + width, y, x + width, y + height);
        pushDirectLine(x + width, y + height, x, y + height);
        pushDirectLine(x, y + height, x, y);
        directCurrentX = x;
        directCurrentY = y;
        directStartX = x;
        directStartY = y;
      }
      return;
    }

    if (fn === OP_CODES.closePath) {
      if (
        typeof directCurrentX === 'number' &&
        typeof directCurrentY === 'number' &&
        typeof directStartX === 'number' &&
        typeof directStartY === 'number'
      ) {
        pushDirectLine(directCurrentX, directCurrentY, directStartX, directStartY);
      }
      return;
    }

    if (STROKE_OPERATIONS.has(fn)) {
      directCurrentX = null;
      directCurrentY = null;
      directStartX = null;
      directStartY = null;
    }

    if (fn !== OP_CODES.constructPath) {
      return;
    }

    if (constructPathLogCount < MAX_CONSTRUCT_PATH_DEBUG_LOGS) {
      console.log('[LineDebug] constructPath args raw:', args);
      console.log('[LineDebug] constructPath args type:', {
        argsIsArray: Array.isArray(args),
        arg0: args?.[0],
        arg1: args?.[1],
        arg0Type: Object.prototype.toString.call(args?.[0]),
        arg1Type: Object.prototype.toString.call(args?.[1]),
        arg0IsArray: Array.isArray(args?.[0]),
        arg1IsArray: Array.isArray(args?.[1]),
        arg0IsTypedArray: ArrayBuffer.isView(args?.[0]),
        arg1IsTypedArray: ArrayBuffer.isView(args?.[1]),
        arg0Length: args?.[0]?.length,
        arg1Length: args?.[1]?.length
      });
      constructPathLogCount += 1;
    }

    const parsedPath = parseConstructPathArgs(args);

    if (!parsedPath) {
      return;
    }

    if (parsedPath.kind === 'flatDrawOps') {
      const flatOpNames = parsedPath.pathData
        .filter((_, dataIndex) => dataIndex === 0 || Number.isInteger(parsedPath.pathData[dataIndex - 1]))
        .slice(0, 20)
        .map((op) => pathOpsNameMap?.[op] || `UNKNOWN_DRAW_${op}`);

      console.log('[LineDebug] constructPath paint op:', opsNameMap?.[parsedPath.paintOp] || parsedPath.paintOp);
      console.log('[LineDebug] flat path data:', parsedPath.pathData);
      console.log('[LineDebug] flat path op names sample:', flatOpNames);

      const rawLines = extractRawLinesFromFlatDrawOps(
        parsedPath.pathData,
        viewport,
        currentLineWidth,
        pathOpsNameMap
      );
      lines.push(...rawLines);
      return;
    }

    const { pathOps: ops, pathArgs: coordinates } = parsedPath;
    const pathOpNames = ops.map((op) => pathOpsNameMap?.[op] || opsNameMap?.[op] || `UNKNOWN_PATH_${op}`);

    console.log('[LineDebug] pathOps:', ops);
    console.log('[LineDebug] pathOpNames:', pathOpNames);
    console.log('[LineDebug] pathArgs:', coordinates);

    const rawLines = extractRawLinesFromConstructPath(
      ops,
      coordinates,
      viewport,
      currentLineWidth,
      pathOpsNameMap
    );
    lines.push(...rawLines);
  });

  return lines;
}

async function extractLinesFromPdfPage(page, viewport, texts = []) {
  console.log('========== [ConvertTrace] extractLinesFromPdfPage 실행됨 ==========');
  console.log('[ConvertTrace] viewport:', {
    width: viewport?.width,
    height: viewport?.height
  });
  console.log('[ConvertTrace] texts count:', texts?.length);

  try {
    const opList = await page.getOperatorList();
    const opsNameMap = createOpsNameMap(PDF_OPS);
    const opSummary = {};

    (opList.fnArray || []).forEach((fn) => {
      const name = opsNameMap[fn] || `UNKNOWN_${fn}`;
      opSummary[name] = (opSummary[name] || 0) + 1;
    });

    console.log('[LineDebug] fnArray length:', opList.fnArray?.length);
    console.log('[LineDebug] argsArray length:', opList.argsArray?.length);
    console.log('[LineDebug] operator summary:', opSummary);
    console.log('[LineDebug] OPS.constructPath:', OP_CODES.constructPath);
    console.log('[LineDebug] OPS.moveTo:', OP_CODES.moveTo);
    console.log('[LineDebug] OPS.lineTo:', OP_CODES.lineTo);
    console.log('[LineDebug] OPS.rectangle:', OP_CODES.rectangle);
    console.log('[LineDebug] OPS.stroke:', OP_CODES.stroke);
    console.log('[LineDebug] OPS.setLineWidth:', OP_CODES.setLineWidth);

    const rawLines = extractLinesFromOperatorList(opList, viewport, opsNameMap);
    const normalizedLines = (Array.isArray(rawLines) ? rawLines : [])
      .map((line) => normalizeLine(line))
      .filter(Boolean);
    const filteredLines = filterTableLines(normalizedLines, viewport.width, viewport.height, texts);

    console.log('[LineDebug] rawLines count:', rawLines.length);
    console.log('[LineDebug] rawLines:', rawLines);
    console.log('[LineDebug] normalizedLines count:', normalizedLines.length);
    console.log('[LineDebug] normalizedLines:', normalizedLines);
    console.log('[LineDebug] filteredLines count:', filteredLines.length);
    console.log('[LineDebug] filteredLines:', filteredLines);

    const hasPathOperators = Boolean(
      opSummary.constructPath ||
        opSummary.moveTo ||
        opSummary.lineTo ||
        opSummary.rectangle ||
        opSummary.rawFillPath
    );
    const hasImageOperators = Boolean(
      opSummary.paintImageXObject ||
        opSummary.paintInlineImageXObject ||
        opSummary.paintImageXObjectRepeat ||
        opSummary.paintInlineImageXObjectGroup
    );
    const hasFormOperators = Boolean(opSummary.paintFormXObjectBegin || opSummary.paintFormXObjectEnd);
    const diagnostics = {
      operatorSummary: opSummary,
      hasPathOperators,
      hasImageOperators,
      hasFormOperators,
      rawLineCount: rawLines.length,
      normalizedLineCount: normalizedLines.length,
      filteredLineCount: filteredLines.length,
      reason: getLineExtractionReason({
        hasPathOperators,
        hasImageOperators,
        hasFormOperators,
        rawLineCount: rawLines.length,
        normalizedLineCount: normalizedLines.length,
        filteredLineCount: filteredLines.length
      })
    };

    console.log('[LineDebug] diagnostics:', diagnostics);

    if (filteredLines.length === 0 && normalizedLines.length > 0) {
      console.warn('[LineDebug] filter removed all lines. fallback to normalizedLines');
      return {
        lines: normalizedLines,
        diagnostics: {
          ...diagnostics,
          usedFallback: true,
          filteredLineCount: normalizedLines.length,
          reason: ''
        }
      };
    }

    return {
      lines: Array.isArray(filteredLines) ? filteredLines : [],
      diagnostics
    };
  } catch (error) {
    console.warn('[HtmlStructure] failed to extract lines from page:', error);
    console.warn('[HtmlStructure] line extraction failed, continue with texts only');
    return {
      lines: [],
      diagnostics: {
        operatorSummary: {},
        hasPathOperators: false,
        hasImageOperators: false,
        hasFormOperators: false,
        rawLineCount: 0,
        normalizedLineCount: 0,
        filteredLineCount: 0,
        reason: `line 추출 중 예외가 발생했습니다: ${error?.message || String(error)}`
      }
    };
  }
}

function getLineExtractionReason({
  hasPathOperators,
  hasImageOperators,
  hasFormOperators,
  rawLineCount,
  normalizedLineCount,
  filteredLineCount
}) {
  if (filteredLineCount > 0) {
    return '';
  }

  if (!hasPathOperators) {
    if (hasImageOperators || hasFormOperators) {
      return 'PDF.js operatorList에 표 선 path가 직접 노출되지 않았습니다. 표 선이 이미지 또는 Form XObject 내부에 있을 가능성이 큽니다.';
    }

    return 'PDF.js operatorList에 moveTo/lineTo/rectangle/constructPath 선 그리기 연산이 없습니다.';
  }

  if (rawLineCount === 0) {
    return '선 path 연산은 있지만 path 데이터에서 수평/수직 선분을 만들지 못했습니다.';
  }

  if (normalizedLineCount === 0) {
    return 'raw line은 추출됐지만 수평/수직 선 또는 최소 길이 조건을 통과하지 못했습니다.';
  }

  return 'line 필터링 단계에서 모든 선이 제거되었습니다.';
}

export async function extractPdfToHtmlStructure(file) {
  console.log('========== [ConvertTrace] extractPdfToHtmlStructure 실행됨 ==========');
  console.log('[ConvertTrace] file:', file?.name);

  if (!file || !isPdfFile(file)) {
    throw new Error('PDF 파일을 먼저 선택해주세요.');
  }

  const { pdf } = await loadPdfDocument(file);
  if (!pdf || typeof pdf.numPages !== 'number') {
    throw new Error('PDF 문서를 불러오지 못했습니다.');
  }

  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const rawTexts = extractTexts(textContent.items || [], viewport, textContent.styles || {});
    const mergedTexts = mergeTextItemsIntoLineTexts(rawTexts);

    console.log('========== [ConvertTrace] line 추출 호출 직전 ==========');
    console.log('[ConvertTrace] pageNumber:', pageNumber);
    const lineResult = await extractLinesFromPdfPage(page, viewport, mergedTexts);
    const lines = Array.isArray(lineResult?.lines) ? lineResult.lines : [];
    const lineDiagnostics = lineResult?.diagnostics ?? null;
    console.log('========== [ConvertTrace] line 추출 호출 후 ==========');
    console.log('[ConvertTrace] lines:', lines);
    console.log('[ConvertTrace] lines count:', lines?.length);
    console.log('[ConvertTrace] line diagnostics:', lineDiagnostics);

    console.log('[HtmlStructure] page:', pageNumber);
    console.log('[HtmlStructure] page size:', {
      width: viewport.width,
      height: viewport.height
    });
    console.log('[HtmlStructure] raw text items:', textContent.items || []);
    console.log('[HtmlStructure] extracted texts:', rawTexts);
    rawTexts.forEach((textItem, index) => {
      console.log('[HtmlStructure] text item:', index, {
        text: textItem.text,
        x: textItem.x,
        y: textItem.y,
        fontSize: textItem.fontSize,
        width: textItem.width,
        height: textItem.height
      });
    });
    console.log('[HtmlStructure] raw text count:', rawTexts.length);
    console.log('[HtmlStructure] merged text count:', mergedTexts.length);
    console.log('[HtmlStructure] merged texts:', mergedTexts);
    console.log('[HtmlStructure] extracted texts count:', mergedTexts.length);
    console.log('[HtmlStructure] extracted lines count:', lines.length);

    pages.push({
      pageNumber,
      width: round(viewport.width),
      height: round(viewport.height),
      texts: Array.isArray(mergedTexts) ? mergedTexts : [],
      lines: Array.isArray(lines) ? lines : [],
      lineDiagnostics
    });
  }

  return {
    fileName: file.name,
    pageCount: pdf.numPages,
    pages: Array.isArray(pages) ? pages : [],
    html: buildHtmlFromStructure({ pages })
  };
}

export function replaceTextInHtmlStructure(htmlStructure, originalText, newText) {
  const target = String(originalText ?? '');

  if (!target) {
    return htmlStructure;
  }

  const replacement = String(newText ?? '');
  let replacementCount = 0;
  console.log('[HtmlStructure] replace target:', {
    originalText: target,
    newText: replacement
  });
  const pages = htmlStructure.pages.map((page) => ({
    ...page,
    texts: page.texts.map((textItem) => ({
      ...textItem,
      text: replaceLoggedText(textItem.text, target, replacement, () => {
        replacementCount += 1;
      })
    }))
  }));

  return {
    ...htmlStructure,
    pages,
    html: buildHtmlFromStructure({ pages }),
    replacementCount
  };
}

export { mergeTextItemsIntoLineTexts };

export function applyTextObjectsToHtmlStructure(htmlStructure, textObjects = []) {
  if (!Array.isArray(textObjects) || textObjects.length === 0) {
    return htmlStructure;
  }

  const pages = htmlStructure.pages.map((page) => {
    const pageObjects = textObjects.filter((object) => object.pageNumber === page.pageNumber);
    const texts = [...page.texts];

    pageObjects.forEach((object) => {
      const matchIndex = texts.findIndex((textItem) => (
        textItem.text === object.originalText &&
        Math.abs(textItem.x - object.originalX) <= 2 &&
        Math.abs(textItem.y - object.originalY) <= 2
      ));

      const nextText = {
        ...texts[matchIndex],
        text: object.text,
        x: round(object.x),
        y: round(object.y),
        width: round(object.width),
        height: round(object.height),
        fontSize: round(object.fontSize)
      };

      if (matchIndex >= 0) {
        texts[matchIndex] = nextText;
      } else {
        texts.push({
          id: object.id,
          text: object.text,
          x: round(object.x),
          y: round(object.y),
          width: round(object.width),
          height: round(object.height),
          fontSize: round(object.fontSize),
          fontFamily: object.fontFamily || 'Helvetica'
        });
      }
    });

    return {
      ...page,
      texts
    };
  });

  return {
    ...htmlStructure,
    pages,
    html: buildHtmlFromStructure({ pages })
  };
}

export function buildHtmlFromStructure(htmlStructure) {
  const html = htmlStructure.pages
    .map((page) => {
      const cleanLines = dedupeLines((page.lines || []).filter((line) => (
        !isPageEdgeArtifactLine(line, page.width, page.height)
      )));

      console.log('[HtmlTextConvert] clean lines count:', cleanLines.length);

      const linesHtml = cleanLines.map((line) => (
        `<div class="pdf-line ${line.type}-line" style="position:absolute; left:${line.x}px; top:${line.y}px; width:${line.type === 'h' ? line.width : (line.lineWidth || 0.5)}px; height:${line.type === 'v' ? line.height : (line.lineWidth || 0.5)}px; background:${line.color || '#000000'};"></div>`
      )).join('');
      const textsHtml = page.texts.map((textItem) => {
        const normalizedFont = textItem.normalizedFont || normalizePdfFontName(textItem.fontFamily);
        const cssFontFamily = normalizedFont.cssFontFamily;
        const pdfFontName = normalizedFont.pdfFontName;

        const dataFontFamily = normalizedFont.dataFontFamily || pdfFontName;
        const sourceFontName = normalizedFont.sourceFontName || textItem.sourceFontName || '';

        return `<span class="pdf-text" data-font-family="${escapeHtmlAttribute(dataFontFamily)}" data-source-font="${escapeHtmlAttribute(sourceFontName)}" style="position:absolute; left:${textItem.x}px; top:${textItem.y}px; font-size:${textItem.fontSize}px; font-family:'${escapeHtmlAttribute(cssFontFamily)}';">${escapeHtml(textItem.text)}</span>`;
      }).join('');

      const htmlText = `<div class="pdf-page" data-page="${page.pageNumber}" style="position:relative; width:${page.width}px; height:${page.height}px;">${linesHtml}${textsHtml}</div>`;

      console.log('[HtmlTextConvert] htmlText includes Malgun:', htmlText.includes('Malgun'));
      console.log('[HtmlTextConvert] htmlText includes right edge line:', htmlText.includes('left:595'));

      return htmlText;
    })
    .join('');

  console.log('[HtmlStructure] generated html:', html);

  return html;
}

function drawStructureLine(doc, line) {
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(Math.max(line.lineWidth || 0.5, 0.2));

  if (line.type === 'h') {
    doc.line(line.x, line.y, line.x + line.width, line.y);
    return;
  }

  if (line.type === 'v') {
    doc.line(line.x, line.y, line.x, line.y + line.height);
    return;
  }

  doc.line(line.x1, line.y1, line.x2, line.y2);
}

function hasNonLatinText(value) {
  return /[^\u0000-\u00ff]/.test(String(value ?? ''));
}

function drawTextAsCanvasImage(doc, textValue, drawX, drawY, fontSize) {
  if (typeof document === 'undefined') {
    return false;
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    return false;
  }

  const fontFamily = '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  context.font = `${fontSize * TEXT_CANVAS_SCALE}px ${fontFamily}`;
  const measured = context.measureText(textValue);
  const canvasWidth = Math.max(1, Math.ceil(measured.width + fontSize * TEXT_CANVAS_SCALE));
  const canvasHeight = Math.max(1, Math.ceil(fontSize * TEXT_CANVAS_SCALE * 1.5));

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  context.font = `${fontSize * TEXT_CANVAS_SCALE}px ${fontFamily}`;
  context.textBaseline = 'alphabetic';
  context.fillText(textValue, 0, fontSize * TEXT_CANVAS_SCALE);

  const imageWidth = canvasWidth / TEXT_CANVAS_SCALE;
  const imageHeight = canvasHeight / TEXT_CANVAS_SCALE;
  const imageTop = drawY - fontSize;

  doc.addImage(canvas.toDataURL('image/png'), 'PNG', drawX, imageTop, imageWidth, imageHeight);
  return true;
}

function drawStructureText(doc, textItem, index) {
  const textValue = String(textItem?.text ?? '');

  if (!textValue.trim()) {
    console.warn('[PdfGenerate] skip empty text:', index, textItem);
    return;
  }

  const fontSize = Number(textItem?.fontSize);
  const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 10;
  const x = Number(textItem?.x);
  const y = Number(textItem?.y);
  const drawX = Number.isFinite(x) ? x : 0;
  const drawY = Number.isFinite(y) ? y + safeFontSize * TEXT_BASELINE_RATIO : safeFontSize;

  console.log('[PdfGenerate] draw text:', {
    index,
    text: textValue,
    x: drawX,
    y: drawY,
    fontSize: safeFontSize,
    koreanFontRegistered
  });

  doc.setTextColor(0, 0, 0);
  doc.setDrawColor(0, 0, 0);

  if (DEBUG_TEXT_DRAW) {
    doc.setDrawColor(255, 0, 0);
    doc.rect(drawX, Number.isFinite(y) ? y : 0, textItem?.width || safeFontSize, textItem?.height || safeFontSize);
    doc.setDrawColor(0, 0, 0);
  }

  if (koreanFontRegistered) {
    doc.setFont(KOREAN_FONT_NAME, 'normal');
  } else {
    console.warn('[PdfGenerate] Korean font not registered. fallback font will be used.');
    doc.setFont('helvetica', 'normal');
  }

  doc.setFontSize(safeFontSize);

  if (!koreanFontRegistered && hasNonLatinText(textValue) && drawTextAsCanvasImage(doc, textValue, drawX, drawY, safeFontSize)) {
    return;
  }

  doc.text(textValue, drawX, drawY);
}

export async function generatePdfFromHtmlStructure(htmlStructure, outputFileName) {
  const pages = Array.isArray(htmlStructure?.pages) ? htmlStructure.pages : [];
  const [firstPage] = pages;

  if (!firstPage) {
    throw new Error('PDF로 생성할 페이지 구조가 없습니다.');
  }

  const doc = new jsPDF({
    unit: 'pt',
    format: [firstPage.width, firstPage.height],
    compress: true
  });
  const fontRegistered = await registerKoreanFont(doc);

  if (!fontRegistered) {
    console.warn('[PdfGenerate] Korean font not registered. Text drawing will continue with fallback handling.');
  }

  pages.forEach((page, index) => {
    if (index > 0) {
      doc.addPage([page.width, page.height]);
    }

    const lines = Array.isArray(page.lines) ? page.lines : [];
    const texts = Array.isArray(page.texts) ? page.texts : [];

    console.log('[PdfGenerate] page:', page.pageNumber);
    console.log('[PdfGenerate] lines count:', lines.length);
    console.log('[PdfGenerate] texts count:', texts.length);
    console.log('[PdfGenerate] texts:', texts);

    lines.forEach((line) => drawStructureLine(doc, line));
    texts.forEach((textItem, textIndex) => drawStructureText(doc, textItem, textIndex));
  });

  return doc.output('blob');
}

function replaceLoggedText(sourceText, target, replacement, onReplace) {
  if (!String(sourceText).includes(target)) {
    return sourceText;
  }

  const replacedText = String(sourceText).replaceAll(target, replacement);
  onReplace?.();

  console.log('[HtmlStructure] replace item:', {
    before: sourceText,
    after: replacedText
  });

  return replacedText;
}

async function registerKoreanFont(doc) {
  if (koreanFontRegistered) {
    doc.setFont(KOREAN_FONT_NAME, 'normal');
    return true;
  }

  if (koreanFontRegistrationAttempted) {
    console.warn('[HtmlStructure] Korean font is not available, fallback to helvetica');
    return false;
  }

  koreanFontRegistrationAttempted = true;

  try {
    const fontBase64 = await loadKoreanFontBase64();

    if (!fontBase64) {
      console.warn('[HtmlStructure] Korean font data was not found, fallback to helvetica');
      return false;
    }

    doc.addFileToVFS(KOREAN_FONT_FILE, fontBase64);
    doc.addFont(KOREAN_FONT_FILE, KOREAN_FONT_NAME, 'normal');
    doc.setFont(KOREAN_FONT_NAME, 'normal');
    koreanFontRegistered = true;
    return true;
  } catch (error) {
    console.warn('[HtmlStructure] failed to register Korean font:', error);
    console.warn('[HtmlStructure] fallback to helvetica may break Korean text rendering');
    return false;
  }
}

async function loadKoreanFontBase64() {
  if (typeof window !== 'undefined' && typeof window.__DOC_PILOT_KOREAN_FONT_BASE64__ === 'string') {
    return window.__DOC_PILOT_KOREAN_FONT_BASE64__;
  }

  if (typeof fetch !== 'function') {
    return null;
  }

  const fontCandidates = [
    '/fonts/NotoSansKR-Regular.base64.txt',
    '/fonts/NotoSansKR-Regular.base64',
    '/fonts/NotoSansKR-Regular.ttf.base64'
  ];

  for (const candidate of fontCandidates) {
    try {
      const response = await fetch(candidate);

      if (!response.ok) {
        continue;
      }

      const base64 = (await response.text()).trim();

      if (base64) {
        return base64;
      }
    } catch (error) {
      console.warn('[HtmlStructure] failed to load Korean font candidate:', candidate, error);
    }
  }

  return null;
}

export function downloadGeneratedPdf(blobOrDoc, outputFileName) {
  const blob = blobOrDoc instanceof Blob ? blobOrDoc : blobOrDoc.output('blob');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = outputFileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function makeHtmlConvertedFileName(fileName = 'document.pdf') {
  const baseName = fileName.replace(/\.pdf$/i, '');

  return `${baseName}_html_converted.pdf`;
}
