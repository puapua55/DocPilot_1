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

function sampleReplacementTextColor(canvas, pageSize, cover) {
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!context || !pageSize.width || !pageSize.height) return null;
  const scaleX = canvas.width / pageSize.width;
  const scaleY = canvas.height / pageSize.height;
  const left = Math.max(0, Math.floor(cover.x * scaleX));
  const top = Math.max(0, Math.floor(cover.y * scaleY));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(cover.width * scaleX)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(cover.height * scaleY)));
  if (left >= canvas.width || top >= canvas.height || width <= 0 || height <= 0) return null;
  try {
    const colors = new Map();
    const { data } = context.getImageData(left, top, width, height);
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] === 0) continue;
      const channels = [data[index], data[index + 1], data[index + 2]];
      const brightness = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      const saturation = Math.max(...channels) - Math.min(...channels);
      if (brightness > 210 && saturation < 28) continue;
      const color = channels.map((channel) => Math.round(channel / 8) * 8);
      const key = color.join(',');
      colors.set(key, (colors.get(key) || 0) + 1);
    }
    const dominant = Array.from(colors.entries()).sort((a, b) => b[1] - a[1])[0];
    return dominant ? `rgb(${dominant[0]})` : null;
  } catch {
    return null;
  }
}

function isUsableDisplayText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const characters = [...text];
  const bad = characters.filter((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f || code === 0xfffd || character === '□';
  }).length;
  return bad / Math.max(characters.length, 1) < 0.35;
}

function measureDisplayText(text, fontSize, computedStyle) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return { width: 0, height: 0 };
  const fontStyle = computedStyle?.fontStyle || 'normal';
  const fontWeight = computedStyle?.fontWeight || 'normal';
  const fontFamily = computedStyle?.fontFamily || 'Helvetica, Arial, sans-serif';
  context.font = `${fontStyle} ${fontWeight} ${Math.max(1, fontSize)}px ${fontFamily}`;
  const metrics = context.measureText(text);
  const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft : 0;
  const right = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : fontSize * 0.8;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : fontSize * 0.2;
  return { width: Math.max(metrics.width || 0, left + right), height: Math.max(fontSize, ascent + descent) };
}

