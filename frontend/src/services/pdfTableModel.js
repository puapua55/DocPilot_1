export const TABLE_MAX_ROWS = 30;
export const TABLE_MAX_COLUMNS = 20;

export function tableSizes(values, count) {
  const valid = Array.isArray(values) && values.length === count && values.every((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  const source = valid ? values.map(Number) : Array(count).fill(1);
  const total = source.reduce((sum, value) => sum + value, 0);
  return source.map((value) => value / total);
}

export function tableStyle(style = {}) {
  style = style || {};
  const validBorderStyles = ['solid', 'dashed', 'dotted', 'long-dashed', 'dash-dot', 'double', 'none'];
  const borderSides = style.borderSides && typeof style.borderSides === 'object'
    ? Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) => [side, style.borderSides[side] !== false]))
    : null;
  const borderEdges = style.borderEdges && typeof style.borderEdges === 'object'
    ? Object.fromEntries(['top', 'right', 'bottom', 'left', 'diagonalDown', 'diagonalUp'].map((side) => {
      const edge = style.borderEdges[side];
      return [side, edge && typeof edge === 'object' ? {
        style: validBorderStyles.includes(edge.style) ? edge.style : 'solid',
        width: Number.isFinite(Number(edge.width)) && Number(edge.width) >= 0.25 && Number(edge.width) <= 5 ? Number(edge.width) : 1,
        color: /^#[\da-f]{6}$/i.test(edge.color || '') ? edge.color : '#000000'
      } : null];
    })) : null;
  return {
    bold: !!style.bold,
    align: ['left', 'center', 'right'].includes(style.align) ? style.align : 'left',
    verticalAlign: ['top', 'middle', 'bottom'].includes(style.verticalAlign) ? style.verticalAlign : 'middle',
    fill: /^#[\da-f]{6}$/i.test(style.fill || '') ? style.fill : '',
    color: /^#[\da-f]{6}$/i.test(style.color || '') ? style.color : '#14203a',
    fontSize: Number.isFinite(Number(style.fontSize)) && Number(style.fontSize) >= 5 && Number(style.fontSize) <= 32 ? Number(style.fontSize) : null,
    borderWidth: Number.isFinite(Number(style.borderWidth)) && Number(style.borderWidth) >= 0.25 && Number(style.borderWidth) <= 5 ? Number(style.borderWidth) : null,
    borderColor: /^#[\da-f]{6}$/i.test(style.borderColor || '') ? style.borderColor : '',
    borderStyle: validBorderStyles.includes(style.borderStyle) ? style.borderStyle : null,
    borderSides,
    borderEdges
  };
}

export function tableBorderDashArray(style, width) {
  if (style === 'dashed') return [width * 4, width * 2];
  if (style === 'dotted') return [width, width];
  if (style === 'long-dashed') return [width * 8, width * 2];
  if (style === 'dash-dot') return [width * 5, width * 2, width, width * 2];
  return undefined;
}

export function tableBorderSegments(table) {
  const columns = tableSizes(table.columnWidths, table.columns);
  const rows = tableSizes(table.rowHeights, table.rows);
  const xs = [0];
  const ys = [0];
  columns.forEach((size) => xs.push(xs.at(-1) + size));
  rows.forEach((size) => ys.push(ys.at(-1) + size));
  const edges = new Map();
  const add = (key, x1, y1, x2, y2, style, side) => {
    const sideEdge = style.borderEdges?.[side];
    const enabled = style.borderSides?.[side] !== false && sideEdge?.style !== 'none';
    const explicit = style.borderSides !== null || style.borderStyle !== null || style.borderColor || style.borderWidth !== null;
    const candidate = {
      x1, y1, x2, y2,
      color: sideEdge?.color || style.borderColor || table.borderColor,
      width: sideEdge?.width || style.borderWidth || table.borderWidth,
      style: enabled ? (sideEdge?.style || style.borderStyle || 'solid') : 'none',
      priority: sideEdge ? 4 : enabled ? (explicit ? 2 : 1) : 3
    };
    if (!edges.has(key) || candidate.priority >= edges.get(key).priority) edges.set(key, candidate);
  };
  for (const cell of tableVisibleCells(table)) {
    const style = tableStyle(table.cellStyles?.[cell.index]);
    for (let column = cell.column; column < cell.column + cell.colSpan; column += 1) {
      add(`h:${cell.row}:${column}`, xs[column], ys[cell.row], xs[column + 1], ys[cell.row], style, 'top');
      add(`h:${cell.row + cell.rowSpan}:${column}`, xs[column], ys[cell.row + cell.rowSpan], xs[column + 1], ys[cell.row + cell.rowSpan], style, 'bottom');
    }
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      add(`v:${cell.column}:${row}`, xs[cell.column], ys[row], xs[cell.column], ys[row + 1], style, 'left');
      add(`v:${cell.column + cell.colSpan}:${row}`, xs[cell.column + cell.colSpan], ys[row], xs[cell.column + cell.colSpan], ys[row + 1], style, 'right');
    }
    for (const side of ['diagonalDown', 'diagonalUp']) {
      const diagonal = style.borderEdges?.[side];
      if (!diagonal || diagonal.style === 'none') continue;
      const descending = side === 'diagonalDown';
      edges.set(`${side}:${cell.index}`, {
        x1: xs[cell.column], y1: descending ? ys[cell.row] : ys[cell.row + cell.rowSpan],
        x2: xs[cell.column + cell.colSpan], y2: descending ? ys[cell.row + cell.rowSpan] : ys[cell.row],
        color: diagonal.color, width: diagonal.width, style: diagonal.style, priority: 4
      });
    }
  }
  return [...edges.values()].filter((edge) => edge.style !== 'none').map(({ priority, ...edge }) => edge);
}

