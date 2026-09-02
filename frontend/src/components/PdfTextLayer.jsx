import { useEffect, useRef } from 'react';
import { TextLayer } from 'pdfjs-dist';

function PdfTextLayer({ textContent, viewport, width, height, onRendered }) {
  const layerRef = useRef(null);
  const textLayerTaskRef = useRef(null);

  useEffect(() => {
    const container = layerRef.current;

    if (!container || !textContent || !viewport || !width || !height) {
      return;
    }

    let cancelled = false;
    textLayerTaskRef.current?.cancel();
    container.replaceChildren();
    container.style.setProperty('--total-scale-factor', String(viewport.scale));
    const textLayerTask = new TextLayer({ textContentSource: textContent, container, viewport });
    textLayerTaskRef.current = textLayerTask;

    textLayerTask.render()
      .then(() => {
        if (!cancelled) {
          Array.from(container.querySelectorAll('span')).forEach((span) => {
            if (!span.textContent?.includes('테스트')) {
              return;
            }

            const style = window.getComputedStyle(span);
            console.debug('[PdfTextLayer] span metrics:', {
              text: JSON.stringify(span.textContent),
              width: span.getBoundingClientRect().width,
              scaleX: style.getPropertyValue('--scale-x'),
              paddingLeft: style.paddingLeft,
              paddingRight: style.paddingRight,
              marginLeft: style.marginLeft,
              marginRight: style.marginRight,
              letterSpacing: style.letterSpacing,
              wordSpacing: style.wordSpacing
            });
          });

          console.log('[PdfTextLayer] viewport sync:', {
            width: container.clientWidth,
            height: container.clientHeight,
            scale: viewport.scale
          });
          onRendered?.();
        }
      })
      .catch((error) => {
        if (!cancelled && error?.name !== 'AbortException') {
          console.error('[PdfTextLayer] Failed to render text layer', error);
        }
      });

    return () => {
      cancelled = true;
      textLayerTask.cancel();
      if (textLayerTaskRef.current === textLayerTask) {
        textLayerTaskRef.current = null;
      }
      container.replaceChildren();
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
        '--total-scale-factor': viewport?.scale || 1
      }}
    />
  );
}

export default PdfTextLayer;
