import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFHexString, PDFName, PDFString, TextRenderingMode, degrees, rgb, setLineWidth, setStrokingRgbColor, setTextRenderingMode } from 'pdf-lib';
import { tableBorderDashArray, tableBorderSegments, tableSizes, tableSpans, tableStyle, tableVisibleCells } from './pdfTableModel.js';

const TABLE_KEY = PDFName.of('DocPilotTablesV1');
const FONT_URL = '/fonts/NotoSansKR-Regular.base64.txt';

function normalizedTable(item, pageCount) {
  const rect = item?.currentRect || {};
  const rows = Math.floor(Number(item?.rows));
  const columns = Math.floor(Number(item?.columns));
  const pageNumber = Math.floor(Number(item?.pageNumber));
  if (!item?.id || pageNumber < 1 || pageNumber > pageCount
    || rows < 1 || rows > 30 || columns < 1 || columns > 20
    || ![rect.x, rect.y, rect.width, rect.height, item.sourcePageWidth, item.sourcePageHeight].every((value) => Number.isFinite(Number(value)))
    || Number(item.sourcePageWidth) <= 0 || Number(item.sourcePageHeight) <= 0
    || Number(rect.width) < 8 || Number(rect.height) < 8) return null;
  return {
    id: String(item.id), pageNumber,
    sourcePageWidth: Number(item.sourcePageWidth), sourcePageHeight: Number(item.sourcePageHeight),
    currentRect: { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) },
    rows, columns,
    cells: Array.from({ length: rows * columns }, (_, index) => String(item.cells?.[index] || '')),
    cellStyles: Array.from({ length: rows * columns }, (_, index) => tableStyle(item.cellStyles?.[index])),
    rowHeights: tableSizes(item.rowHeights, rows),
    columnWidths: tableSizes(item.columnWidths, columns),
    spans: tableSpans(item.spans, rows, columns),
    fontSize: Math.max(5, Math.min(32, Number(item.fontSize) || 10)),
    borderWidth: Math.max(0.25, Math.min(5, Number(item.borderWidth) || 1)),
    borderColor: /^#[\da-f]{6}$/i.test(item.borderColor || '') ? item.borderColor : '#000000',
    headerFill: /^#[\da-f]{6}$/i.test(item.headerFill || '') ? item.headerFill : '#ffffff'
  };
}

function storedData(pdfDocument) {
  try {
    const entry = pdfDocument.catalog.lookupMaybe(TABLE_KEY, PDFHexString, PDFString);
    if (!entry) return { version: 1, tables: [] };
    const parsed = JSON.parse(entry.decodeText());
    return parsed?.version === 1 && Array.isArray(parsed.tables) ? parsed : { version: 1, tables: [] };
  } catch (error) {
    console.warn('[PdfTable] stored table data could not be read:', error);
    return { version: 1, tables: [] };
  }
}

export async function readPdfTables(file) {
  if (!file) return [];
  const document = await PDFDocument.load(await file.arrayBuffer());
  return storedData(document).tables
    .map((item) => normalizedTable(item, document.getPageCount()))
    .filter(Boolean)
    .map((item) => ({ ...item, persistedToPdf: true, savedRect: { ...item.currentRect }, hasChanges: false }));
}

function point(x, y, page, table) {
  const { width, height } = page.getSize();
  const rotation = ((Number(page.getRotation()?.angle) || 0) % 360 + 360) % 360;
  const displayWidth = rotation === 90 || rotation === 270 ? height : width;
  const displayHeight = rotation === 90 || rotation === 270 ? width : height;
  const dx = x * displayWidth / table.sourcePageWidth;
  const dy = y * displayHeight / table.sourcePageHeight;
  if (rotation === 90) return { x: dy, y: dx };
  if (rotation === 180) return { x: width - dx, y: dy };
  if (rotation === 270) return { x: width - dy, y: height - dx };
  return { x: dx, y: height - dy };
}

function pdfColor(hex) {
  return rgb(...[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255));
}

function line(page, table, edge) {
  const start = point(table.currentRect.x + edge.x1 * table.currentRect.width, table.currentRect.y + edge.y1 * table.currentRect.height, page, table);
  const end = point(table.currentRect.x + edge.x2 * table.currentRect.width, table.currentRect.y + edge.y2 * table.currentRect.height, page, table);
  const color = pdfColor(edge.color);
  if (edge.style === 'double') {
    const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    const offsetX = -(end.y - start.y) / length * edge.width * 0.45;
    const offsetY = (end.x - start.x) / length * edge.width * 0.45;
    for (const direction of [-1, 1]) page.drawLine({
      start: { x: start.x + offsetX * direction, y: start.y + offsetY * direction },
      end: { x: end.x + offsetX * direction, y: end.y + offsetY * direction },
      thickness: Math.max(0.25, edge.width / 3), color
    });
    return;
  }
  page.drawLine({ start, end, thickness: edge.width, color, dashArray: tableBorderDashArray(edge.style, edge.width) });
}