export function tableSpans(spans, rows, columns) {
  const occupied = new Set();
  return (Array.isArray(spans) ? spans : []).filter((span) => {
    const row = Math.floor(Number(span.row));
    const column = Math.floor(Number(span.column));
    const rowSpan = Math.floor(Number(span.rowSpan));
    const colSpan = Math.floor(Number(span.colSpan));
    if (row < 0 || column < 0 || rowSpan < 1 || colSpan < 1 || row + rowSpan > rows || column + colSpan > columns || (rowSpan === 1 && colSpan === 1)) return false;
    for (let r = row; r < row + rowSpan; r += 1) for (let c = column; c < column + colSpan; c += 1) if (occupied.has(r * columns + c)) return false;
    for (let r = row; r < row + rowSpan; r += 1) for (let c = column; c < column + colSpan; c += 1) occupied.add(r * columns + c);
    return true;
  }).map(({ row, column, rowSpan, colSpan }) => ({ row: Number(row), column: Number(column), rowSpan: Number(rowSpan), colSpan: Number(colSpan) }));
}

export function tableCellAt(table, row, column) {
  const span = (table.spans || []).find((entry) => row >= entry.row && row < entry.row + entry.rowSpan && column >= entry.column && column < entry.column + entry.colSpan);
  return span ? { row: span.row, column: span.column, rowSpan: span.rowSpan, colSpan: span.colSpan } : { row, column, rowSpan: 1, colSpan: 1 };
}

export function tableVisibleCells(table) {
  const result = [];
  for (let row = 0; row < table.rows; row += 1) for (let column = 0; column < table.columns; column += 1) {
    const cell = tableCellAt(table, row, column);
    if (cell.row === row && cell.column === column) result.push({ ...cell, index: row * table.columns + column });
  }
  return result;
}

export function tableMerge(table, start, end) {
  const row = Math.min(start.row, end.row);
  const column = Math.min(start.column, end.column);
  const bottom = Math.max(start.row, end.row);
  const right = Math.max(start.column, end.column);
  if (row === bottom && column === right) return table;
  if ((table.spans || []).some((span) => span.row <= bottom && span.row + span.rowSpan - 1 >= row && span.column <= right && span.column + span.colSpan - 1 >= column
    && !(span.row >= row && span.column >= column && span.row + span.rowSpan - 1 <= bottom && span.column + span.colSpan - 1 <= right))) return table;
  const cells = [...table.cells];
  const content = [];
  for (let r = row; r <= bottom; r += 1) for (let c = column; c <= right; c += 1) {
    const index = r * table.columns + c;
    if (cells[index]) content.push(cells[index]);
    cells[index] = '';
  }
  cells[row * table.columns + column] = content.join(' ');
  const spans = (table.spans || []).filter((span) => span.row > bottom || span.row + span.rowSpan - 1 < row || span.column > right || span.column + span.colSpan - 1 < column);
  spans.push({ row, column, rowSpan: bottom - row + 1, colSpan: right - column + 1 });
  return { ...table, cells, spans };
}

