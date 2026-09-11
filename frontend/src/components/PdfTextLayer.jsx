import { useEffect, useRef } from 'react';
import { TextLayer } from 'pdfjs-dist';

// PDF.js measures at scale * DPR, while DOM glyphs are laid out at CSS font
// size. Font hinting/fallback can give those two sizes different advances.
// Measure the actual DOM advance and only correct the horizontal transform;
// never rewrite text, font-family, positions, or the PDF.js rotation pipeline.
function alignTextWidths(task, textContent, viewport, container) {
  const items = textContent.items.filter((item) => typeof item.str === 'string');
  const layerTransform = container.style.transform;
  container.style.transform = 'none';
  const entries = task.textDivs.map((span, index) => ({
    span, item: items[index], transform: span.style.transform
  })).filter(({ span, item }) => span.isConnected && item);

  entries.forEach(({ span }) => { span.style.transform = 'none'; });
  const minFontSize = Number.parseFloat(container.style.getPropertyValue('--min-font-size')) || 1;
  const widths = entries.map(({ span, item }) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    const measuredWidth = range.getBoundingClientRect().width;
    const vertical = textContent.styles[item.fontName]?.vertical;
    const expectedWidth = (vertical ? item.height : item.width) * viewport.scale;
    return measuredWidth > 0 && expectedWidth > 0
      ? expectedWidth * minFontSize / measuredWidth
      : null;
  });
  entries.forEach(({ span, transform }, index) => {
    span.style.transform = transform;
    if (Number.isFinite(widths[index]) && widths[index] > 0) {
      span.style.setProperty('--scale-x', String(widths[index]));
    }
  });
  container.style.transform = layerTransform;
}

function PdfTextLayer({ textContent, viewport, width, height, onRendered }) {
  const layerRef = useRef(null);

  useEffect(() => {
    const textLayer = layerRef.current;

    if (!textLayer || !textContent || !viewport || !width || !height) {
      return undefined;
    }

    let cancelled = false;
    textLayer.replaceChildren();
    textLayer.dataset.rendered = 'false';
    textLayer.style.setProperty('--total-scale-factor', String(viewport.scale));
    textLayer.style.setProperty('--scale-factor', String(viewport.scale));
    const task = new TextLayer({ textContentSource: textContent, container: textLayer, viewport });
    // PDF.js positions spans in the unrotated page box; CSS rotates that box.
    textLayer.style.width = `${viewport.rawDims.pageWidth * viewport.scale}px`;
    textLayer.style.height = `${viewport.rawDims.pageHeight * viewport.scale}px`;
    task.render().then(async () => {
      await document.fonts.ready;
      if (cancelled) return;
      alignTextWidths(task, textContent, viewport, textLayer);
      textLayer.dataset.rendered = 'true';
      onRendered?.();
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
