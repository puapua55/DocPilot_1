import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import HighlightLayer from './HighlightLayer';
import PdfTextLayer from './PdfTextLayer';
import {
  calculateHighlightBoxes,
  createHighlightBoxesFromTextLayer,
  createReplacementPreviewFromTextLayer
} from '../services/highlightService';

function PdfPage({ pdf, pageNumber, scale, highlightKeyword, replacePreview, onPageReady }) {
  const canvasRef = useRef(null);
  const pageRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState(null);
  const [textContent, setTextContent] = useState(null);
  const [highlightBoxes, setHighlightBoxes] = useState([]);
  const [fallbackBoxes, setFallbackBoxes] = useState([]);
  const [replacementPreviewItems, setReplacementPreviewItems] = useState([]);
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  const handleTextLayerRendered = useCallback(() => {
    setTextLayerVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function renderPage() {
      if (!pdf || !canvasRef.current) {
        return;
      }

      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;

      const canvas = canvasRef.current;
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = '';
      canvas.style.height = '';
      setPageSize({ width: 0, height: 0 });
      setViewport(null);
      setTextContent(null);
      setHighlightBoxes([]);
      setFallbackBoxes([]);
      setReplacementPreviewItems([]);

      console.log('[PdfPage] render page:', pageNumber);

      const page = await pdf.getPage(pageNumber);

      if (cancelled) {
        return;
      }

      const viewport = page.getViewport({ scale });
      const context = canvas.getContext('2d');

      if (!context) {
        throw new Error('Canvas 2D context is not available.');
      }

      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      setPageSize({
        width: viewport.width,
        height: viewport.height
      });
      setViewport(viewport);

      const renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
      });

      renderTaskRef.current = renderTask;

      await renderTask.promise;

      if (cancelled) {
        return;
      }

      const textContent = await page.getTextContent();
      const nextTextItems = Array.isArray(textContent.items) ? textContent.items : [];

      nextTextItems.forEach((item, index) => {
        if (String(item?.str || '').includes('테스트')) {
          console.debug('[PdfPage] text item:', {
            index,
            str: JSON.stringify(item.str),
            width: item.width,
            hasTrailingSpace: /\s$/.test(item.str)
          });
        }
      });

      const nextBoxes = calculateHighlightBoxes({
        keyword: highlightKeyword,
        pageNumber,
        textItems: nextTextItems,
        viewport
      });

      console.log('[PdfPage] viewport sync:', {
        pageNumber,
        scale,
        viewport: { width: viewport.width, height: viewport.height },
        canvasCss: { width: canvas.style.width, height: canvas.style.height },
        canvasBitmap: { width: canvas.width, height: canvas.height },
        outputScale
      });

      if (!cancelled) {
        setTextContent(textContent);
        setFallbackBoxes(nextBoxes);
        setReplacementPreviewItems([]);
      }
    }

    renderPage().catch((error) => {
      if (error?.name === 'RenderingCancelledException') {
        return;
      }

      console.error(`[PdfPage] Failed to render page ${pageNumber}`, error);

      if (!cancelled) {
        setTextContent(null);
        setFallbackBoxes([]);
        setHighlightBoxes([]);
        setReplacementPreviewItems([]);
      }
    });

    return () => {
      cancelled = true;

      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [highlightKeyword, pageNumber, pdf, scale]);

  useLayoutEffect(() => {
    if (!pageRef.current) {
      setHighlightBoxes([]);
      return undefined;
    }

    let frameId = 0;

    const updateHighlightBoxes = () => {
      const domRangeBoxes = createHighlightBoxesFromTextLayer(pageRef.current, highlightKeyword);

      if (domRangeBoxes.length > 0) {
        setHighlightBoxes(domRangeBoxes.map((box) => ({ ...box, page: pageNumber })));
        return;
      }

      setHighlightBoxes(fallbackBoxes);
    };

    frameId = window.requestAnimationFrame(updateHighlightBoxes);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [fallbackBoxes, highlightKeyword, pageNumber, textLayerVersion]);

  useLayoutEffect(() => {
    if (!pageRef.current || !replacePreview?.originalText) {
      setReplacementPreviewItems([]);
      return undefined;
    }

    let frameId = 0;

    const updateReplacementPreview = () => {
      setReplacementPreviewItems(
        createReplacementPreviewFromTextLayer(pageRef.current, replacePreview)
      );
    };

    frameId = window.requestAnimationFrame(updateReplacementPreview);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [pageNumber, replacePreview, textLayerVersion]);

  useEffect(() => {
    if (!onPageReady) {
      return undefined;
    }

    onPageReady(pageRef.current);

    return () => {
      onPageReady(null);
    };
  }, [onPageReady, pageNumber, pageSize.height, pageSize.width]);

  return (
    <div
      ref={pageRef}
      className="pdf-page"
      data-page-number={pageNumber}
      style={{
        width: pageSize.width ? `${pageSize.width}px` : undefined,
        height: pageSize.height ? `${pageSize.height}px` : undefined,
        minHeight: pageSize.height ? `${pageSize.height}px` : undefined
      }}
    >
      <div className="pdf-page-debug-label">page {pageNumber}</div>
      <canvas ref={canvasRef} className="pdf-canvas" />
      <PdfTextLayer
        textContent={textContent}
        viewport={viewport}
        width={pageSize.width}
        height={pageSize.height}
        onRendered={handleTextLayerRendered}
      />
      <ReplacementPreviewLayer items={replacementPreviewItems} width={pageSize.width} height={pageSize.height} />
      <HighlightLayer boxes={highlightBoxes} width={pageSize.width} height={pageSize.height} />
    </div>
  );
}

function ReplacementPreviewLayer({ items, width, height }) {
  if (!items.length) {
    return null;
  }

  return (
    <div
      className="replacement-layer"
      style={{
        width: `${width}px`,
        height: `${height}px`
      }}
    >
      {items.map((item) => (
        <div key={item.id}>
          <div
            className="replacement-cover"
            style={{
              left: `${item.cover.x}px`,
              top: `${item.cover.y}px`,
              width: `${item.cover.width}px`,
              height: `${item.cover.height}px`
            }}
          />
          <div
            className="replacement-text"
            style={{
              left: `${item.text.x}px`,
              top: `${item.text.y}px`,
              fontSize: `${item.text.fontSize}px`
            }}
          >
            {item.text.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export default PdfPage;