function rectangle(page, table, x, y, width, height, color) {
  const a = point(x, y, page, table);
  const b = point(x + width, y + height, page, table);
  page.drawRectangle({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), color: pdfColor(color)
  });
}

function wrapCellText(value, font, size, maxWidth) {
  const lines = [];
  let current = '';
  for (const character of String(value).replace(/\r/g, '')) {
    if (character === '\n') { lines.push(current); current = ''; continue; }
    const candidate = current + character;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = character;
    } else current = candidate;
  }
  lines.push(current);
  return lines;
}

function offsets(sizes, dimension) {
  const positions = [0];
  sizes.forEach((size) => positions.push(positions.at(-1) + size * dimension));
  return positions;
}

function drawTable(page, table, font) {
  const { x, y, width, height } = table.currentRect;
  const xs = offsets(table.columnWidths, width);
  const ys = offsets(table.rowHeights, height);
  rectangle(page, table, x, y, width, height, '#ffffff');
  const visibleCells = tableVisibleCells(table);
  visibleCells.forEach((cell) => {
    const style = table.cellStyles[cell.index];
    const left = x + xs[cell.column];
    const top = y + ys[cell.row];
    const right = x + xs[cell.column + cell.colSpan];
    const bottom = y + ys[cell.row + cell.rowSpan];
    const fill = style.fill || (cell.row === 0 ? table.headerFill : '#ffffff');
    if (fill !== '#ffffff') rectangle(page, table, left, top, right - left, bottom - top, fill);
  });
  tableBorderSegments(table).forEach((edge) => line(page, table, edge));
  if (!font) return;
  const pageRotation = ((Number(page.getRotation()?.angle) || 0) % 360 + 360) % 360;
  for (const cell of visibleCells) {
      const value = table.cells[cell.index];
      if (!value) continue;
      const style = table.cellStyles[cell.index];
      const cellWidth = xs[cell.column + cell.colSpan] - xs[cell.column];
      const cellHeight = ys[cell.row + cell.rowSpan] - ys[cell.row];
      const availableWidth = Math.max(1, cellWidth - 8);
      const availableHeight = Math.max(1, cellHeight - 6);
      const size = style.fontSize || table.fontSize;
      const lines = wrapCellText(value, font, size, availableWidth);
      if (lines.length * size * 1.2 > availableHeight) throw new Error(`표 ${table.pageNumber}페이지 ${cell.row + 1}행 ${cell.column + 1}열의 글자가 셀에 들어가지 않습니다. 셀 크기를 늘려 주세요.`);
      const lineHeight = size * 1.2;
      const contentHeight = lines.length * lineHeight;
      const topOffset = style.verticalAlign === 'bottom' ? cellHeight - contentHeight - 3 : style.verticalAlign === 'middle' ? (cellHeight - contentHeight) / 2 : 3;
      lines.forEach((text, lineIndex) => {
        if (!text) return;
        const textWidth = font.widthOfTextAtSize(text, size);
        const leftOffset = style.align === 'right' ? cellWidth - textWidth - 4 : style.align === 'center' ? (cellWidth - textWidth) / 2 : 4;
        const origin = point(x + xs[cell.column] + leftOffset, y + ys[cell.row] + topOffset + size + lineIndex * lineHeight, page, table);
        if (style.bold) {
          const color = pdfColor(style.color);
          page.pushOperators(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(size * 0.025), setStrokingRgbColor(color.red, color.green, color.blue));
        }
        page.drawText(text, { x: origin.x, y: origin.y, font, size, color: pdfColor(style.color), rotate: degrees(pageRotation) });
        if (style.bold) page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
      });
  }
}

async function tableFont(pdfDocument) {
  const response = await fetch(FONT_URL);
  if (!response.ok) throw new Error('표 텍스트 글꼴을 불러올 수 없습니다.');
  const base64 = (await response.text()).trim();
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  pdfDocument.registerFontkit(fontkit);
  return pdfDocument.embedFont(bytes, { subset: true });
}

export async function writePdfTables(pdfDocument, inputTables = []) {
  const pages = pdfDocument.getPages();
  const existing = storedData(pdfDocument).tables;
  existing.forEach((table) => {
    const page = pages[Number(table.pageNumber) - 1];
    if (!page || !Number.isInteger(Number(table.streamObjectNumber))) return;
    const contents = page.node.normalizedEntries().Contents;
    for (let index = contents.size() - 1; index >= 0; index -= 1) {
      if (contents.get(index)?.objectNumber === Number(table.streamObjectNumber)) contents.remove(index);
    }
  });
  const tables = inputTables.map((item) => normalizedTable(item, pages.length)).filter(Boolean);
  const font = tables.some((table) => table.cells.some(Boolean)) ? await tableFont(pdfDocument) : null;
  const stored = [];
  for (const table of tables) {
    const page = pages[table.pageNumber - 1];
    page.getContentStream(false);
    drawTable(page, table, font);
    stored.push({ ...table, streamObjectNumber: page.contentStreamRef.objectNumber });
  }
  pdfDocument.catalog.set(TABLE_KEY, PDFHexString.fromText(JSON.stringify({ version: 1, tables: stored })));
  return stored.length;
}