export function tableSplit(table, row, column, direction = 'column') {
  const cell = tableCellAt(table, row, column);
  if (cell.rowSpan > 1 || cell.colSpan > 1) return { ...table, spans: (table.spans || []).filter((span) => span.row !== cell.row || span.column !== cell.column) };
  const isRow = direction === 'row';
  if (isRow && table.rows >= TABLE_MAX_ROWS || !isRow && table.columns >= TABLE_MAX_COLUMNS) return table;
  let next = tableInsert(table, direction, (isRow ? row : column) + 1);
  const spans = [...next.spans];
  const visited = new Set();
  const count = isRow ? next.columns : next.rows;
  for (let position = 0; position < count; position += 1) {
    if (position === (isRow ? column : row)) continue;
    const owner = tableCellAt(next, isRow ? row : position, isRow ? position : column);
    const key = `${owner.row}:${owner.column}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const boundary = isRow ? row + 1 : column + 1;
    if ((isRow ? owner.row + owner.rowSpan : owner.column + owner.colSpan) > boundary) continue;
    const existing = spans.find((span) => span.row === owner.row && span.column === owner.column);
    if (existing) {
      if (isRow) existing.rowSpan += 1;
      else existing.colSpan += 1;
    } else spans.push({ row: owner.row, column: owner.column, rowSpan: owner.rowSpan + (isRow ? 1 : 0), colSpan: owner.colSpan + (isRow ? 0 : 1) });
  }
  next = { ...next, spans };
  return next;
}

export function tableInsert(table, axis, at) {
  const isRow = axis === 'row';
  const rows = table.rows + (isRow ? 1 : 0);
  const columns = table.columns + (isRow ? 0 : 1);
  if (rows > TABLE_MAX_ROWS || columns > TABLE_MAX_COLUMNS) return table;
  const position = Math.max(0, Math.min(isRow ? table.rows : table.columns, at));
  const cells = Array(rows * columns).fill('');
  const cellStyles = Array(rows * columns).fill(null);
  for (let r = 0; r < table.rows; r += 1) for (let c = 0; c < table.columns; c += 1) {
    const target = (r + (isRow && r >= position ? 1 : 0)) * columns + c + (!isRow && c >= position ? 1 : 0);
    cells[target] = table.cells[r * table.columns + c] || '';
    cellStyles[target] = table.cellStyles?.[r * table.columns + c] || null;
  }
  const spans = (table.spans || []).map((span) => {
    const next = { ...span };
    if (isRow) {
      if (span.row >= position) next.row += 1;
      else if (span.row + span.rowSpan > position) next.rowSpan += 1;
    } else if (span.column >= position) next.column += 1;
    else if (span.column + span.colSpan > position) next.colSpan += 1;
    return next;
  });
  const key = isRow ? 'rowHeights' : 'columnWidths';
  const sizes = tableSizes(table[key], isRow ? table.rows : table.columns);
  const share = 1 / (sizes.length + 1);
  const nextSizes = sizes.map((value) => value * (1 - share));
  nextSizes.splice(position, 0, share);
  return { ...table, rows, columns, cells, cellStyles, spans, [key]: nextSizes };
}

export function tableResizeBoundary(table, axis, boundary, delta) {
  const key = axis === 'row' ? 'rowHeights' : 'columnWidths';
  const count = axis === 'row' ? table.rows : table.columns;
  const dimension = axis === 'row' ? table.currentRect.height : table.currentRect.width;
  if (boundary < 1 || boundary >= count) return table;
  const sizes = tableSizes(table[key], count);
  const difference = delta / dimension;
  const minimum = (axis === 'row' ? 14 : 24) / dimension;
  const nextLeft = sizes[boundary - 1] + difference;
  const nextRight = sizes[boundary] - difference;
  if (nextLeft < minimum || nextRight < minimum) return table;
  sizes[boundary - 1] = nextLeft;
  sizes[boundary] = nextRight;
  return { ...table, [key]: sizes };
}

export function tablePaste(table, startRow, startColumn, text) {
  const lines = String(text).replace(/\r/g, '').replace(/\n$/, '').split('\n').map((line) => line.split('\t'));
  if (lines.length === 1 && lines[0].length === 1) return null;
  let next = table;
  const rowsNeeded = Math.min(TABLE_MAX_ROWS, startRow + lines.length);
  const columnsNeeded = Math.min(TABLE_MAX_COLUMNS, startColumn + Math.max(...lines.map((line) => line.length)));
  while (next.rows < rowsNeeded) next = tableInsert(next, 'row', next.rows);
  while (next.columns < columnsNeeded) next = tableInsert(next, 'column', next.columns);
  const cells = [...next.cells];
  lines.forEach((line, row) => line.forEach((value, column) => {
    if (startRow + row < next.rows && startColumn + column < next.columns) {
      const owner = tableCellAt(next, startRow + row, startColumn + column);
      if (owner.row === startRow + row && owner.column === startColumn + column) cells[owner.row * next.columns + owner.column] = value;
    }
  }));
  return { ...next, cells };
}

export function tableSetTrackSize(table, axis, index, pixels) {
  const key = axis === 'row' ? 'rowHeights' : 'columnWidths';
  const count = axis === 'row' ? table.rows : table.columns;
  const dimension = axis === 'row' ? table.currentRect.height : table.currentRect.width;
  if (count < 2 || index < 0 || index >= count) return table;
  const sizes = tableSizes(table[key], count);
  const desired = Math.max(axis === 'row' ? 14 : 24, Math.min(dimension - (count - 1) * (axis === 'row' ? 14 : 24), Number(pixels))) / dimension;
  if (!Number.isFinite(desired)) return table;
  const others = (1 - desired) / (1 - sizes[index]);
  return { ...table, [key]: sizes.map((size, position) => position === index ? desired : size * others) };
}

export function tableAutoFit(table) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return table;
  const columnNeeds = Array(table.columns).fill(32);
  const visible = tableVisibleCells(table);
  const contentWidth = (cell) => {
    const value = table.cells[cell.index] || '';
    const size = table.cellStyles?.[cell.index]?.fontSize || table.fontSize;
    const bold = table.cellStyles?.[cell.index]?.bold ? 'bold ' : '';
    context.font = `${bold}${size}px 'Noto Sans KR', sans-serif`;
    return Math.max(32, ...value.split('\n').map((line) => context.measureText(line).width + 12));
  };
  for (const cell of visible.filter((entry) => entry.colSpan === 1)) {
    columnNeeds[cell.column] = Math.max(columnNeeds[cell.column], contentWidth(cell));
  }
  for (const cell of visible.filter((entry) => entry.colSpan > 1)) {
    const needed = contentWidth(cell);
    const current = columnNeeds.slice(cell.column, cell.column + cell.colSpan).reduce((sum, value) => sum + value, 0);
    const extra = Math.max(0, needed - current) / cell.colSpan;
    for (let column = cell.column; column < cell.column + cell.colSpan; column += 1) {
      columnNeeds[column] += extra;
    }
  }
  const totalWidth = columnNeeds.reduce((sum, value) => sum + value, 0);
  const availableWidth = Math.max(24, table.sourcePageWidth - table.currentRect.x);
  const width = Math.min(availableWidth, totalWidth);
  const columnWidths = columnNeeds.map((need) => need / totalWidth);
  const rowNeeds = Array.from({ length: table.rows }, (_, row) => {
    let height = 20;
    for (const cell of visible.filter((entry) => entry.row === row)) {
      const value = table.cells[cell.index] || '';
      const size = table.cellStyles?.[cell.index]?.fontSize || table.fontSize;
      const cellWidth = Math.max(12, columnWidths.slice(cell.column, cell.column + cell.colSpan).reduce((sum, value) => sum + value, 0) * width - 8);
      context.font = `${size}px 'Noto Sans KR', sans-serif`;
      const lines = value.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(context.measureText(line).width / cellWidth)), 0);
      height = Math.max(height, lines * size * 1.2 + 6);
    }
    return height;
  });
  const availableHeight = table.sourcePageHeight - table.currentRect.y;
  const height = Math.min(availableHeight, Math.max(table.currentRect.height, rowNeeds.reduce((sum, value) => sum + value, 0)));
  return { ...table, columnWidths, rowHeights: tableSizes(rowNeeds, table.rows), currentRect: { ...table.currentRect, width, height } };
}

export function tableToTsv(table) {
  return Array.from({ length: table.rows }, (_, row) => Array.from({ length: table.columns }, (_, column) => {
    const owner = tableCellAt(table, row, column);
    return owner.row === row && owner.column === column ? String(table.cells[row * table.columns + column] || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ') : '';
  }).join('\t')).join('\n');
}

export function duplicateTable(table, id, offset = 24) {
  const { x, y, width, height } = table.currentRect;
  const maxX = Math.max(0, table.sourcePageWidth - width);
  const maxY = Math.max(0, table.sourcePageHeight - height);
  const nextX = x + offset <= maxX ? x + offset : Math.max(0, x - offset);
  const nextY = y + offset <= maxY ? y + offset : Math.max(0, y - offset);
  return {
    ...table, id,
    currentRect: { x: nextX, y: nextY, width, height },
    cells: [...table.cells],
    cellStyles: (table.cellStyles || []).map((style) => style ? { ...style, borderSides: style.borderSides ? { ...style.borderSides } : null,
      borderEdges: style.borderEdges ? Object.fromEntries(Object.entries(style.borderEdges).map(([side, edge]) => [side, edge ? { ...edge } : null])) : null } : null),
    spans: (table.spans || []).map((span) => ({ ...span })),
    rowHeights: [...tableSizes(table.rowHeights, table.rows)],
    columnWidths: [...tableSizes(table.columnWidths, table.columns)],
    persistedToPdf: false, savedRect: undefined, hasChanges: true, streamObjectNumber: undefined
  };
}
