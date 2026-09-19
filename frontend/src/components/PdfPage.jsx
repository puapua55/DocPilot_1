import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import HighlightLayer from './HighlightLayer';
import PdfTextLayer from './PdfTextLayer';
import { ensureReplacementFont } from '../services/pdfReplacementFont';
import { describePdfTextFonts } from '../services/pdfFontPreview';
import {
  calculateHighlightBoxes,
  createHighlightBoxesFromTextLayer,
  createReplacementPreviewFromTextLayer
} from '../services/highlightService';

function quantizeChannel(value) {
  return Math.min(255, Math.max(0, Math.round(value / 16) * 16));
}

function sampleReplacementBackground(canvas, pageSize, cover) {
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!context || !pageSize.width || !pageSize.height) {
    return '#ffffff';
  }

  const scaleX = canvas.width / pageSize.width;
  const scaleY = canvas.height / pageSize.height;
  const left = Math.max(0, Math.floor(cover.x * scaleX));
  const top = Math.max(0, Math.floor(cover.y * scaleY));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(cover.width * scaleX)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(cover.height * scaleY)));

  if (left >= canvas.width || top >= canvas.height || width <= 0 || height <= 0) {
    return '#ffffff';
  }

  try {
    const colors = new Map();
    const collectRegion = (regionLeft, regionTop, regionWidth, regionHeight) => {
      const sampleLeft = Math.max(0, Math.min(canvas.width - 1, Math.floor(regionLeft)));
      const sampleTop = Math.max(0, Math.min(canvas.height - 1, Math.floor(regionTop)));
      const sampleWidth = Math.max(1, Math.min(canvas.width - sampleLeft, Math.ceil(regionWidth)));
      const sampleHeight = Math.max(1, Math.min(canvas.height - sampleTop, Math.ceil(regionHeight)));
      const { data } = context.getImageData(sampleLeft, sampleTop, sampleWidth, sampleHeight);

      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 3] === 0) continue;
        const color = [
          quantizeChannel(data[index]),
          quantizeChannel(data[index + 1]),
          quantizeChannel(data[index + 2])
        ];
        const key = color.join(',');
        colors.set(key, (colors.get(key) || 0) + 1);
      }
    };

    // Sample just outside the selected glyphs first. This avoids treating the
    // dark text pixels as the replacement background and keeps table lines
    // from being copied across the whole cover whenever possible.
    const margin = Math.max(2, Math.round(Math.min(width, height) * 0.35));
    const stripWidth = Math.max(1, Math.round(Math.min(width, margin)));
    const stripHeight = Math.max(1, Math.round(Math.min(height, margin)));
    collectRegion(left, top - stripHeight, width, stripHeight);
    collectRegion(left, top + height, width, stripHeight);
    collectRegion(left - stripWidth, top, stripWidth, height);
    collectRegion(left + width, top, stripWidth, height);

    // At page edges there may be no outside pixels. Fall back to the selected
    // region rather than failing to create a cover color.
    if (!colors.size) collectRegion(left, top, width, height);

    const dominant = Array.from(colors.entries()).sort((first, second) => second[1] - first[1])[0];
    if (!dominant) return '#ffffff';
    return `rgb(${dominant[0]})`;
  } catch (error) {
    console.warn('[PdfPage] replacement background sampling failed:', error);
    return '#ffffff';
  }
}

