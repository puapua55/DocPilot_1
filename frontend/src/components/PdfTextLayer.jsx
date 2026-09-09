import { useEffect, useRef } from 'react';
import { TextLayer } from 'pdfjs-dist';

function PdfTextLayer({ textContent, viewport, width, height, onRendered }) {
  const layerRef = useRef(null);

  useEffect(() => {
    const textLayer = layerRef.current;

    if (!textLayer || !textContent || !viewport || !width || !height) {
      return undefined;
    }

    let cancelled = false;
    textLayer.replaceChildren();
    textLayer.style.setProperty('--total-scale-factor', String(viewport.scale));
    textLayer.style.setProperty('--scale-factor', String(viewport.scale));
    const task = new TextLayer({ textContentSource: textContent, container: textLayer, viewport });
    task.render().then(() => {
      if (!cancelled) onRendered?.();
    }).catch((error) => {
      if (!cancelled && error?.name !== 'AbortException') {
        console.error('[PdfTextLayer] Failed to render text layer', error);
      }
    });

    return () => {
      cancelled = true;
      task.cancel();
      textLayer.replaceChildren();
    };
  }, [height, onRendered, textContent, viewport, width]);

  return (
    <div
      ref={layerRef}
      className="textLayer"
      aria-hidden="false"
      style={{
        width: `${width}px`,
        height: `${height}px`,
        '--total-scale-factor': viewport?.scale || 1,
        '--scale-factor': viewport?.scale || 1
      }}
    >
    </div>
  );
}

export default PdfTextLayer;
