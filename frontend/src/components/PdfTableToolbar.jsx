import { useState } from 'react';
import { tableAutoFit, tableBorderDashArray, tableInsert, tableMerge, tableSetTrackSize, tableSizes, tableSplit, tableStyle, tableVisibleCells } from '../services/pdfTableModel.js';

const TABS = [
  { id: 'structure', label: '행·열' },
  { id: 'size', label: '크기' },
  { id: 'format', label: '셀 서식' },
  { id: 'border', label: '테두리' }
];

const BORDER_STROKES = [
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

function borderSideTargets(target, bounds, line) {
  const { minRow, maxRow, minColumn, maxColumn } = bounds;
  const top = target.row === minRow;
  const bottom = target.row + target.rowSpan - 1 === maxRow;
  const left = target.column === minColumn;
  const right = target.column + target.colSpan - 1 === maxColumn;
  if (line === 'outside') return { top, bottom, left, right };
  if (line === 'inside') return { top: !top, bottom: !bottom, left: !left, right: !right };
  if (line === 'all') return { top: true, right: true, bottom: true, left: true };
  if (line === 'none') return { top: false, right: false, bottom: false, left: false };
  return {
    top: line === 'top' && top || line === 'horizontal' && !top,
    bottom: line === 'bottom' && bottom || line === 'horizontal' && !bottom,
    left: line === 'left' && left || line === 'vertical' && !left,
    right: line === 'right' && right || line === 'vertical' && !right
  };
}

function borderPreview(table, bounds) {
  const cells = tableVisibleCells(table).filter((cell) => cell.row <= bounds.maxRow && cell.row + cell.rowSpan - 1 >= bounds.minRow
    && cell.column <= bounds.maxColumn && cell.column + cell.colSpan - 1 >= bounds.minColumn);
  const strokeFor = (line) => {
    for (const cell of cells) {
      const style = tableStyle(table.cellStyles?.[cell.index]);
      if (line.startsWith('diagonal')) {
        const stroke = style.borderEdges?.[line];
        if (stroke && stroke.style !== 'none') return stroke;
        continue;
      }
      for (const [side, included] of Object.entries(borderSideTargets(cell, bounds, line))) {
        if (!included || style.borderSides?.[side] === false || style.borderEdges?.[side]?.style === 'none') continue;
        return { style: style.borderEdges?.[side]?.style || style.borderStyle || 'solid',
          width: style.borderEdges?.[side]?.width || style.borderWidth || table.borderWidth,
          color: style.borderEdges?.[side]?.color || style.borderColor || table.borderColor };
      }
    }
    return null;
  };
  return [
    ['top', 4, 4, 161, 4], ['bottom', 4, 108, 161, 108],
    ['left', 4, 4, 4, 108], ['right', 161, 4, 161, 108],
    ['horizontal', 4, 56, 161, 56], ['vertical', 82.5, 4, 82.5, 108],
    ['diagonalDown', 4, 4, 161, 108], ['diagonalUp', 4, 108, 161, 4]
  ].flatMap(([line, x1, y1, x2, y2]) => {
    const stroke = strokeFor(line);
    return stroke ? [{ line, x1, y1, x2, y2, ...stroke }] : [];
  });
}

export default function PdfTableToolbar({ table, selection, onChange, onCopy, onDelete, onResizeGrid }) {
  const [activeTab, setActiveTab] = useState('structure');
  const [borderBrush, setBorderBrush] = useState(() => ({ style: 'solid', width: table.borderWidth || 1, color: table.borderColor || '#000000' }));
  const cell = selection?.tableId === table.id ? selection.focus : { row: 0, column: 0 };
  const index = cell.row * table.columns + cell.column;
  const style = tableStyle(table.cellStyles?.[index]);
  const rowHeight = Math.round(tableSizes(table.rowHeights, table.rows)[cell.row] * table.currentRect.height);
  const columnWidth = Math.round(tableSizes(table.columnWidths, table.columns)[cell.column] * table.currentRect.width);
  const canMerge = selection?.tableId === table.id
    && (selection.anchor.row !== selection.focus.row || selection.anchor.column !== selection.focus.column);
  const minRow = canMerge ? Math.min(selection.anchor.row, selection.focus.row) : cell.row;
  const maxRow = canMerge ? Math.max(selection.anchor.row, selection.focus.row) : cell.row;
  const minColumn = canMerge ? Math.min(selection.anchor.column, selection.focus.column) : cell.column;
  const maxColumn = canMerge ? Math.max(selection.anchor.column, selection.focus.column) : cell.column;
  const updateStyle = (change) => {
    const cellStyles = [...(table.cellStyles || Array(table.rows * table.columns).fill(null))];
    for (const target of tableVisibleCells(table)) {
      if (target.row > maxRow || target.row + target.rowSpan - 1 < minRow
        || target.column > maxColumn || target.column + target.colSpan - 1 < minColumn) continue;
      cellStyles[target.index] = { ...tableStyle(cellStyles[target.index]), ...change };
    }
    onChange({ cellStyles });
  };
  const bounds = { minRow, maxRow, minColumn, maxColumn };
  const selectedCells = tableVisibleCells(table).filter((target) =>
    target.row <= maxRow && target.row + target.rowSpan - 1 >= minRow
      && target.column <= maxColumn && target.column + target.colSpan - 1 >= minColumn);
  const borderEnabled = (line) => selectedCells.some((target) => {
    const current = tableStyle(table.cellStyles?.[target.index]);
    if (line.startsWith('diagonal')) return !!current.borderEdges?.[line] && current.borderEdges[line].style !== 'none';
    const targets = borderSideTargets(target, bounds, line);
    return Object.entries(targets).some(([side, included]) => included && current.borderSides?.[side] !== false && current.borderEdges?.[side]?.style !== 'none');
  });
  const changeBorders = (line) => {
    const cellStyles = [...(table.cellStyles || Array(table.rows * table.columns).fill(null))];
    const allCells = tableVisibleCells(table);
    if (line.startsWith('diagonal')) {
      const alreadyApplied = selectedCells.every((target) => {
        const stroke = tableStyle(cellStyles[target.index]).borderEdges?.[line];
        return stroke?.style === borderBrush.style && stroke.width === borderBrush.width && stroke.color === borderBrush.color;
      });
      selectedCells.forEach((target) => {
        const current = tableStyle(cellStyles[target.index]);
        cellStyles[target.index] = { ...current, borderEdges: { ...current.borderEdges,
          [line]: { ...borderBrush, style: alreadyApplied ? 'none' : borderBrush.style } } };
      });
      onChange({ cellStyles });
      return;
    }
    const isPreset = ['none', 'outside', 'inside', 'all'].includes(line);
    const matchesBrush = (target, side) => {
      const current = tableStyle(cellStyles[target.index]);
      const edge = current.borderEdges?.[side];
      return current.borderSides?.[side] !== false && (edge?.style || current.borderStyle || 'solid') === borderBrush.style
        && (edge?.width || current.borderWidth || table.borderWidth) === borderBrush.width
        && (edge?.color || current.borderColor || table.borderColor) === borderBrush.color;
    };
    const enable = isPreset ? true : !selectedCells.every((target) => {
      const targets = borderSideTargets(target, bounds, line);
      return Object.entries(targets).every(([side, included]) => !included || matchesBrush(target, side));
    });
    const opposite = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
    const adjacent = (target, side, other) => {
      if (side === 'top') return other.row + other.rowSpan === target.row && other.column < target.column + target.colSpan && other.column + other.colSpan > target.column;
      if (side === 'bottom') return other.row === target.row + target.rowSpan && other.column < target.column + target.colSpan && other.column + other.colSpan > target.column;
      if (side === 'left') return other.column + other.colSpan === target.column && other.row < target.row + target.rowSpan && other.row + other.rowSpan > target.row;
      return other.column === target.column + target.colSpan && other.row < target.row + target.rowSpan && other.row + other.rowSpan > target.row;
    };
    const setSide = (target, side, show) => {
      const current = tableStyle(cellStyles[target.index]);
      cellStyles[target.index] = { ...current,
        borderSides: { top: true, right: true, bottom: true, left: true, ...current.borderSides, [side]: show },
        borderEdges: { ...current.borderEdges, [side]: show ? { ...borderBrush } : { ...borderBrush, style: 'none' } }
      };
    };
    selectedCells.forEach((target) => {
      const targets = borderSideTargets(target, bounds, line);
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (!isPreset && !targets[side]) continue;
        const show = isPreset ? targets[side] : enable;
        setSide(target, side, show);
        allCells.filter((other) => other.index !== target.index && adjacent(target, side, other))
          .forEach((other) => setSide(other, opposite[side], show));
      }
      if (line === 'none') {
        const current = tableStyle(cellStyles[target.index]);
        cellStyles[target.index] = { ...current, borderEdges: { ...current.borderEdges,
          diagonalDown: { ...borderBrush, style: 'none' }, diagonalUp: { ...borderBrush, style: 'none' } } };
      }
    });
    onChange({ cellStyles });
  };
  const changeStructure = (next) => {
    if (next !== table) onChange(next);
  };
  const preview = activeTab === 'border' ? borderPreview(table, bounds) : null;
  return <div className="pdf-table-toolbar document-toolbar" aria-label="표 편집 도구">
    <div className="pdf-table-toolbar-heading">
      <div className="pdf-table-toolbar-heading-text"><strong>표 편집</strong><span>{canMerge ? `선택: ${minRow + 1}~${maxRow + 1}행, ${minColumn + 1}~${maxColumn + 1}열` : `선택: ${cell.row + 1}행 ${cell.column + 1}열`}</span></div>
      <div className="pdf-table-toolbar-actions">
        <button type="button" onClick={onCopy}>표 복사</button>
        <button type="button" className="pdf-table-delete-button" onClick={onDelete}>표 삭제</button>
      </div>
    </div>
    <div className="pdf-table-toolbar-tabs" role="tablist" aria-label="표 설정 분류">
      {TABS.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
        className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
    </div>
    <div className="pdf-table-toolbar-content" role="tabpanel">
      {activeTab === 'structure' && <>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">표 크기</span>
          <label>행 <input aria-label="표 행 수" type="number" min="1" max="30" value={table.rows} onChange={(event) => onResizeGrid(event.target.value, table.columns)} /></label>
          <label>열 <input aria-label="표 열 수" type="number" min="1" max="20" value={table.columns} onChange={(event) => onResizeGrid(table.rows, event.target.value)} /></label>
        </div>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">행 삽입</span>
          <button type="button" onClick={() => changeStructure(tableInsert(table, 'row', cell.row))}>위에 행</button>
          <button type="button" onClick={() => changeStructure(tableInsert(table, 'row', cell.row + 1))}>아래에 행</button>
        </div>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">열 삽입</span>
          <button type="button" onClick={() => changeStructure(tableInsert(table, 'column', cell.column))}>왼쪽에 열</button>
          <button type="button" onClick={() => changeStructure(tableInsert(table, 'column', cell.column + 1))}>오른쪽에 열</button>
        </div>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">셀</span>
          <button type="button" aria-label="셀 병합" disabled={!canMerge} title="셀을 드래그하거나 Shift를 누른 채 선택한 뒤 병합" onClick={() => changeStructure(tableMerge(table, selection.anchor, selection.focus))}>병합</button>
          <button type="button" aria-label="셀 좌우 분할" onClick={() => changeStructure(tableSplit(table, cell.row, cell.column, 'column'))}>좌우 분할</button>
          <button type="button" aria-label="셀 상하 분할" onClick={() => changeStructure(tableSplit(table, cell.row, cell.column, 'row'))}>상하 분할</button>
        </div>
        <span className="pdf-table-tool-hint">셀 사이를 드래그해 범위를 선택하세요.</span>
      </>}
      {activeTab === 'size' && <>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">선택한 셀</span>
          <label>열 너비 <input aria-label="선택한 열 너비" type="number" min="24" value={columnWidth} onChange={(event) => changeStructure(tableSetTrackSize(table, 'column', cell.column, event.target.value))} />px</label>
          <label>행 높이 <input aria-label="선택한 행 높이" type="number" min="14" value={rowHeight} onChange={(event) => changeStructure(tableSetTrackSize(table, 'row', cell.row, event.target.value))} />px</label>
        </div>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">자동 조절</span>
          <button type="button" onClick={() => changeStructure(tableAutoFit(table))}>내용에 맞춤</button>
          <button type="button" onClick={() => onChange({ columnWidths: Array(table.columns).fill(1 / table.columns), rowHeights: Array(table.rows).fill(1 / table.rows) })}>균등 분배</button>
        </div>
        <span className="pdf-table-tool-hint">표 안의 경계선을 끌어서도 크기를 조절할 수 있습니다.</span>
      </>}
      {activeTab === 'format' && <>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">글자</span>
          <label>크기 <input aria-label="선택한 셀 글자 크기" type="number" min="5" max="32" step="0.5" value={style.fontSize || table.fontSize} onChange={(event) => updateStyle({ fontSize: Number(event.target.value) })} /></label>
          <button type="button" aria-pressed={style.bold} onClick={() => updateStyle({ bold: !style.bold })}>굵게</button>
          <label>글자색 <input aria-label="셀 글자색" type="color" value={style.color} onChange={(event) => updateStyle({ color: event.target.value })} /></label>
        </div>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">정렬</span>
          <label>가로 <select aria-label="셀 가로 정렬" value={style.align} onChange={(event) => updateStyle({ align: event.target.value })}><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option></select></label>
          <label>세로 <select aria-label="셀 세로 정렬" value={style.verticalAlign} onChange={(event) => updateStyle({ verticalAlign: event.target.value })}><option value="top">위</option><option value="middle">가운데</option><option value="bottom">아래</option></select></label>
        </div>
        <div className="pdf-table-tool-group"><span className="pdf-table-tool-group-label">배경</span>
          <label>{canMerge ? '선택 영역 색' : '셀 색'} <input aria-label="셀 배경색" type="color" value={style.fill || (cell.row === 0 ? table.headerFill : '#ffffff')} onChange={(event) => updateStyle({ fill: event.target.value })} /></label>
        </div>
        <span className="pdf-table-tool-hint">여러 셀을 드래그하면 선택 범위에 서식이 적용됩니다.</span>
      </>}
      {activeTab === 'border' && <>
        <div className="pdf-table-border-editor">
          <div className="pdf-table-border-strokes"><strong>선 종류</strong><div className="pdf-table-border-stroke-grid">
            {BORDER_STROKES.map((stroke) => <button key={stroke.label} type="button" title={stroke.label}
              aria-label={stroke.label} aria-pressed={borderBrush.style === stroke.style && borderBrush.width === stroke.width}
              onClick={() => setBorderBrush((current) => ({ ...current, style: stroke.style, width: stroke.width }))}>
              <span className={`pdf-table-stroke-sample is-${stroke.style}`} style={{ '--stroke-width': `${stroke.width}px`, '--stroke-color': borderBrush.color }} />
            </button>)}
          </div></div>
          <div className="pdf-table-border-controls"><strong>적용 위치</strong>
            <div className="pdf-table-border-presets">
              {[["none", "없음"], ["outside", "바깥쪽"], ["inside", "안쪽"], ["all", "모두"]].map(([preset, label]) =>
                <button key={preset} type="button" onClick={() => changeBorders(preset)}>{label}</button>)}
            </div>
            <div className="pdf-table-border-preview-row">
            <div className="pdf-table-border-preview" aria-label="테두리 위치 미리보기" title="선을 고른 뒤 원하는 변을 누르세요">
              <svg viewBox="0 0 165 112" aria-hidden="true">
                {[4, 82.5, 161].map((x) => <line key={`guide-v-${x}`} x1={x} y1="4" x2={x} y2="108" className="pdf-table-preview-guide" />)}
                {[4, 56, 108].map((y) => <line key={`guide-h-${y}`} x1="4" y1={y} x2="161" y2={y} className="pdf-table-preview-guide" />)}
                {preview.map((edge, index) => {
                  const offsets = edge.style === 'double' ? [-0.45, 0.45] : [0];
                  const length = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1) || 1;
                  return offsets.map((offset) => {
                    const dx = -(edge.y2 - edge.y1) / length * offset * edge.width;
                    const dy = (edge.x2 - edge.x1) / length * offset * edge.width;
                    return <line key={`${index}-${offset}`}
                      x1={edge.x1 + dx} y1={edge.y1 + dy} x2={edge.x2 + dx} y2={edge.y2 + dy}
                      stroke={edge.color} strokeWidth={edge.style === 'double' ? Math.max(0.5, edge.width / 3) : edge.width}
                      strokeDasharray={tableBorderDashArray(edge.style, edge.width)?.join(' ')} />;
                  });
                })}
              </svg>
              {[["top", "위"], ["bottom", "아래"], ["left", "왼쪽"], ["right", "오른쪽"], ["horizontal", "가로 안쪽"], ["vertical", "세로 안쪽"]].map(([line, label]) =>
                <button key={line} type="button" className={`border-${line}`} aria-label={`${label} 테두리 전환`}
                  aria-pressed={borderEnabled(line)} disabled={line === 'horizontal' && bounds.minRow === bounds.maxRow || line === 'vertical' && bounds.minColumn === bounds.maxColumn}
                  onClick={() => changeBorders(line)} />)}
            </div>
            <div className="pdf-table-diagonal-controls">
              {[["diagonalUp", "왼쪽 아래에서 오른쪽 위 대각선", "M 3 25 L 25 3"],
                ["diagonalDown", "왼쪽 위에서 오른쪽 아래 대각선", "M 3 3 L 25 25"]].map(([line, label, path]) =>
                <button key={line} type="button" aria-label={label} aria-pressed={borderEnabled(line)} onClick={() => changeBorders(line)}>
                  <svg viewBox="0 0 28 28" aria-hidden="true"><rect x="2" y="2" width="24" height="24" fill="none" stroke="#c7d0df" strokeDasharray="2 2" />
                    <path d={path} fill="none" stroke={borderEnabled(line) ? borderBrush.color : '#627cae'} strokeWidth="1.5" /></svg>
                </button>)}
            </div>
            </div>
          </div>
          <div className="pdf-table-border-properties"><strong>선 설정</strong>
            <label>굵기 <input aria-label="셀 테두리 굵기" type="number" min="0.25" max="5" step="0.25" value={borderBrush.width}
              onChange={(event) => setBorderBrush((current) => ({ ...current, width: Math.max(0.25, Math.min(5, Number(event.target.value) || 1)) }))} /> px</label>
            <label>테두리 색 <input aria-label="셀 테두리 색" type="color" value={borderBrush.color}
              onChange={(event) => setBorderBrush((current) => ({ ...current, color: event.target.value }))} /></label>
          </div>
        </div>
      </>}
    </div>
  </div>;
}
