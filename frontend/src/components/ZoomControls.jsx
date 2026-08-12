function ZoomControls({ scale, onZoomIn, onZoomOut }) {
  return (
    <div className="zoom-controls" aria-label="PDF 확대 축소 컨트롤">
      <button
        type="button"
        className="zoom-button"
        onClick={onZoomOut}
        aria-label="축소"
      >
        -
      </button>
      <span className="zoom-value">{Math.round(scale * 100)}%</span>
      <button
        type="button"
        className="zoom-button"
        onClick={onZoomIn}
        aria-label="확대"
      >
        +
      </button>
    </div>
  );
}

export default ZoomControls;
