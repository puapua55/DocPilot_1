export const WORD_BORDER_STROKES = [
  { label: '가는 실선', style: 'solid', width: 0.5 },
  { label: '실선', style: 'solid', width: 1 },
  { label: '굵은 실선', style: 'solid', width: 2 },
  { label: '아주 굵은 실선', style: 'solid', width: 3 },
  { label: '점선', style: 'dotted', width: 1 },
  { label: '파선', style: 'dashed', width: 1 },
  { label: '긴 파선', style: 'long-dashed', width: 1 },
  { label: '일점 쇄선', style: 'dash-dot', width: 1 },
  { label: '이중선', style: 'double', width: 2 }
];

const SIDES = ['top', 'right', 'bottom', 'left'];
const DIAGONALS = ['diagonalUp', 'diagonalDown'];
const opposite = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };

function savedEdges(cell) {
  try { return JSON.parse(cell.dataset.docxBorderEdges || '{}'); }
  catch { return {}; }
}

export function wordBorderCells(table, bounds) {
  if (!table || !bounds) return [];
  return Array.from(table.rows).flatMap((row, rowIndex) => Array.from(row.cells).map((cell, columnIndex) => ({
    cell, row: rowIndex, column: columnIndex,
    rowSpan: cell.rowSpan || 1, colSpan: cell.colSpan || 1
  }))).filter((item) => item.row <= bounds.maxRow && item.row + item.rowSpan - 1 >= bounds.minRow
    && item.column <= bounds.maxColumn && item.column + item.colSpan - 1 >= bounds.minColumn);
}

export function wordBorderTargets(item, bounds, line) {
  const top = item.row === bounds.minRow;
  const bottom = item.row + item.rowSpan - 1 === bounds.maxRow;
  const left = item.column === bounds.minColumn;
  const right = item.column + item.colSpan - 1 === bounds.maxColumn;
  if (line === 'outside') return { top, right, bottom, left };
  if (line === 'inside') return { top: !top, right: !right, bottom: !bottom, left: !left };
  if (line === 'all') return { top: true, right: true, bottom: true, left: true };
  if (line === 'none') return { top: false, right: false, bottom: false, left: false };
  return {
    top: (line === 'top' && top) || (line === 'horizontal' && !top),
    right: (line === 'right' && right) || (line === 'vertical' && !right),
    bottom: (line === 'bottom' && bottom) || (line === 'horizontal' && !bottom),
    left: (line === 'left' && left) || (line === 'vertical' && !left)
  };
}

export function readWordCellBorder(cell, side) {
  const saved = savedEdges(cell)[side];
  if (saved) return saved;
  if (DIAGONALS.includes(side)) return { style: 'none', width: 1, color: '#000000' };
  const css = window.getComputedStyle(cell);
  return {
    style: css[`border${side[0].toUpperCase()}${side.slice(1)}Style`] || 'none',
    width: Number.parseFloat(css[`border${side[0].toUpperCase()}${side.slice(1)}Width`]) || 1,
    color: css[`border${side[0].toUpperCase()}${side.slice(1)}Color`] || '#000000'
  };
}

function renderDiagonals(cell, edges) {
  cell.querySelector(':scope > .docx-diagonal-border-overlay')?.remove();
  const active = DIAGONALS.filter((side) => edges[side]?.style && edges[side].style !== 'none');
  if (!active.length) return;
  cell.style.position = 'relative';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('docx-diagonal-border-overlay');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  active.forEach((side) => {
    const stroke = edges[side];
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', '100');
    line.setAttribute('y1', side === 'diagonalDown' ? '0' : '100');
    line.setAttribute('y2', side === 'diagonalDown' ? '100' : '0');
    line.setAttribute('stroke', stroke.color);
    line.setAttribute('stroke-width', String(stroke.width));
    if (stroke.style === 'dotted') line.setAttribute('stroke-dasharray', '1 3');
    else if (stroke.style.includes('dash')) line.setAttribute('stroke-dasharray', '8 4');
    svg.appendChild(line);
  });
  cell.appendChild(svg);
}

function writeWordCellBorder(cell, side, stroke) {
  const edges = { ...savedEdges(cell), [side]: stroke };
  cell.dataset.docxBorderEdges = JSON.stringify(edges);
  if (SIDES.includes(side)) {
    const cssStyle = stroke.style === 'long-dashed' || stroke.style === 'dash-dot' ? 'dashed' : stroke.style;
    cell.style[`border${side[0].toUpperCase()}${side.slice(1)}`] = cssStyle === 'none'
      ? 'none' : `${stroke.width}px ${cssStyle} ${stroke.color}`;
  } else renderDiagonals(cell, edges);
  cell.dataset.docxCellStyleDirty = 'true';
}

function adjacent(item, side, other) {
  if (side === 'top') return other.row + other.rowSpan === item.row && other.column < item.column + item.colSpan && other.column + other.colSpan > item.column;
  if (side === 'bottom') return other.row === item.row + item.rowSpan && other.column < item.column + item.colSpan && other.column + other.colSpan > item.column;
  if (side === 'left') return other.column + other.colSpan === item.column && other.row < item.row + item.rowSpan && other.row + other.rowSpan > item.row;
  return other.column === item.column + item.colSpan && other.row < item.row + item.rowSpan && other.row + other.rowSpan > item.row;
}

export function applyWordTableBorders(table, bounds, line, brush) {
  const allCells = wordBorderCells(table, {
    minRow: 0, maxRow: table.rows.length - 1,
    minColumn: 0, maxColumn: Math.max(...Array.from(table.rows).map((row) => row.cells.length), 1) - 1
  });
  const selected = wordBorderCells(table, bounds);
  if (!selected.length) return false;
  const sameBrush = (item, side) => {
    const current = readWordCellBorder(item.cell, side);
    return current.style === brush.style && current.width === brush.width
      && current.color.toLowerCase() === brush.color.toLowerCase();
  };
  if (DIAGONALS.includes(line)) {
    const enable = !selected.every((item) => sameBrush(item, line));
    selected.forEach((item) => writeWordCellBorder(item.cell, line, { ...brush, style: enable ? brush.style : 'none' }));
  } else {
    const preset = ['none', 'outside', 'inside', 'all'].includes(line);
    const enable = preset || !selected.every((item) => Object.entries(wordBorderTargets(item, bounds, line))
      .every(([side, included]) => !included || sameBrush(item, side)));
    selected.forEach((item) => {
      const targets = wordBorderTargets(item, bounds, line);
      SIDES.forEach((side) => {
        if (!preset && !targets[side]) return;
        const stroke = { ...brush, style: (preset ? targets[side] : enable) ? brush.style : 'none' };
        writeWordCellBorder(item.cell, side, stroke);
        allCells.filter((other) => other.cell !== item.cell && adjacent(item, side, other))
          .forEach((other) => writeWordCellBorder(other.cell, opposite[side], stroke));
      });
      if (line === 'none') DIAGONALS.forEach((side) => writeWordCellBorder(item.cell, side, { ...brush, style: 'none' }));
    });
  }
  table.dataset.docxTableDirty = 'true';
  return true;
}
