const HIGHLIGHT_COLORS = {
  yellow: 'rgba(255, 235, 59, 0.45)',
  green: 'rgba(34, 197, 94, 0.30)',
  blue: 'rgba(59, 130, 246, 0.30)',
  pink: 'rgba(236, 72, 153, 0.30)'
};

function HighlightLayer({ boxes, width, height, color = 'yellow' }) {
  console.log('[HighlightLayer] render boxes:', boxes);

  const backgroundColor = HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow;

  return (
    <div
      className="highlight-layer"
      aria-hidden="true"
      data-highlight-color={color}
      style={{
        width: `${width}px`,
        height: `${height}px`
      }}
    >
      {boxes.map((box, index) => (
        <div
          key={`${box.page}-${box.x}-${box.y}-${index}`}
          className="highlight-box"
          data-highlight-color={color}
          style={{
            left: `${box.x}px`,
            top: `${box.y}px`,
            width: `${box.width}px`,
            height: `${box.height}px`,
            backgroundColor
          }}
        />
      ))}
    </div>
  );
}

export default HighlightLayer;
