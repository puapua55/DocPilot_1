import { useEffect, useRef } from 'react';

function PdfTextLayer({ spans, width, height }) {
  const layerRef = useRef(null);

  useEffect(() => {
    const textLayer = layerRef.current;

    if (!textLayer) {
      return;
    }

    const spanNodes = textLayer.querySelectorAll('span');

    console.log('[TextLayer] layer:', textLayer);
    console.log('[TextLayer] spans:', spanNodes);

    const targetSpan = Array.from(spanNodes).find((span) => span.textContent?.includes('테스트1'));

    if (targetSpan) {
      console.log('[TextLayer] span rect:', targetSpan.getBoundingClientRect());
      console.log('[TextLayer] span style:', window.getComputedStyle(targetSpan));
    }
  }, [spans]);

  return (
    <div
      ref={layerRef}
      className="textLayer"
      aria-hidden="false"
      style={{
        width: `${width}px`,
        height: `${height}px`
      }}
    >
      {spans.map((span, index) => {
        console.log('[TextLayer] span rect:', {
          text: span.text,
          x: span.left,
          y: span.top,
          width: span.width,
          height: span.height,
          itemWidth: span.itemWidth,
          expectedWidth: span.expectedWidth
        });

        return (
          <span
            key={`${span.text}-${span.left}-${span.top}-${index}`}
            className="textLayer-item"
            style={{
              left: `${span.left}px`,
              top: `${span.top}px`,
              lineHeight: `${span.lineHeight}`,
              fontSize: `${span.fontSize}px`
            }}
            data-text={span.text}
            ref={(node) => {
              if (!node) {
                return;
              }

              console.log('[TextLayer] span check:', {
                text: span.text,
                itemWidth: span.itemWidth,
                expectedWidth: span.expectedWidth,
                rect: node.getBoundingClientRect(),
                styleWidth: node.style.width
              });
            }}
          >
            {span.text}
          </span>
        );
      })}
    </div>
  );
}

export default PdfTextLayer;
