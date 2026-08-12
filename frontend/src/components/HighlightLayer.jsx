function HighlightLayer({ boxes, width, height }) {
  console.log('[HighlightLayer] render boxes:', boxes);

  return (
    <div
      className="highlight-layer"
      aria-hidden="true"
      style={{
        width: `${width}px`,
        height: `${height}px`
      }}
    >
      {boxes.map((box, index) => (
        <div
          key={`${box.page}-${box.x}-${box.y}-${index}`}
          className="highlight-box"
          style={{
            left: `${box.x}px`,
            top: `${box.y}px`,
            width: `${box.width}px`,
            height: `${box.height}px`
          }}
        />
      ))}
    </div>
  );
}

export default HighlightLayer;