function PdfPage({
  pdf,
  pageNumber,
  scale,
  highlightKeyword,
  highlightOptions = {},
  replacePreview,
  textMoveMode = false,
  movableTexts = [],
  selectedMovableTextId = null,
  onCreateMovableText,
  onMoveMovableText,
  onSelectMovableText,
  onDeleteMovableText,
  onPageReady
}) {
  const canvasRef = useRef(null);
  const pageRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [renderError, setRenderError] = useState('');
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [highlightBoxes, setHighlightBoxes] = useState([]);
  const [fallbackBoxes, setFallbackBoxes] = useState([]);
  const [replacementPreviewItems, setReplacementPreviewItems] = useState([]);
  const [viewport, setViewport] = useState(null);
  const [textContent, setTextContent] = useState(null);
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  const moveRef = useRef(null);
  const handleTextLayerRendered = useCallback(() => {
    setTextLayerVersion((version) => version + 1);
  }, []);

  const handleTextSelection = useCallback(() => {
    if (!textMoveMode || !pageRef.current) return;

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (!selection || selection.rangeCount === 0 || !selectedText) return;

    const range = selection.getRangeAt(0);
    const textLayer = pageRef.current.querySelector('.textLayer');
    const commonNode = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    if (!textLayer?.contains(commonNode)) return;

    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    const pageRect = pageRef.current.getBoundingClientRect();
    if (!rects.length || rects.some((rect) => Math.abs(rect.top - rects[0].top) > 6)) {
      return;
    }

    const selectionRect = rects.reduce((current, rect) => ({
      left: Math.min(current.left, rect.left),
      top: Math.min(current.top, rect.top),
      right: Math.max(current.right, rect.right),
      bottom: Math.max(current.bottom, rect.bottom)
    }), {
      left: rects[0].left,
      top: rects[0].top,
      right: rects[0].right,
      bottom: rects[0].bottom
    });
    const currentRect = {
      x: (selectionRect.left - pageRect.left) / scale,
      y: (selectionRect.top - pageRect.top) / scale,
      width: (selectionRect.right - selectionRect.left) / scale,
      height: (selectionRect.bottom - selectionRect.top) / scale
    };
    if (currentRect.width < 2 || currentRect.height < 2) return;

    const startElement = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement : range.startContainer;
    const sourceElement = startElement?.closest('.textLayer span') || startElement;
    const computedStyle = sourceElement ? window.getComputedStyle(sourceElement) : null;
    // Only a complete PDF.js text item provides evidence for the first direct
    // removal implementation. Partial/multi-span selections still use overlay.
    let sourceSelection = null;
    const sourceInfo = sourceElement?.dataset.pdfSource ? JSON.parse(sourceElement.dataset.pdfSource) : null;
    if (sourceElement?.dataset.pdfSource && sourceElement.contains(range.endContainer)) {
      const before = range.cloneRange();
      before.selectNodeContents(sourceElement);
      before.setEnd(range.startContainer, range.startOffset);
      const after = range.cloneRange();
      after.selectNodeContents(sourceElement);
      after.setStart(range.endContainer, range.endOffset);
      if (!before.toString() && !after.toString()) {
        sourceSelection = { ...sourceInfo, wholeItem: true };
      }
    }
    const computedFontSize = Number.parseFloat(computedStyle?.fontSize);
    const fontSize = sourceInfo?.sourceFont?.fontSize || Math.max(
      1,
      (Number.isFinite(computedFontSize) && computedFontSize > 1 ? computedFontSize : selectionRect.bottom - selectionRect.top) / scale
    );
    const computedColor = computedStyle?.color || '';
    const color = computedColor && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0)?\s*\)/i.test(computedColor)
      ? computedColor
      : '#111111';
    const cover = {
      x: currentRect.x,
      y: currentRect.y,
      width: currentRect.width,
      height: currentRect.height
    };
    const backgroundColor = sampleReplacementBackground(canvasRef.current, pageSize, {
      x: cover.x * scale,
      y: cover.y * scale,
      width: cover.width * scale,
      height: cover.height * scale
    });
    const sourceFont = sourceSelection?.sourceFont;
    let glyphScaleX = 1;
    if (sourceFont?.glyphText) {
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${sourceFont.fontStyle} ${sourceFont.fontWeight} ${fontSize}px ${sourceFont.fontFamily}`;
      const naturalWidth = context.measureText(sourceFont.glyphText).width;
      if (naturalWidth > 0) glyphScaleX = currentRect.width / naturalWidth;
    }

    onCreateMovableText?.({
      type: 'movableText',
      pageNumber,
      text: selectedText,
      originalRect: currentRect,
      currentRect,
      coverRects: [cover],
      sourcePageWidth: pageSize.width / scale,
      sourcePageHeight: pageSize.height / scale,
      backgroundColor,
      fontSize,
      fontFamily: computedStyle?.fontFamily || 'Helvetica, Arial, sans-serif',
      color,
      createdFromSelection: true,
      sourceSelection,
      sourceFont: sourceInfo?.sourceFont || null,
      glyphText: sourceFont?.glyphText || null,
      glyphScaleX,
      baselineOffset: sourceSelection && viewport
        ? (viewport.convertToViewportPoint(sourceSelection.transform[4], sourceSelection.transform[5])[1] / scale) - currentRect.y
        : null,
      canDirectEdit: false,
      fallbackReason: '저장 시 원본 텍스트 직접 제거 가능 여부를 확인합니다.'
    });
    selection.removeAllRanges();
  }, [onCreateMovableText, pageNumber, pageSize, scale, textMoveMode, viewport]);

  const handleMovableTextPointerDown = (event, item) => {
    if (!textMoveMode || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    onSelectMovableText?.(item.id);
    moveRef.current = {
      id: item.id,
      startX: event.clientX,
      startY: event.clientY,
      startRect: item.currentRect
    };
  };

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (!moveRef.current) return;
      const { id, startX, startY, startRect } = moveRef.current;
      const pageWidth = pageSize.width / scale;
      const pageHeight = pageSize.height / scale;
      onMoveMovableText?.(id, {
        ...startRect,
        x: Math.min(
          Math.max(0, startRect.x + (event.clientX - startX) / scale),
          Math.max(0, pageWidth - startRect.width)
        ),
        y: Math.min(
          Math.max(0, startRect.y + (event.clientY - startY) / scale),
          Math.max(0, pageHeight - startRect.height)
        )
      });
    };
    const handlePointerUp = () => { moveRef.current = null; };
    const handleKeyDown = (event) => {
      if (!selectedMovableTextId) return;
      if (event.key === 'Escape') onSelectMovableText?.(null);
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        onDeleteMovableText?.(selectedMovableTextId);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onDeleteMovableText, onMoveMovableText, onSelectMovableText, pageSize, scale, selectedMovableTextId]);

  useEffect(() => {
    let cancelled = false;

    async function renderPage() {
      if (!pdf || !canvasRef.current) {
        return;
      }

      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }

      setRenderError('');
      console.log('[PdfPage] render page:', pageNumber);

      const page = await pdf.getPage(pageNumber);

      if (cancelled) {
        return;
      }

      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
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
        transform: outputScale === 1
          ? null
          : [outputScale, 0, 0, outputScale, 0, 0]
      });

      renderTaskRef.current = renderTask;

      await renderTask.promise;

      if (cancelled) {
        return;
      }

      // The replacement font is optional for displaying a PDF. A font load
      // failure must not turn a successfully rendered PDF page into a page
      // render error, especially in Electron's file:// environment.
      try {
        await ensureReplacementFont();
      } catch (fontError) {
        console.warn('[PdfPage] replacement font unavailable; using browser fallback:', fontError);
      }
      const textContent = await page.getTextContent();
      try {
        textContent.fontPreviews = await describePdfTextFonts(page, textContent);
      } catch (fontError) {
        console.warn('[PdfPage] 원본 글꼴 미리보기 분석 실패:', fontError);
      }
      if (!cancelled) {
        setTextContent(textContent);
        setReplacementPreviewItems([]);
      }
    }

    renderPage().catch((error) => {
      if (error?.name === 'RenderingCancelledException') {
        return;
      }

      console.error(`[PdfPage] Failed to render page ${pageNumber}`, error);

      if (!cancelled) {
        setRenderError(`${pageNumber}페이지를 표시하지 못했습니다. 파일을 다시 선택해주세요.`);
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
  }, [pageNumber, pdf, scale]);

  useEffect(() => {
    setFallbackBoxes(calculateHighlightBoxes({
      keyword: highlightKeyword, pageNumber,
      textItems: textContent?.items, viewport,
      matchMode: highlightOptions.matchMode
    }));
  }, [highlightKeyword, highlightOptions.matchMode, pageNumber, textContent, viewport]);

  useLayoutEffect(() => {
    if (!pageRef.current) {
      setHighlightBoxes([]);
      return undefined;
    }

    let frameId = 0;

    const updateHighlightBoxes = () => {
      const domRangeBoxes = createHighlightBoxesFromTextLayer(pageRef.current, highlightKeyword, highlightOptions);

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
  }, [fallbackBoxes, highlightKeyword, highlightOptions, pageNumber, textLayerVersion]);

  useLayoutEffect(() => {
    if (!pageRef.current || !replacePreview?.originalText) {
      setReplacementPreviewItems([]);
      return undefined;
    }

    let frameId = 0;

    const updateReplacementPreview = () => {
      const items = createReplacementPreviewFromTextLayer(pageRef.current, replacePreview);
      const canvas = canvasRef.current;
      setReplacementPreviewItems(items.map((item) => ({
        ...item,
        cover: {
          ...item.cover,
          backgroundColor: sampleReplacementBackground(canvas, pageSize, item.cover)
        }
      })));
    };

    frameId = window.requestAnimationFrame(updateReplacementPreview);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [pageNumber, pageSize, replacePreview, textLayerVersion]);

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
      onMouseUp={handleTextSelection}
      style={{
        width: pageSize.width ? `${pageSize.width}px` : undefined,
        height: pageSize.height ? `${pageSize.height}px` : undefined,
        minHeight: pageSize.height ? `${pageSize.height}px` : undefined
      }}
    >
      <div className="pdf-page-debug-label">page {pageNumber}</div>
      {renderError ? <div role="alert">{renderError}</div> : null}
      <canvas ref={canvasRef} className="pdf-canvas" />
      <PdfTextLayer
        textContent={textContent}
        viewport={viewport}
        width={pageSize.width}
        height={pageSize.height}
        onRendered={handleTextLayerRendered}
      />
      <ReplacementPreviewLayer items={replacementPreviewItems} width={pageSize.width} height={pageSize.height} />
      <MovableTextLayer
        items={movableTexts}
        scale={scale}
        selectedId={selectedMovableTextId}
        onPointerDown={handleMovableTextPointerDown}
      />
      <HighlightLayer boxes={highlightBoxes} width={pageSize.width} height={pageSize.height} color={highlightOptions.color} />
    </div>
  );
}

function MovableTextLayer({ items, scale, selectedId, onPointerDown }) {
  if (!items.length) return null;

  return (
    <div className="movable-text-layer" aria-hidden="true">
      {items.map((item) => (
        <div key={item.id}>
          {item.coverRects.map((cover, index) => (
            <div
              key={`${item.id}-cover-${index}`}
              className="movable-text-cover"
              style={{
                left: `${cover.x * scale}px`,
                top: `${cover.y * scale}px`,
                width: `${cover.width * scale}px`,
                height: `${cover.height * scale}px`,
                backgroundColor: item.backgroundColor || '#ffffff'
              }}
            />
          ))}
          <div
            className={`movable-text-object ${selectedId === item.id ? 'is-selected' : ''}`}
            style={{
              left: `${item.currentRect.x * scale}px`,
              top: `${item.currentRect.y * scale}px`,
              width: `${item.currentRect.width * scale}px`,
              minHeight: `${item.currentRect.height * scale}px`,
              color: item.color,
              fontFamily: item.fontFamily,
              fontSize: `${item.fontSize * scale}px`,
              lineHeight: `${item.currentRect.height * scale}px`
            }}
            onPointerDown={(event) => onPointerDown(event, item)}
          >
            {item.glyphText ? (
              <span className="movable-text-glyphs" style={{
                fontFamily: item.sourceFont.fontFamily,
                fontWeight: item.sourceFont.fontWeight,
                fontStyle: item.sourceFont.fontStyle,
                transform: `scaleX(${item.glyphScaleX})`,
                transformOrigin: 'left top'
              }}>{item.glyphText}</span>
            ) : item.text}
          </div>
        </div>
      ))}
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
              height: `${item.cover.height}px`,
              backgroundColor: item.cover.backgroundColor || '#ffffff'
            }}
          />
          <div
            className="replacement-text"
            data-baseline={item.text.baseline}
            data-max-width={item.text.maxWidth}
            style={{
              left: `${item.text.x}px`,
              top: `${item.text.y}px`,
              fontSize: `${item.text.fontSize}px`,
              lineHeight: `${item.text.lineHeight}px`,
              fontFamily: item.text.fontFamily,
              fontWeight: item.text.fontWeight,
              fontStyle: item.text.fontStyle,
              letterSpacing: item.text.letterSpacing
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
