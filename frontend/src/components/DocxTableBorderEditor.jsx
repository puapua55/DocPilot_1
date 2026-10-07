import { readWordCellBorder, WORD_BORDER_STROKES, wordBorderCells, wordBorderTargets } from '../services/docxTableBorderModel';

const PREVIEW_LINES = [
  ['top', 4, 4, 161, 4], ['bottom', 4, 108, 161, 108],
  ['left', 4, 4, 4, 108], ['right', 161, 4, 161, 108],
  ['horizontal', 4, 56, 161, 56], ['vertical', 82.5, 4, 82.5, 108],
  ['diagonalDown', 4, 4, 161, 108], ['diagonalUp', 4, 108, 161, 4]
];

function dashArray(style) {
  if (style === 'dotted') return '1 3';
  if (style === 'dashed') return '6 3';
  if (style === 'long-dashed') return '11 4';
  if (style === 'dash-dot') return '8 3 2 3';
  return undefined;
}

export default function DocxTableBorderEditor({ table, bounds, brush, onBrushChange, onApply }) {
  const selected = wordBorderCells(table, bounds);
  const strokeFor = (line) => {
    for (const item of selected) {
      if (line.startsWith('diagonal')) {
        const stroke = readWordCellBorder(item.cell, line);
        if (stroke.style !== 'none') return stroke;
      } else {
        for (const [side, included] of Object.entries(wordBorderTargets(item, bounds, line))) {
          if (!included) continue;
          const stroke = readWordCellBorder(item.cell, side);
          if (stroke.style !== 'none') return stroke;
        }
      }
    }
    return null;
  };
  const preview = PREVIEW_LINES.flatMap(([line, x1, y1, x2, y2]) => {
    const stroke = strokeFor(line);
    return stroke ? [{ line, x1, y1, x2, y2, ...stroke }] : [];
  });
  return (
    <div className="pdf-table-toolbar docx-border-panel" role="group" aria-label="DOCX 셀 테두리 설정">
      <div className="pdf-table-border-editor">
        <div className="pdf-table-border-strokes"><strong>선 종류</strong>
          <div className="pdf-table-border-stroke-grid">
            {WORD_BORDER_STROKES.map((stroke) => (
              <button key={stroke.label} type="button" title={stroke.label} aria-label={stroke.label}
                aria-pressed={brush.style === stroke.style && brush.width === stroke.width}
                onClick={() => onBrushChange({ ...brush, style: stroke.style, width: stroke.width })}>
                <span className={`pdf-table-stroke-sample is-${stroke.style}`}
                  style={{ '--stroke-width': `${stroke.width}px`, '--stroke-color': brush.color }} />
              </button>
            ))}
          </div>
        </div>
        <div className="pdf-table-border-controls"><strong>적용 위치</strong>
          <div className="pdf-table-border-presets">
            {[["none", "없음"], ["outside", "바깥쪽"], ["inside", "안쪽"], ["all", "모두"]].map(([line, label]) =>
              <button key={line} type="button" onClick={() => onApply(line)}>{label}</button>)}
          </div>
          <div className="pdf-table-border-preview-row">
            <div className="pdf-table-border-preview" aria-label="테두리 위치 미리보기" title="선을 고른 뒤 원하는 변을 누르세요">
              <svg viewBox="0 0 165 112" aria-hidden="true">
                {[4, 82.5, 161].map((x) => <line key={`v-${x}`} x1={x} y1="4" x2={x} y2="108" className="pdf-table-preview-guide" />)}
                {[4, 56, 108].map((y) => <line key={`h-${y}`} x1="4" y1={y} x2="161" y2={y} className="pdf-table-preview-guide" />)}
                {preview.map((edge) => <line key={edge.line} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2}
                  stroke={edge.color} strokeWidth={edge.width} strokeDasharray={dashArray(edge.style)} />)}
              </svg>
              {[["top", "위"], ["bottom", "아래"], ["left", "왼쪽"], ["right", "오른쪽"], ["horizontal", "가로 안쪽"], ["vertical", "세로 안쪽"]].map(([line, label]) =>
                <button key={line} type="button" className={`border-${line}`} aria-label={`${label} 테두리 전환`}
                  aria-pressed={Boolean(strokeFor(line))}
                  disabled={line === 'horizontal' && bounds.minRow === bounds.maxRow || line === 'vertical' && bounds.minColumn === bounds.maxColumn}
                  onClick={() => onApply(line)} />)}
            </div>
            <div className="pdf-table-diagonal-controls">
              {[["diagonalUp", "왼쪽 아래에서 오른쪽 위 대각선", "M 3 25 L 25 3"],
                ["diagonalDown", "왼쪽 위에서 오른쪽 아래 대각선", "M 3 3 L 25 25"]].map(([line, label, path]) =>
                <button key={line} type="button" aria-label={label} aria-pressed={Boolean(strokeFor(line))}
                  onClick={() => onApply(line)}>
                  <svg viewBox="0 0 28 28" aria-hidden="true"><rect x="2" y="2" width="24" height="24" fill="none" stroke="#c7d0df" strokeDasharray="2 2" />
                    <path d={path} fill="none" stroke={strokeFor(line)?.color || '#627cae'} strokeWidth="1.5" /></svg>
                </button>)}
            </div>
          </div>
        </div>
        <div className="pdf-table-border-properties"><strong>선 설정</strong>
          <label>굵기 <input type="number" aria-label="셀 테두리 굵기" min="0.25" max="5" step="0.25" value={brush.width}
            onChange={(event) => onBrushChange({ ...brush, width: Math.max(0.25, Math.min(5, Number(event.target.value) || 1)) })} /> px</label>
          <label>테두리 색 <input type="color" aria-label="셀 테두리 색" value={brush.color}
            onChange={(event) => onBrushChange({ ...brush, color: event.target.value })} /></label>
        </div>
      </div>
    </div>
  );
}