function getSelectedTextLayerSpans(textLayer, range) {
  return Array.from(textLayer.querySelectorAll('span[data-text-item-index]'))
    .filter((span) => {
      try {
        return range.intersectsNode(span);
      } catch {
        return false;
      }
    })
    .sort((a, b) => Number(a.dataset.textItemIndex) - Number(b.dataset.textItemIndex));
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
  editingMovableText = null,
  onCreateMovableText,
  onMoveMovableText,
  onMoveMovableTextEnd,
  onSelectMovableText,
  onBeginEditMovableText,
  onChangeEditMovableText,
  onChangeEditMovableTextStyle,
  onCommitEditMovableText,
  onCancelEditMovableText,
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
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const textLayer = pageRef.current.querySelector('.textLayer');
    const commonNode = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    if (!textLayer?.contains(commonNode)) return;
    const selectedSpans = getSelectedTextLayerSpans(textLayer, range);
    const selectionText = selection.toString().trim();
    const spanText = selectedSpans.map((span) => span.dataset.unicodeText || span.textContent || '').join('').trim();
    const wholeSpanRange = selectedSpans.length === 1 ? document.createRange() : null;
    if (wholeSpanRange) wholeSpanRange.selectNodeContents(selectedSpans[0]);
    const wholeSpan = selectedSpans.length === 1
      && wholeSpanRange.toString().trim() === selectionText;
    // PDF.js item.str is the authoritative Unicode value for a complete item.
    // For partial/multi-item selections, retain the browser's selected range.
    const selectedText = (wholeSpan ? spanText : selectionText) || spanText;
    // Do not block a user-selected range because PDF.js exposed unusual
    // Unicode. The export layer will choose direct removal or overlay
    // fallback based on whether the source can be safely identified.
    if (!String(selectedText || '').length) return;

    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    const pageRect = pageRef.current.getBoundingClientRect();
    // Selection is always accepted in text-move mode. Multi-line and partial
    // selections may not be removable directly from the PDF stream later,
    // but they must still become movable items and can safely use overlay
    // fallback during save.
    if (!rects.length) {
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
      } else {
        sourceSelection = {
          ...sourceInfo,
          wholeItem: false,
          partialSelection: true,
          selectedText
        };
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
    const sampledTextColor = sampleReplacementTextColor(canvasRef.current, pageSize, {
      x: cover.x * scale,
      y: cover.y * scale,
      width: cover.width * scale,
      height: cover.height * scale
    });
    const sourceFont = sourceSelection?.sourceFont;
    const measuredText = measureDisplayText(selectedText, fontSize, computedStyle);
    const horizontalSafetyPadding = Math.max(2, fontSize * 0.15);
    const verticalSafetyPadding = Math.max(1, fontSize * 0.1);
    const displayRect = {
      ...currentRect,
      width: Math.max(currentRect.width, measuredText.width + horizontalSafetyPadding * 2),
      height: Math.max(currentRect.height, measuredText.height + verticalSafetyPadding * 2)
    };
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
      displayText: selectedText,
      text: selectedText,
      // PDF.js can expose a compact source string while browser selection
      // presents layout spaces between glyphs. Retain both representations.
      // Keep layout/source text separately, but use the actual selected word
      // for deletion matching. This prevents a leading space in the PDF text
      // item from turning a text-only selection into a mismatched range.
      sourceText: sourceSelection?.selectedText || selectedText,
      originalText: sourceSelection?.selectedText || selectedText,
      originalRect: currentRect,
      displayRect,
      movedRect: displayRect,
      currentRect: displayRect,
      coverRects: rects.map((rect) => ({
        x: (rect.left - pageRect.left) / scale,
        y: (rect.top - pageRect.top) / scale,
        width: rect.width / scale,
        height: rect.height / scale
      })),
      sourcePageWidth: pageSize.width / scale,
      sourcePageHeight: pageSize.height / scale,
      backgroundColor,
      fontSize,
      fontFamily: computedStyle?.fontFamily || 'Helvetica, Arial, sans-serif',
      fontWeight: computedStyle?.fontWeight || 'normal',
      fontStyle: computedStyle?.fontStyle || 'normal',
      color: sampledTextColor || color,
      createdFromSelection: true,
      // A browser selection is represented by PDF.js Unicode text. Preserve
      // that exact text for export rather than replaying the source glyph run.
      forceUnicodeFallback: true,
      sourceSelection,
      sourceFont: sourceInfo?.sourceFont || null,
      glyphText: sourceFont?.glyphText || null,
      originalGlyphText: sourceFont?.glyphText || null,
      originalEncodedText: sourceInfo?.encodedText || null,
      originalUnicodeText: selectedText,
      fontAnalysis: sourceInfo?.sourceFont || null,
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
    if ((!textMoveMode && !item.isReplacement) || event.button !== 0) return;
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
      const currentRect = {
        ...startRect,
        x: Math.min(
          Math.max(0, startRect.x + (event.clientX - startX) / scale),
          Math.max(0, pageWidth - startRect.width)
        ),
        y: Math.min(
          Math.max(0, startRect.y + (event.clientY - startY) / scale),
          Math.max(0, pageHeight - startRect.height)
        )
      };
      moveRef.current.currentRect = currentRect;
      onMoveMovableText?.(id, currentRect);
    };
    const handlePointerUp = () => {
      if (moveRef.current?.currentRect) {
        onMoveMovableTextEnd?.(moveRef.current.id, moveRef.current.currentRect);
      }
      moveRef.current = null;
    };
    const handleKeyDown = (event) => {
      if (!selectedMovableTextId) return;
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea')) return;
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
  }, [onDeleteMovableText, onMoveMovableText, onMoveMovableTextEnd, onSelectMovableText, pageSize, scale, selectedMovableTextId]);

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
    if (!pageRef.current || !replacePreview?.originalText || replacePreview?.mode === 'review') {
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
        pageNumber={pageNumber}
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
        editingMovableText={editingMovableText}
        onPointerDown={handleMovableTextPointerDown}
        onDoubleClick={onBeginEditMovableText}
        onEditChange={onChangeEditMovableText}
        onEditStyleChange={onChangeEditMovableTextStyle}
        onEditCommit={onCommitEditMovableText}
        onEditCancel={onCancelEditMovableText}
      />
      <HighlightLayer boxes={highlightBoxes} width={pageSize.width} height={pageSize.height} color={highlightOptions.color} />
    </div>
  );
}

function MovableTextLayer({ items, scale, selectedId, editingMovableText, onPointerDown, onDoubleClick, onEditChange, onEditStyleChange, onEditCommit, onEditCancel }) {
  if (!items.length) return null;

  return (
    <div className="movable-text-layer" aria-hidden="true">
      {items.map((item) => (
        <div key={item.id}>
          {(item.persistedToPdf && item.hasChanges ? [item.originalRect] : item.coverRects).map((cover, index) => (
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
            className={`movable-text-object ${selectedId === item.id ? 'is-selected' : ''} ${item.persistedToPdf && !item.hasChanges ? 'is-review-selection' : ''}`}
            style={{
              left: `${item.currentRect.x * scale}px`,
              // The exported movable text is drawn from its PDF baseline.
              // Keep the browser preview on the same baseline instead of
              // relying on the source text-layer line box.
              top: `${(item.currentRect.y + (
                Number.isFinite(Number(item.baselineOffset))
                  ? Number(item.baselineOffset) - Number(item.fontSize) * 0.88
                  : Number(item.fontSize) * 0.02
              )) * scale}px`,
              width: `${item.currentRect.width * scale}px`,
              minHeight: `${item.currentRect.height * scale}px`,
              color: item.color,
              // Movable text is exported with the Unicode fallback font. Use
              // that same font in the viewer so glyph width and line spacing
              // do not change between the editor and the downloaded PDF.
              fontFamily: item.renderFontFamily || 'DocPilotReplacement',
              fontSize: `${item.fontSize * scale}px`,
              // The selection rectangle includes PDF.js ascent/descent
              // padding. Use the actual fallback font size as the line box so
              // the editor does not sit lower than the exported PDF text.
              lineHeight: `${item.fontSize * scale}px`,
              fontWeight: item.fontWeight || 'normal',
              fontStyle: item.fontStyle || 'normal',
              textDecoration: item.textDecoration || 'none'
            }}
            onPointerDown={(event) => onPointerDown(event, item)}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDoubleClick?.(item.id);
            }}
          >
            {editingMovableText?.id === item.id ? (
              <div className="movable-text-editor" onPointerDown={(event) => event.stopPropagation()}>
                <div
                  className="movable-text-format-toolbar"
                  role="toolbar"
                  aria-label="텍스트 서식"
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <button
                    type="button"
                    className={editingMovableText.fontWeight === 'bold' ? 'is-active' : ''}
                    onClick={() => onEditStyleChange?.({ fontWeight: editingMovableText.fontWeight === 'bold' ? 'normal' : 'bold' })}
                    aria-label="굵게"
                    title="굵게"
                  >가</button>
                  <button
                    type="button"
                    className={editingMovableText.fontStyle === 'italic' ? 'is-active' : ''}
                    onClick={() => onEditStyleChange?.({ fontStyle: editingMovableText.fontStyle === 'italic' ? 'normal' : 'italic' })}
                    aria-label="기울임"
                    title="기울임"
                  ><em>가</em></button>
                  <button
                    type="button"
                    className={editingMovableText.textDecoration === 'underline' ? 'is-active' : ''}
                    onClick={() => onEditStyleChange?.({ textDecoration: editingMovableText.textDecoration === 'underline' ? 'none' : 'underline' })}
                    aria-label="밑줄"
                    title="밑줄"
                  ><u>가</u></button>
                  <button
                    type="button"
                    className={editingMovableText.textDecoration === 'line-through' ? 'is-active' : ''}
                    onClick={() => onEditStyleChange?.({ textDecoration: editingMovableText.textDecoration === 'line-through' ? 'none' : 'line-through' })}
                    aria-label="취소선"
                    title="취소선"
                  ><s>가</s></button>
                  <label
                    className="movable-text-color-control"
                    title="글자색"
                    style={{ '--movable-text-color': editingMovableText.color || '#111111' }}
                  >
                    <span aria-hidden="true">A</span>
                    <input
                      type="color"
                      value={editingMovableText.color || '#111111'}
                      onChange={(event) => onEditStyleChange?.({ color: event.target.value })}
                      aria-label="글자색"
                    />
                  </label>
                </div>
                <input
                  className="movable-text-edit-input"
                  value={editingMovableText.value}
                  style={{
                    fontWeight: editingMovableText.fontWeight || 'normal',
                    fontStyle: editingMovableText.fontStyle || 'normal',
                    textDecoration: editingMovableText.textDecoration || 'none',
                    color: editingMovableText.color || '#111111'
                  }}
                  onChange={(event) => onEditChange?.(event.target.value)}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onEditCommit?.();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      onEditCancel?.();
                    } else if (event.ctrlKey || event.metaKey) {
                      if (event.key.toLowerCase() === 'b') {
                        event.preventDefault();
                        onEditStyleChange?.({ fontWeight: editingMovableText.fontWeight === 'bold' ? 'normal' : 'bold' });
                      } else if (event.key.toLowerCase() === 'i') {
                        event.preventDefault();
                        onEditStyleChange?.({ fontStyle: editingMovableText.fontStyle === 'italic' ? 'normal' : 'italic' });
                      } else if (event.key.toLowerCase() === 'u') {
                        event.preventDefault();
                        onEditStyleChange?.({ textDecoration: editingMovableText.textDecoration === 'underline' ? 'none' : 'underline' });
                      }
                    }
                  }}
                  onBlur={() => onEditCommit?.()}
                  autoFocus
                  aria-label="선택한 PDF 텍스트 편집"
                />
              </div>
            ) : (item.persistedToPdf && !item.hasChanges ? null : (item.displayText || item.text))}
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
        <div key={item.id} data-replacement-source={item.sourceTarget ? JSON.stringify({
          ...item.sourceTarget,
          originalText: item.sourceTarget.originalText || item.sourceTarget.matchedText,
          replacementText: item.text.value,
          sourceText: item.sourceTarget.sourceText || item.sourceTarget.matchedText || item.sourceTarget.originalText,
          sourceFullText: item.sourceTarget.sourceFullText || ''
        }) : undefined}>
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
