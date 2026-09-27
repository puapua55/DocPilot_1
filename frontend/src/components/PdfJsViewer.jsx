import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import PdfPage from './PdfPage';
import { loadPdfDocument } from '../services/pdfService';
import { searchKeywordInDocument } from '../services/searchService';
import { isPdfFile } from '../utils/fileUtils';
import { resolveReplacementPreviewFont } from '../services/pdfReplacementFont';

function normalizePdfLines(textItems) {
  const groupedLines = [];

  textItems.forEach((item) => {
    // Keep PDF.js whitespace tokens. A comma can be a separate item right
    // after a word, while its following space is another item.
    const value = String(item?.str || '');
    if (!value) {
      return;
    }

    const y = Array.isArray(item?.transform) ? Number(item.transform[5]) || 0 : 0;
    const lastLine = groupedLines[groupedLines.length - 1];

    if (lastLine && Math.abs(lastLine.y - y) < 4) {
      lastLine.parts.push(value);
      return;
    }

    groupedLines.push({ y, parts: [value] });
  });

  return groupedLines
    .map((line) => ({
      y: line.y,
      // Match the text-layer's span concatenation so its Range indexes and
      // search result indexes are identical.
      text: line.parts.join('').replace(/\s+/g, ' ').trim()
    }))
    .filter((line) => line.text);
}

async function extractAllPdfText(pdf) {
  if (!pdf) {
    return [];
  }

  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = normalizePdfLines(textContent.items);
    const text = lines.map((line) => line.text).join(' ').replace(/\s+/g, ' ').trim();

    pages.push({ pageNumber, text, lines });
  }
  return pages;
}

function formatPdfPagesText(pages) {
  return pages
    .map(({ pageNumber, text }) => `[${pageNumber}페이지]\n${text}`)
    .join('\n\n')
    .trim();
}

function normalizeMovableMatchText(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function filterMovedSourceSearchResults(results, movableTexts) {
  const hidden = movableTexts
    .map((item) => ({
      pageNumber: Number(item.pageNumber),
      text: normalizeMovableMatchText(item.previousSourceText || item.sourceSelection?.selectedText || item.sourceText || item.originalText)
    }))
    .filter((item) => item.pageNumber > 0 && item.text);
  const consumed = new Set();
  return results.filter((result) => {
    const pageNumber = Number(result.pageNumber ?? result.page);
    const fullText = normalizeMovableMatchText(result.fullText || result.lineText || result.text);
    const keyword = normalizeMovableMatchText(result.keyword);
    const index = hidden.findIndex((item, hiddenIndex) => (
      !consumed.has(hiddenIndex) && item.pageNumber === pageNumber
        && item.text.includes(keyword)
        && fullText.includes(item.text)
    ));
    if (index < 0) return true;
    consumed.add(index);
    return false;
  });
}

function getReplacementSearchText(item) {
  return String(item?.displayText ?? item?.editedText ?? item?.text ?? '').trim();
}

function getReplacementSearchResults(keyword, options, movableTexts) {
  const candidates = (Array.isArray(movableTexts) ? movableTexts : [])
    // Persisted replacements are already part of the reloaded PDF text layer.
    // Non-persisted items are the live replacement layer and need a synthetic
    // search result so search/highlight can reach them as well.
    .filter((item) => !(item?.persistedToPdf && !item?.hasChanges))
    .map((item) => ({ item, text: getReplacementSearchText(item) }))
    .filter(({ item, text }) => Number(item?.pageNumber) > 0 && text);

  return candidates.flatMap(({ item, text }) => {
    const lineNumber = Number(item?.lineNumber ?? item?.searchLineNumber ?? 1) || 1;
    const results = searchKeywordInDocument(
      [{ page: Number(item.pageNumber), lines: [text] }],
      keyword,
      options
    );
    return results.map((result) => ({
      ...result,
      id: `pdf-replacement-${item.id}-${result.matchIndex}`,
      type: 'pdf-replacement',
      isReplacement: true,
      replacementId: item.id,
      lineNumber,
      line: lineNumber,
      replacementRect: item.currentRect || item.displayRect || item.originalRect || null,
      lineText: text,
      fullText: text,
      text,
      originalText: result.matchedText,
      matchedText: result.matchedText
    }));
  });
}

function getVerticalBaselineOffset(item, verticalAlign = 'middle') {
  const height = Math.max(0, Number(item?.currentRect?.height) || 0);
  const fontSize = Math.max(1, Number(item?.fontSize) || 1);
  const freeSpace = Math.max(0, height - fontSize);
  const topOffset = fontSize * 0.88;
  if (verticalAlign === 'top') return topOffset;
  if (verticalAlign === 'bottom') return freeSpace + topOffset;
  return freeSpace / 2 + topOffset;
}

function TextEditFormatToolbar({ editing, onChange, onCommit, fonts = [], onFontChange }) {
  if (!editing) return null;
  return (
    <div
      className="pdf-text-edit-toolbar"
      role="toolbar"
      aria-label="텍스트 서식"
      onMouseDown={(event) => {
        // 서식 버튼은 편집 입력창의 포커스를 유지하되, 색상·자간 입력칸과
        // number 스피너는 브라우저 기본 입력 동작을 그대로 사용해야 한다.
        if (!event.target.closest('input, select')) event.preventDefault();
      }}
      onBlur={() => {
        window.setTimeout(() => {
          if (!document.activeElement?.closest?.('.pdf-text-edit-toolbar')) onCommit?.();
        }, 0);
      }}
    >
      <div className="text-edit-format-controls">
        <label className="text-edit-font-control" title="글꼴">
          <span>글꼴</span>
          <select
            value={editing.fontFamily || ''}
            onChange={(event) => onFontChange?.(event.target.value)}
            aria-label="글꼴"
          >
            <option value="">원본 글꼴</option>
            {fonts.map((font) => <option key={font.candidate} value={font.candidate}>{font.label}</option>)}
          </select>
        </label>
        <label className="text-edit-font-size" title="글자 크기">
          <input
            type="number"
            min="4"
            max="144"
            step="0.1"
            value={editing.fontSize ?? 10}
            onChange={(event) => {
              const rawValue = event.target.value;
              if (rawValue === '') {
                onChange?.({ fontSize: '' });
                return;
              }
              const value = Number(rawValue);
              if (Number.isFinite(value)) onChange?.({ fontSize: Math.max(4, Math.min(144, value)) });
            }}
            aria-label="글자 크기"
          />
          <small>pt</small>
        </label>
        <button
          type="button"
          className={editing.fontWeight === 'bold' ? 'is-active' : ''}
          onClick={() => onChange?.({ fontWeight: editing.fontWeight === 'bold' ? 'normal' : 'bold' })}
          aria-label="굵게"
          title="굵게"
        ><strong>가</strong></button>
        <button
          type="button"
          className={editing.fontStyle === 'italic' ? 'is-active' : ''}
          onClick={() => onChange?.({ fontStyle: editing.fontStyle === 'italic' ? 'normal' : 'italic' })}
          aria-label="기울임"
          title="기울임"
        ><em>가</em></button>
        <button
          type="button"
          className={editing.textDecoration === 'underline' ? 'is-active' : ''}
          onClick={() => onChange?.({ textDecoration: editing.textDecoration === 'underline' ? 'none' : 'underline' })}
          aria-label="밑줄"
          title="밑줄"
        ><u>가</u></button>
        <button
          type="button"
          className={editing.textDecoration === 'line-through' ? 'is-active' : ''}
          onClick={() => onChange?.({ textDecoration: editing.textDecoration === 'line-through' ? 'none' : 'line-through' })}
          aria-label="취소선"
          title="취소선"
        ><s>가</s></button>
        <label className="text-edit-color-control" title="글자색" style={{ '--text-edit-color': editing.color || '#111111' }}>
          <span aria-hidden="true">A</span>
          <input type="color" value={editing.color || '#111111'} onChange={(event) => onChange?.({ color: event.target.value })} aria-label="글자색" />
        </label>
        <label className="text-edit-letter-spacing" title="자간">
          <span>자간</span>
          <input
            type="number"
            min="-5"
            max="20"
            step="0.1"
            value={editing.letterSpacing ?? 0}
            onChange={(event) => {
              const rawValue = event.target.value;
              if (rawValue === '') {
                onChange?.({ letterSpacing: '' });
                return;
              }
              const value = Number(rawValue);
              if (Number.isFinite(value)) {
                onChange?.({ letterSpacing: Math.max(-5, Math.min(20, value)) });
              }
            }}
            aria-label="자간"
          />
          <small>px</small>
        </label>
        <div className="text-edit-format-group" role="group" aria-label="세로 기준선">
          {[
            ['top', '↥', '위쪽 기준선'],
            ['middle', '↕', '가운데 기준선'],
            ['bottom', '↧', '아래쪽 기준선']
          ].map(([value, icon, title]) => (
            <button
              key={value}
              type="button"
              className={editing.verticalAlign === value ? 'is-active' : ''}
              onClick={() => onChange?.({ verticalAlign: value })}
              aria-label={title}
              title={title}
            >{icon}</button>
          ))}
        </div>
        <div className="text-edit-format-group" role="group" aria-label="가로 정렬">
          {[
            ['left', '≡', '왼쪽 정렬'],
            ['center', '≡', '가운데 정렬'],
            ['right', '≡', '오른쪽 정렬'],
            ['justify', '☰', '양쪽 정렬']
          ].map(([value, icon, title]) => (
            <button
              key={value}
              type="button"
              className={`text-align-button text-align-${value} ${editing.textAlign === value ? 'is-active' : ''}`}
              onClick={() => onChange?.({ textAlign: value })}
              aria-label={title}
              title={title}
            >{icon}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function collectInstantReplacementReviewItems(viewScale = 1) {
  const scale = Number.isFinite(Number(viewScale)) && Number(viewScale) > 0 ? Number(viewScale) : 1;
  return Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]')).flatMap((pageElement) => {
    const pageNumber = Number(pageElement.dataset.pageNumber);
    const pageRect = pageElement.getBoundingClientRect();
    const sourcePageWidth = (pageElement.clientWidth || pageRect.width) / scale;
    const sourcePageHeight = (pageElement.clientHeight || pageRect.height) / scale;
    return Array.from(pageElement.querySelectorAll('.replacement-layer > div')).map((element, index) => {
      const cover = element.querySelector('.replacement-cover');
      const textElement = element.querySelector('.replacement-text');
      if (!cover || !textElement) return null;
      let source = {};
      try { source = JSON.parse(element.dataset.replacementSource || '{}'); } catch { source = {}; }
      const coverStyle = window.getComputedStyle(cover);
      const textStyle = window.getComputedStyle(textElement);
      const textRect = textElement.getBoundingClientRect();
      const originalRect = {
        x: Number.parseFloat(cover.style.left || coverStyle.left) / scale,
        y: Number.parseFloat(cover.style.top || coverStyle.top) / scale,
        width: Number.parseFloat(cover.style.width || coverStyle.width) / scale,
        height: Number.parseFloat(cover.style.height || coverStyle.height) / scale
      };
      const textX = Number.parseFloat(textElement.style.left || textStyle.left) / scale;
      const textY = Number.parseFloat(textElement.style.top || textStyle.top) / scale;
      const fontSize = Number.parseFloat(textElement.style.fontSize || textStyle.fontSize) / scale;
      const replacementText = String(textElement.textContent || '').trim();
      if (!replacementText || ![pageNumber, sourcePageWidth, sourcePageHeight, ...Object.values(originalRect), textX, textY, fontSize].every(Number.isFinite)) return null;
      const currentRect = {
        x: textX,
        y: textY,
        width: Math.max(1, textRect.width / scale),
        height: Math.max(originalRect.height, textRect.height / scale, fontSize)
      };
      return {
        id: `instant-replace-${source.id || pageNumber}-${index}-${Date.now()}`,
        type: 'movable-text',
        isReplacement: true,
        persistedToPdf: true,
        hasChanges: false,
        pageNumber,
        sourcePageWidth,
        sourcePageHeight,
        // The old word has already been removed. If this review item changes,
        // remove the newly saved word before writing the edited value.
        sourceText: replacementText,
        originalText: replacementText,
        originalUnicodeText: replacementText,
        // Retain the replaced source separately: the PDF text layer may still
        // expose it when the converter had to use a visual cover fallback.
        previousSourceText: String(source.originalText || source.sourceText || ''),
        sourceFullText: '',
        originalRect,
        currentRect,
        movedRect: currentRect,
        displayRect: currentRect,
        // The saved PDF already contains the new text. A review selection
        // must not paint a cover or a second copy over it.
        coverRects: [],
        displayText: replacementText,
        text: replacementText,
        editedText: replacementText,
        textX,
        textY,
        baseline: Number.parseFloat(textElement.dataset.baseline) / scale,
        baselineOffset: fontSize * 0.88,
        fontSize,
        fontFamily: textStyle.fontFamily,
        renderFontFamily: 'DocPilotReplacement',
        fontWeight: textStyle.fontWeight || 'normal',
        fontStyle: textStyle.fontStyle || 'normal',
        textDecoration: textStyle.textDecoration || 'none',
        letterSpacing: Number.parseFloat(textStyle.letterSpacing) || 0,
        color: textStyle.color || '#111111',
        backgroundColor: coverStyle.backgroundColor || '#ffffff',
        forceUnicodeFallback: true,
        sourceSelection: null,
        canDirectEdit: false,
        fallbackReason: '즉시 교체 후 검토·편집 가능한 선택 영역입니다.'
      };
    }).filter(Boolean);
  });
}

const PdfJsViewer = forwardRef(function PdfJsViewer({ file, highlightKeyword, selectedSearchResult, replacePreview, scale = 1, toolbarActions, onVisualConvert, isEditMode = false, onEditModeChange }, ref) {
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pageNumbers, setPageNumbers] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [appliedReplacePreview, setAppliedReplacePreview] = useState(replacePreview);
  const [visualConvertStatus, setVisualConvertStatus] = useState('idle');
  const [visualConvertMessage, setVisualConvertMessage] = useState('');
  const [downloadStatus, setDownloadStatus] = useState('idle');
  const [downloadMessage, setDownloadMessage] = useState('');
  const [downloadFailed, setDownloadFailed] = useState(false);
  const pdfDocumentRef = useRef(null);
  const pagesTextRef = useRef([]);
  const viewerRef = useRef(null);
  const pageRefs = useRef({});
  const historyRef = useRef({ snapshots: [], index: -1 });
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false, canReset: false });
  const [viewMode, setViewMode] = useState('scroll');
  const [currentPage, setCurrentPage] = useState(1);
  const [textMoveMode, setTextMoveMode] = useState(false);
  const [textReplaceMode, setTextReplaceMode] = useState(false);
  const [areaTextReplaceMode, setAreaTextReplaceMode] = useState(false);
  const [movableTexts, setMovableTexts] = useState([]);
  const [imageAttachments, setImageAttachments] = useState([]);
  const [batchReplaceRequest, setBatchReplaceRequest] = useState(null);
  const batchHandledPagesRef = useRef(new Map());
  const [selectedMovableTextId, setSelectedMovableTextId] = useState(null);
  const [editingMovableText, setEditingMovableText] = useState(null);
  const [availableFonts, setAvailableFonts] = useState([]);
  const [selectedImageId, setSelectedImageId] = useState(null);
  const imageInputRef = useRef(null);
  const [userHighlight, setUserHighlight] = useState({
    keyword: String(highlightKeyword || ''),
    color: 'yellow',
    matchMode: 'contains'
  });
  const [userHighlights, setUserHighlights] = useState([]);

  useEffect(() => {
    setTextMoveMode(false);
    setTextReplaceMode(false);
    setAreaTextReplaceMode(Boolean(isEditMode));
    setSelectedMovableTextId(null);
    setEditingMovableText(null);
  }, [isEditMode]);

  useEffect(() => {
    window.docPilotFonts?.list?.()
      .then((fonts) => setAvailableFonts(Array.isArray(fonts) ? fonts : []))
      .catch(() => setAvailableFonts([]));
  }, []);

  const updateHistoryState = () => {
    const { snapshots, index } = historyRef.current;
    setHistoryState({ canUndo: index > 0, canRedo: index >= 0 && index < snapshots.length - 1, canReset: index > 0 });
  };

  const commitPdfChange = (highlight, replace, nextMovableTexts = movableTexts, selectedMovableTextId = null, nextImages = imageAttachments, nextSelectedImageId = selectedImageId) => {
    const history = historyRef.current;
    const snapshot = { highlight, replace, movableTexts: nextMovableTexts, selectedMovableTextId, imageAttachments: nextImages, selectedImageId: nextSelectedImageId };
    const current = history.snapshots[history.index];
    if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return;
    historyRef.current = history.index < 0
      ? { snapshots: [snapshot], index: 0 }
      : { snapshots: [...history.snapshots.slice(0, history.index + 1), snapshot], index: history.index + 1 };
    updateHistoryState();
  };

  const restorePdfSnapshot = (snapshot) => {
    if (!snapshot) return false;
    // A batch request is a one-time range-to-editor promotion job, not a
    // document change. Leaving it alive lets newly mounted pages (for example
    // after zooming) promote the same ranges again even after Undo/Reset.
    batchHandledPagesRef.current.clear();
    setBatchReplaceRequest(null);
    setUserHighlight(snapshot.highlight);
    setUserHighlights(Array.isArray(snapshot.highlightEntries) ? snapshot.highlightEntries : (snapshot.highlight?.keyword ? [snapshot.highlight] : []));
    setAppliedReplacePreview(snapshot.replace);
    setMovableTexts(snapshot.movableTexts || []);
    setImageAttachments(snapshot.imageAttachments || []);
    setSelectedMovableTextId(snapshot.selectedMovableTextId || null);
    setSelectedImageId(snapshot.selectedImageId || null);
    setEditingMovableText(null);
    return true;
  };

  const undoDocumentChange = () => {
    const history = historyRef.current;
    if (history.index <= 0) return false;
    history.index -= 1;
    restorePdfSnapshot(history.snapshots[history.index]);
    updateHistoryState();
    return true;
  };

  const redoDocumentChange = () => {
    const history = historyRef.current;
    if (history.index >= history.snapshots.length - 1) return false;
    history.index += 1;
    restorePdfSnapshot(history.snapshots[history.index]);
    updateHistoryState();
    return true;
  };

  const resetAllDocumentChanges = () => {
    const history = historyRef.current;
    let reset = false;
    if (history.index > 0 || movableTexts.length || imageAttachments.length || batchReplaceRequest) {
      history.index = 0;
      restorePdfSnapshot(history.snapshots[0] || {
        highlight: { keyword: '', color: 'yellow', matchMode: 'contains' },
        highlightEntries: [],
        replace: null,
        movableTexts: [],
        imageAttachments: [],
        selectedMovableTextId: null,
        selectedImageId: null
      });
      updateHistoryState();
      reset = true;
    }
    return reset;
  };

  const addMovableText = (selection) => {
    const id = `movable-text-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMovableTexts((current) => {
      const next = [...current, { ...selection, id }];
      commitPdfChange(userHighlight, appliedReplacePreview, next, id);
      return next;
    });
    setSelectedMovableTextId(id);
    setEditingMovableText(selection.autoEdit ? {
      id,
      value: String(selection.displayText ?? selection.text ?? ''),
      fontWeight: selection.fontWeight || 'normal',
      fontStyle: selection.fontStyle || 'normal',
      textDecoration: selection.textDecoration || 'none',
      letterSpacing: Number(selection.letterSpacing) || 0,
      verticalAlign: selection.verticalAlign || 'middle',
      baselineOffset: Number.isFinite(Number(selection.baselineOffset))
        ? Number(selection.baselineOffset) : getVerticalBaselineOffset(selection, selection.verticalAlign),
      textAlign: selection.textAlign || 'left',
      fontSize: Number(selection.fontSize) || 10,
      fontFamily: selection.selectedFontFamily || selection.previewFontFamily || '',
      color: selection.color || '#111111'
    } : null);
    return id;
  };

  const addMovableTexts = (selections = []) => {
    const normalized = (Array.isArray(selections) ? selections : []).filter(Boolean);
    if (!normalized.length) return [];
    const entries = normalized.map((selection) => ({
      ...selection,
      id: `movable-text-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }));
    const first = entries[0];
    setMovableTexts((current) => {
      const next = [...current, ...entries];
      commitPdfChange(userHighlight, appliedReplacePreview, next, first.id);
      return next;
    });
    setSelectedMovableTextId(first.id);
    setEditingMovableText({
      id: first.id,
      value: String(first.displayText ?? first.text ?? ''),
      fontWeight: first.fontWeight || 'normal',
      fontStyle: first.fontStyle || 'normal',
      textDecoration: first.textDecoration || 'none',
      letterSpacing: Number(first.letterSpacing) || 0,
      verticalAlign: first.verticalAlign || 'middle',
      baselineOffset: Number.isFinite(Number(first.baselineOffset))
        ? Number(first.baselineOffset) : getVerticalBaselineOffset(first, first.verticalAlign),
      textAlign: first.textAlign || 'left',
      fontSize: Number(first.fontSize) || 10,
      fontFamily: first.selectedFontFamily || first.previewFontFamily || '',
      color: first.color || '#111111'
    });
    return entries.map((entry) => entry.id);
  };

  // Preview-font resolution is visual metadata only. It must not add an undo
  // entry or modify the replacement itself; export uses fontCandidates.
  const updateMovableTextPreviewFont = (id, previewFont) => {
    if (!id || !previewFont?.fontFamily) return;
    setMovableTexts((current) => current.map((item) => (
      item.id === id
        ? {
          ...item,
          renderFontFamily: previewFont.fontFamily,
          previewFontSource: previewFont.source || 'bundled',
          previewFontFamily: previewFont.originalFamily || '',
          selectedFontFamily: previewFont.selectionValue || item.selectedFontFamily || ''
        }
        : item
    )));
    setEditingMovableText((current) => current?.id === id && previewFont.selectionValue
      ? { ...current, fontFamily: previewFont.selectionValue }
      : current);
  };

  const moveMovableText = (id, currentRect) => {
    setMovableTexts((current) => current.map((item) => (
      item.id === id
        ? { ...item, currentRect, movedRect: currentRect, hasChanges: item.persistedToPdf ? true : item.hasChanges }
        : item
    )));
  };

  // Pointer movement updates the preview continuously. Add exactly one history
  // entry when the drag completes so one < press reverts one text move.
  const finishMoveMovableText = (id, currentRect) => {
    const next = movableTexts.map((item) => (
      item.id === id
        ? { ...item, currentRect, movedRect: currentRect, hasChanges: item.persistedToPdf ? true : item.hasChanges }
        : item
    ));
    setMovableTexts(next);
    commitPdfChange(userHighlight, appliedReplacePreview, next, id);
  };

  const selectMovableText = (id) => setSelectedMovableTextId(id);

  const beginEditMovableText = (id) => {
    const item = movableTexts.find((entry) => entry.id === id);
    if (!item) return;
    setSelectedMovableTextId(id);
    setEditingMovableText({
      id,
      value: String(item.displayText ?? item.text ?? ''),
      fontWeight: item.fontWeight || 'normal',
      fontStyle: item.fontStyle || 'normal',
      textDecoration: item.textDecoration || 'none',
      letterSpacing: Number(item.letterSpacing) || 0,
      verticalAlign: item.verticalAlign || 'middle',
      baselineOffset: Number.isFinite(Number(item.baselineOffset))
        ? Number(item.baselineOffset) : getVerticalBaselineOffset(item, item.verticalAlign),
      textAlign: item.textAlign || 'left',
      fontSize: Number(item.fontSize) || 10,
      fontFamily: item.selectedFontFamily || item.previewFontFamily || '',
      color: item.color || '#111111'
    });
  };

  const updateEditingMovableText = (value) => {
    setEditingMovableText((current) => current ? { ...current, value } : current);
  };

  const updateEditingMovableTextStyle = (style) => {
    setEditingMovableText((current) => {
      if (!current) return current;
      const target = movableTexts.find((item) => item.id === current.id);
      const next = { ...current, ...style };
      if (style.verticalAlign && target) {
        next.baselineOffset = getVerticalBaselineOffset(target, style.verticalAlign);
      }
      if (style.fontSize !== undefined && target) {
        const fontSize = Number(style.fontSize);
        if (Number.isFinite(fontSize) && fontSize > 0) {
          next.fontSize = fontSize;
          next.baselineOffset = getVerticalBaselineOffset({ ...target, fontSize }, next.verticalAlign || target.verticalAlign);
        }
      }
      return next;
    });
  };

  const changeEditingMovableTextFont = async (fontFamily) => {
    if (!editingMovableText) return;
    const editingId = editingMovableText.id;
    const target = movableTexts.find((item) => item.id === editingId);
    if (!target) return;
    const fontCandidates = fontFamily
      ? [fontFamily]
      : (target.originalFontCandidates || target.fontCandidates || []);
    const preferBoldFont = fontFamily ? false : (target.originalPreferBoldFont === true || target.preferBoldFont === true);
    // Persist the selected font candidate before resolving the browser
    // preview. The input can blur/commit while FontFace loading is pending;
    // without this immediate update that commit used the old source font for
    // PDF export even though the viewer later displayed the new preview.
    setMovableTexts((current) => current.map((item) => item.id === editingId ? {
      ...item,
      selectedFontFamily: fontFamily,
      fontCandidates,
      preferBoldFont
    } : item));
    setEditingMovableText((current) => current?.id === editingId ? { ...current, fontFamily } : current);
    try {
      const previewFont = await resolveReplacementPreviewFont(fontCandidates, { preferBold: preferBoldFont });
      setMovableTexts((current) => current.map((item) => item.id === editingId ? {
        ...item,
        selectedFontFamily: previewFont.selectionValue || fontFamily,
        fontCandidates,
        preferBoldFont,
        renderFontFamily: previewFont.fontFamily,
        previewFontSource: previewFont.source || 'bundled',
        previewFontFamily: previewFont.originalFamily || fontFamily || item.previewFontFamily || ''
      } : item));
      setEditingMovableText((current) => current?.id === editingId
        ? { ...current, fontFamily: previewFont.selectionValue || fontFamily }
        : current);
    } catch (error) {
      console.warn('[PdfJsViewer] selected font preview unavailable:', error);
    }
  };

  const acknowledgeBatchReplacePage = (requestId, pageNumber) => {
    const activeRequest = batchReplaceRequest;
    if (!activeRequest || activeRequest.id !== requestId) return;
    const targetPages = [...new Set((activeRequest.targets || [])
      .map((target) => Number(target.pageNumber ?? target.page))
      .filter((page) => Number.isInteger(page) && page > 0))];
    const handledPages = batchHandledPagesRef.current.get(requestId) || new Set();
    handledPages.add(Number(pageNumber));
    batchHandledPagesRef.current.set(requestId, handledPages);
    if (targetPages.length && targetPages.every((page) => handledPages.has(page))) {
      batchHandledPagesRef.current.delete(requestId);
      setBatchReplaceRequest((current) => current?.id === requestId ? null : current);
    }
  };

  const cancelEditMovableText = () => setEditingMovableText(null);

  const commitEditMovableText = () => {
    if (!editingMovableText) return;
    const value = String(editingMovableText.value || '').trim();
    const target = movableTexts.find((item) => item.id === editingMovableText.id);
    if (!target || !value) {
      setEditingMovableText(null);
      return;
    }
    setMovableTexts((current) => {
      // Use the latest queued text state so a just-selected font candidate is
      // never overwritten by this input's blur/commit handler.
      const next = current.map((item) => item.id === editingMovableText.id
        ? {
          ...item,
          displayText: value,
          text: value,
          editedText: value,
          hasChanges: item.persistedToPdf ? true : item.hasChanges,
          fontWeight: editingMovableText.fontWeight || item.fontWeight || 'normal',
          fontStyle: editingMovableText.fontStyle || item.fontStyle || 'normal',
          textDecoration: editingMovableText.textDecoration || item.textDecoration || 'none',
          letterSpacing: Number(editingMovableText.letterSpacing) || 0,
          verticalAlign: editingMovableText.verticalAlign || item.verticalAlign || 'middle',
          baselineOffset: Number.isFinite(Number(editingMovableText.baselineOffset))
            ? Number(editingMovableText.baselineOffset)
            : getVerticalBaselineOffset(item, editingMovableText.verticalAlign || item.verticalAlign),
          textAlign: editingMovableText.textAlign || item.textAlign || 'left',
          fontSize: Number(editingMovableText.fontSize) || item.fontSize || 10,
          selectedFontFamily: editingMovableText.fontFamily || item.selectedFontFamily || '',
          color: editingMovableText.color || item.color || '#111111'
        }
        : item);
      commitPdfChange(userHighlight, appliedReplacePreview, next, editingMovableText.id);
      return next;
    });
    setSelectedMovableTextId(editingMovableText.id);
    setEditingMovableText(null);
  };

  const deleteMovableText = (id) => {
    const next = movableTexts.filter((item) => item.id !== id);
    setMovableTexts(next);
    setSelectedMovableTextId(null);
    if (editingMovableText?.id === id) setEditingMovableText(null);
    commitPdfChange(userHighlight, appliedReplacePreview, next, null);
  };

  const getActivePageNumber = () => {
    const viewer = viewerRef.current;
    if (!viewer) return currentPage || 1;
    const middle = viewer.getBoundingClientRect().top + viewer.clientHeight / 2;
    return Number(Object.entries(pageRefs.current).sort(([, first], [, second]) => (
      Math.abs(first.getBoundingClientRect().top - middle) - Math.abs(second.getBoundingClientRect().top - middle)
    ))[0]?.[0]) || currentPage || 1;
  };

  const addImageAttachment = async (event) => {
    const fileToAdd = event.target.files?.[0];
    event.target.value = '';
    if (!fileToAdd) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(fileToAdd.type)) {
      setDownloadFailed(true);
      setDownloadMessage('PNG, JPG/JPEG 또는 WebP 이미지만 첨부할 수 있습니다.');
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'));
      reader.readAsDataURL(fileToAdd);
    });
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('이미지를 열지 못했습니다.'));
      element.src = dataUrl;
    });
    let embeddedDataUrl = dataUrl;
    let mimeType = fileToAdd.type.toLowerCase();
    // pdf-lib embeds PNG/JPEG. Convert WebP to PNG before saving.
    if (mimeType === 'image/webp') {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      embeddedDataUrl = canvas.toDataURL('image/png');
      mimeType = 'image/png';
    }
    const pageNumber = getActivePageNumber();
    const page = pageRefs.current[pageNumber];
    const pageWidth = (page?.clientWidth || 600) / scale;
    const pageHeight = (page?.clientHeight || 800) / scale;
    const aspectRatio = image.naturalWidth / Math.max(image.naturalHeight, 1);
    const initialWidth = Math.min(pageWidth * 0.5, Math.max(72, image.naturalWidth / scale));
    const height = Math.min(pageHeight * 0.5, initialWidth / aspectRatio);
    const width = height * aspectRatio;
    const id = `pdf-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const attachment = {
      id, pageNumber, dataUrl: embeddedDataUrl, mimeType,
      aspectRatio,
      currentRect: { x: Math.max(12, (pageWidth - width) / 2), y: Math.max(12, (pageHeight - height) / 2), width, height },
      sourcePageWidth: pageWidth, sourcePageHeight: pageHeight
    };
    const next = [...imageAttachments, attachment];
    setImageAttachments(next);
    setSelectedImageId(id);
    setSelectedMovableTextId(null);
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, null, next, id);
  };

  const moveImageAttachment = (id, currentRect) => setImageAttachments((items) => items.map((item) => item.id === id ? { ...item, currentRect } : item));
  const finishImageAttachmentMove = (id, currentRect) => {
    const next = imageAttachments.map((item) => item.id === id ? { ...item, currentRect } : item);
    setImageAttachments(next);
    setSelectedImageId(id);
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, next, id);
  };
  const deleteImageAttachment = (id) => {
    const next = imageAttachments.filter((item) => item.id !== id);
    setImageAttachments(next);
    setSelectedImageId(null);
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, next, null);
  };

  const downloadAsPdf = async () => {
    if (downloadStatus !== 'idle') return;
    setDownloadStatus('pdf-running');
    setDownloadMessage('');
    setDownloadFailed(false);
    try {
      // Review selections from an instant replacement already exist in the
      // reloaded PDF. They are UI affordances only until edited or moved.
      const pendingMovableTexts = movableTexts.filter((item) => !item.persistedToPdf || item.hasChanges);
      const highlights = Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]')).flatMap((pageElement) => {
        const pageWidth = pageElement.clientWidth || pageElement.getBoundingClientRect().width;
        const pageHeight = pageElement.clientHeight || pageElement.getBoundingClientRect().height;
        const pageNumber = Number(pageElement.dataset.pageNumber);
        return Array.from(pageElement.querySelectorAll('.highlight-box')).map((box) => ({
          pageNumber,
          sourcePageWidth: pageWidth,
          sourcePageHeight: pageHeight,
          left: Number.parseFloat(box.style.left),
          top: Number.parseFloat(box.style.top),
          width: Number.parseFloat(box.style.width),
          height: Number.parseFloat(box.style.height),
          color: window.getComputedStyle(box).backgroundColor
        }));
      });
      if (appliedReplacePreview?.originalText || pendingMovableTexts.length > 0 || highlights.length > 0 || imageAttachments.length > 0) {
        const result = await onVisualConvert?.({ replacement: appliedReplacePreview, movableTexts: pendingMovableTexts, highlights, images: imageAttachments });
        if (result?.movableTextCount) {
          console.debug('[PdfJsViewer] PDF text move save results', result.textMoveResults?.map((item) => ({
            displayText: item.displayText,
            pageNumber: item.pageNumber,
            directDeleteAttempted: item.directDeleteAttempted,
            directDeleteSucceeded: item.directDeleteSucceeded,
            deleteMode: item.deleteMode,
            fallbackUsed: item.fallbackUsed,
            fallbackReason: item.reason,
            matchedCommandCount: item.matchedCommandCount,
            commandRange: item.commandRange
          })));
          const localFontLabel = result.replacementFontSource === 'local'
            ? ` · PC 원본 계열 글꼴 적용 ${result.localFontAppliedCount || 0}건${result.replacementFontFamily ? ` (${result.replacementFontFamily})` : ''}`
            : '';
          setDownloadMessage(`PDF 저장 완료 · 원본 텍스트 제거 ${result.directEditCount}건 · 배경색 덮기 ${result.fallbackCount}건 · 직접 제거 미확인 ${result.noCoverUnresolvedCount || 0}건 · PDF 내부 원본 글꼴 재사용 ${result.fontPreservedCount}건${localFontLabel}`);
        }
      } else {
        const url = URL.createObjectURL(file);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setDownloadStatus('idle');
    } catch (error) {
      setDownloadFailed(true);
      setDownloadStatus('idle');
      setDownloadMessage(`PDF 다운로드에 실패했습니다. ${error?.message || ''}`.trim());
    }
  };

  const clearAppliedHighlights = () => {
    const clearedHighlight = { keyword: '', color: 'yellow', matchMode: 'contains', selectedTargets: [] };
    setUserHighlight(clearedHighlight);
    setUserHighlights([]);
    commitPdfChange(clearedHighlight, appliedReplacePreview);
    setDownloadMessage('하이라이트를 제거했습니다.');
    setDownloadFailed(false);
    return true;
  };

  const hasAppliedHighlights = Array.isArray(userHighlight.selectedTargets)
    ? userHighlight.selectedTargets.length > 0
    : Boolean(userHighlight.keyword);

  console.log('[PdfJsViewer] file:', file);

  const ensurePdfTextPages = async () => {
    if (pagesTextRef.current.length > 0) {
      return pagesTextRef.current;
    }

    if (!pdfDocumentRef.current) {
      return [];
    }

    const pages = await extractAllPdfText(pdfDocumentRef.current);
    pagesTextRef.current = pages;
    return pages;
  };

  const scrollToPdfSearchResult = (result) => {
    const target = result?.raw || result || {};
    const pageNumber = Number(target.pageNumber ?? target.page);

    if (!Number.isFinite(pageNumber)) {
      console.warn('[PdfJsViewer] invalid search result target:', result);
      return false;
    }

    const pageElement = pageRefs.current[pageNumber];
    if (!pageElement) {
      console.warn('[PdfJsViewer] search target page not rendered:', pageNumber);
      return false;
    }

    const viewerElement = viewerRef.current;
    if (viewerElement) {
      const targetTop = pageElement.offsetTop - viewerElement.clientHeight / 4;
      viewerElement.scrollTo({
        top: Math.max(targetTop, 0),
        behavior: 'smooth'
      });
      return true;
    }

    pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  };

  useImperativeHandle(ref, () => ({
    async getDocumentText() {
      try {
        const pages = await ensurePdfTextPages();
        return formatPdfPagesText(pages);
      } catch (error) {
        console.warn('[PdfJsViewer] document text extraction failed:', error);
        return '';
      }
    },
    async searchDocument(keyword, options) {
      const pages = await ensurePdfTextPages();
      const documentText = pages.map((page) => ({
        page: page.pageNumber,
        lines: page.lines.map((line) => line.text)
      }));
      const sourceResults = searchKeywordInDocument(documentText, keyword, options);
      const replacementResults = getReplacementSearchResults(keyword, options, movableTexts);
      return filterMovedSourceSearchResults(
        [...sourceResults, ...replacementResults], movableTexts
      );
    },
    getPdfHighlights() {
      return Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]')).flatMap((pageElement) => {
        const pageWidth = pageElement.clientWidth || pageElement.getBoundingClientRect().width;
        const pageHeight = pageElement.clientHeight || pageElement.getBoundingClientRect().height;
        const pageNumber = Number(pageElement.dataset.pageNumber);
        return Array.from(pageElement.querySelectorAll('.highlight-box')).map((box) => ({
          pageNumber,
          sourcePageWidth: pageWidth,
          sourcePageHeight: pageHeight,
          left: Number.parseFloat(box.style.left),
          top: Number.parseFloat(box.style.top),
          width: Number.parseFloat(box.style.width),
          height: Number.parseFloat(box.style.height),
          color: window.getComputedStyle(box).backgroundColor
        }));
      });
    },
    getMovableTexts() {
      return movableTexts;
    },
    getInstantReplacementReviewItems() {
      return collectInstantReplacementReviewItems(scale);
    },
    setPersistedReplacementReviewItems(items) {
      const next = (Array.isArray(items) ? items : []).map((item) => ({
        ...item,
        persistedToPdf: true,
        hasChanges: false,
        coverRects: [],
        sourceSelection: null
      }));
      setMovableTexts((current) => [...current, ...next]);
      return next.length;
    },
    scrollToSearchResult(result) {
      return scrollToPdfSearchResult(result);
    },
    clearSearchSelection() {
      // PDF 검색은 별도의 검색 선택 DOM을 만들지 않으므로 초기화할 항목이 없습니다.
    },
    async highlightText(keyword, options = {}) {
      const normalizedKeyword = String(keyword || '').trim();
      const color = ['yellow', 'green', 'blue', 'pink'].includes(options?.color)
        ? options.color
        : 'yellow';
      const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';

      if (!normalizedKeyword) {
        setUserHighlight({ keyword: '', color, matchMode });
        return { count: 0, results: [] };
      }

      const pages = await ensurePdfTextPages();
      const documentText = pages.map((page) => ({
        page: page.pageNumber,
        lines: page.lines.map((line) => line.text)
      }));
      const allResults = searchKeywordInDocument(
        documentText,
        normalizedKeyword,
        { matchMode }
      ).map((result, index) => ({
        ...result,
        id: result.id || `pdf-highlight-${result.pageNumber}-${result.lineNumber}-${index}`,
        color
      }));
      const replacementResults = getReplacementSearchResults(
        normalizedKeyword,
        { matchMode },
        movableTexts
      );
      const allSearchResults = [...allResults, ...replacementResults];
      const selectedTargets = Array.isArray(options?.selectedTargets) ? options.selectedTargets : null;
      const results = selectedTargets
        ? allSearchResults.flatMap((result) => {
          const selectedTarget = selectedTargets.find((target) => {
            const raw = target?.raw || target || {};
            return Number(raw.pageNumber ?? raw.page) === result.pageNumber
              && Number(raw.lineNumber ?? raw.line) === result.lineNumber
              && Number(raw.matchIndex) === result.matchIndex;
          });
          if (!selectedTarget) return [];
          const targetColor = selectedTarget?.color;
          return [{
            ...result,
            color: ['yellow', 'green', 'blue', 'pink'].includes(targetColor) ? targetColor : color
          }];
        })
        : allSearchResults;

      const nextHighlight = {
        keyword: normalizedKeyword,
        color,
        matchMode,
        selectedTargets: results,
        replacementTargets: results.filter((result) => result.isReplacement)
      };
      setUserHighlight(nextHighlight);
      setUserHighlights((current) => [...current, nextHighlight]);
      commitPdfChange({ keyword: normalizedKeyword, color, matchMode, selectedTargets: results }, appliedReplacePreview);
      return { count: results.length, results };
    },
    async replaceText(originalText, newText, options = {}) {
      const pages = await ensurePdfTextPages();
      const matchMode = options.matchMode === 'exact' ? 'exact' : 'contains';
      const matches = searchKeywordInDocument(pages.map((page) => ({
        page: page.pageNumber, lines: page.lines.map((line) => line.text)
      })), originalText, { matchMode });
      const pageMatchOrdinals = new Map();
      const positionedMatches = matches.map((match) => {
        const pageNumber = Number(match.pageNumber ?? match.page);
        const pageMatchOrdinal = pageMatchOrdinals.get(pageNumber) || 0;
        pageMatchOrdinals.set(pageNumber, pageMatchOrdinal + 1);
        return { ...match, pageMatchOrdinal };
      });
      const results = Array.isArray(options.selectedTargets)
        ? positionedMatches.filter((match) => options.selectedTargets.some((target) => {
          const raw = target.raw || target;
          return Number(raw.pageNumber ?? raw.page) === match.pageNumber
            && Number(raw.lineNumber ?? raw.line) === match.lineNumber
            && Number(raw.matchIndex) === match.matchIndex;
      }))
        : positionedMatches;
      if (results.length) {
        // Resolve each hit to a browser Range in PdfPage. This reuses the
        // manual drag-selection geometry instead of the line preview path.
        setViewMode('scroll');
        setAppliedReplacePreview(null);
        const requestId = `batch-range-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        batchHandledPagesRef.current.delete(requestId);
        setBatchReplaceRequest({
          id: requestId,
          originalText,
          newText,
          targets: results
        });
        return { count: results.length, replaceCount: results.length, results };

        const nextReplace = { originalText, newText, matchMode, selectedTargets: results };
        // Search results do not carry browser Range geometry. Render the
        // preview first, then promote its exact rectangles to the same
        // movable-text objects used by a manual "텍스트 교체" selection.
        setViewMode('scroll');
        setAppliedReplacePreview(nextReplace);
        let previewItems = [];
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          previewItems = collectInstantReplacementReviewItems(scale);
          if (previewItems.length >= results.length) break;
        }
        if (previewItems.length < results.length) {
          setAppliedReplacePreview(null);
          throw new Error(`검색된 ${results.length}건 중 ${previewItems.length}건의 교체 위치만 준비되었습니다. 문서 화면이 모두 표시된 뒤 다시 적용해주세요.`);
        }

        const batchItems = previewItems.map((item, index) => ({
          ...item,
          id: `batch-replace-${item.id}-${index}`,
          // The source text is retained only to remove/hide the old glyphs
          // on export. The object itself always displays and edits newText.
          sourceText: item.previousSourceText || originalText,
          originalText: item.previousSourceText || originalText,
          originalUnicodeText: item.previousSourceText || originalText,
          previousSourceText: item.previousSourceText || originalText,
          persistedToPdf: false,
          hasChanges: false,
          coverRects: [item.originalRect],
          allowMove: false,
          sourceSelection: null
        }));
        setAppliedReplacePreview(null);
        setMovableTexts((current) => {
          const next = [...current, ...batchItems];
          commitPdfChange(userHighlight, null, next, batchItems[0]?.id || null);
          return next;
        });
        setSelectedMovableTextId(batchItems[0]?.id || null);
        setEditingMovableText(null);
      }
      return { count: results.length, replaceCount: results.length, results };
    },
    scrollToReplaceResult(result) {
      return scrollToPdfSearchResult(result);
    },
    clearHighlights() {
      return clearAppliedHighlights();
    },
    undoDocumentChange() {
      return undoDocumentChange();
    },
    redoDocumentChange() {
      return redoDocumentChange();
    },
    resetAllDocumentChanges() {
      return resetAllDocumentChanges();
    },
    downloadAsPdf,
    scrollToHighlightResult(result) {
      return scrollToPdfSearchResult(result);
    }
  }));

  useEffect(() => {
    setAppliedReplacePreview(replacePreview?.mode === 'review' ? null : replacePreview);
    setVisualConvertStatus('idle');
    setVisualConvertMessage('');
  }, [file, replacePreview]);

  useEffect(() => {
    if (replacePreview?.mode !== 'review' || !pdfDocument || !Array.isArray(replacePreview.items)) return;
    const reviewItems = replacePreview.items.map((item) => ({ ...item, coverRects: [] }));
    if (!reviewItems.length) return;
    setMovableTexts(reviewItems);
    setSelectedMovableTextId(reviewItems[0].id);
    setEditingMovableText(null);
    setTextMoveMode(true);
    commitPdfChange(userHighlight, null, reviewItems, reviewItems[0].id);
  }, [pdfDocument, replacePreview]);

  const handleVisualConvert = async () => {
    if ((!appliedReplacePreview?.originalText || appliedReplacePreview?.newText == null) && movableTexts.length === 0) return;

    setVisualConvertStatus('running');
    setVisualConvertMessage('');
    try {
      const result = await onVisualConvert?.({ replacement: appliedReplacePreview, movableTexts });
      setVisualConvertStatus('success');
      setVisualConvertMessage(`${result?.replaceCount ?? 0}건 변환 완료`);
    } catch (error) {
      console.error('[PdfJsViewer] visual PDF conversion failed:', error);
      setVisualConvertStatus('error');
      setVisualConvertMessage(error?.message || '변환 파일을 생성하지 못했습니다.');
    }
  };

  useEffect(() => {
    console.log('[PdfJsViewer] highlightKeyword:', highlightKeyword);
    if (highlightKeyword !== undefined && highlightKeyword !== null) {
      setUserHighlight((current) => ({
        ...current,
        keyword: String(highlightKeyword || '')
      }));
    }
  }, [highlightKeyword]);

  useEffect(() => {
    console.log('[PdfJsViewer] selectedSearchResult:', selectedSearchResult);
  }, [selectedSearchResult]);

  useEffect(() => {
    let cancelled = false;
    let activeLoadingTask = null;

    async function loadPdf() {
      pagesTextRef.current = [];
      pdfDocumentRef.current = null;
      historyRef.current = {
        snapshots: [{
          highlight: { keyword: String(highlightKeyword || ''), color: 'yellow', matchMode: 'contains' },
          replace: replacePreview?.mode === 'review' ? null : replacePreview,
          movableTexts: [],
          selectedMovableTextId: null,
          imageAttachments: [],
          selectedImageId: null
        }],
        index: 0
      };
      updateHistoryState();
      setPdfDocument(null);
      setPageNumbers([]);
      setCurrentPage(1);
      setViewMode('scroll');
      setTextMoveMode(false);
      setMovableTexts([]);
      setImageAttachments([]);
      setBatchReplaceRequest(null);
      setSelectedMovableTextId(null);
      setSelectedImageId(null);
      setEditingMovableText(null);
      setErrorMessage('');
      setDownloadMessage('');
      setDownloadFailed(false);

      if (!file || !isPdfFile(file)) {
        setPdfDocument(null);
        setPageNumbers([]);
        setErrorMessage('');
        return;
      }

      try {
        console.log('[PdfJsViewer] start render:', file?.name);
        const arrayBuffer = await file.arrayBuffer();
        if (cancelled) return;
        console.log('[PdfJsViewer] arrayBuffer size:', arrayBuffer.byteLength);
        const { loadingTask, pdf } = await loadPdfDocument(arrayBuffer, {
          onLoadingTask: (task) => { activeLoadingTask = task; }
        });
        console.log('[PdfJsViewer] pdf loaded pages:', pdf.numPages);

        if (cancelled) {
          if (typeof loadingTask.destroy === 'function') await loadingTask.destroy();
          return;
        }

        pdfDocumentRef.current = pdf;
        setPdfDocument(pdf);
        setPageNumbers(Array.from({ length: pdf.numPages }, (_, index) => index + 1));
        setErrorMessage('');

        extractAllPdfText(pdf)
          .then((pages) => {
            if (!cancelled && pdfDocumentRef.current === pdf) {
              pagesTextRef.current = pages;
              console.log('[PdfJsViewer] document text cached:', {
                pages: pages.length,
                textLength: formatPdfPagesText(pages).length
              });
            }
          })
          .catch((error) => {
            console.warn('[PdfJsViewer] background text extraction failed:', error);
          });
      } catch (error) {
        if (error?.name === 'RenderingCancelledException') {
          return;
        }

        console.error('[PdfJsViewer] Failed to load PDF document', error);

        if (!cancelled) {
          pdfDocumentRef.current = null;
          pagesTextRef.current = [];
          setPdfDocument(null);
          setPageNumbers([]);
          setErrorMessage(error?.name === 'PasswordException'
            ? '암호로 보호된 PDF입니다. 암호를 해제한 파일을 다시 선택해주세요.'
            : 'PDF를 열 수 없습니다. 파일이 손상되지 않았는지 확인한 뒤 다시 선택해주세요.');
        }
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
      pdfDocumentRef.current = null;
      pagesTextRef.current = [];
      setPdfDocument(null);
      setPageNumbers([]);
      pageRefs.current = {};

      if (typeof activeLoadingTask?.destroy === 'function') {
        activeLoadingTask.destroy().catch((error) => {
          console.warn('[PdfJsViewer] PDF cleanup failed:', error);
        });
      }
    };
  }, [file]);

  useEffect(() => {
    if (!selectedSearchResult) {
      return;
    }

    const result = selectedSearchResult;
    const pageNumber = Number(result.pageNumber ?? result.page);
    const pageElement = pageRefs.current[pageNumber];

    console.log('[PdfJsViewer] target page element:', pageElement);
    console.log('[PdfJsViewer] scroll target:', {
      page: pageNumber,
      x: result.x,
      y: result.y
    });

    if (!pageElement) {
      return;
    }

    const viewerElement = viewerRef.current;

    if (
      viewerElement &&
      Number.isFinite(result.x) &&
      Number.isFinite(result.y)
    ) {
      const targetTop =
        pageElement.offsetTop + result.y - viewerElement.clientHeight / 2;

      viewerElement.scrollTo({
        top: Math.max(targetTop, 0),
        behavior: 'smooth'
      });

      return;
    }

    scrollToPdfSearchResult(result);
  }, [selectedSearchResult, scale, pageNumbers]);

  if (errorMessage) {
    return <div className="pdf-loading" role="alert">{errorMessage}</div>;
  }

  if (!pdfDocument) {
    return <div className="pdf-loading">PDF 미리보기를 준비 중입니다...</div>;
  }

  return (
    <div className="pdf-viewer-shell">
      <div className="pdf-view-mode-controls document-toolbar" aria-label="PDF 보기 방식">
        <div className="pdf-view-mode-toggle-group">
          {pageNumbers.length > 1 ? (
            <div className="pdf-view-mode-toggle" role="group" aria-label="보기 방식 선택">
              <button type="button" className={viewMode === 'scroll' ? 'active' : ''} onClick={() => setViewMode('scroll')} aria-pressed={viewMode === 'scroll'}>스크롤</button>
              <button type="button" className={viewMode === 'page' ? 'active' : ''} onClick={() => setViewMode('page')} aria-pressed={viewMode === 'page'}>페이지 이동</button>
            </div>
          ) : null}
          <div className="pdf-edit-mode-toggle" role="group" aria-label="문서 모드 선택">
            <button type="button" className={!isEditMode ? 'active' : ''} onClick={() => onEditModeChange?.(false)} aria-pressed={!isEditMode}>뷰어</button>
            <button type="button" className={isEditMode ? 'active' : ''} onClick={() => onEditModeChange?.(true)} aria-pressed={isEditMode}>편집</button>
          </div>
        </div>
        {pageNumbers.length > 1 && viewMode === 'page' ? (
          <div className="pdf-page-navigation" role="group" aria-label="페이지 이동">
            <button type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage === 1}>이전</button>
            <span aria-live="polite">{currentPage} / {pageNumbers.length}</span>
            <button type="button" onClick={() => setCurrentPage((page) => Math.min(pageNumbers.length, page + 1))} disabled={currentPage === pageNumbers.length}>다음</button>
          </div>
        ) : null}
        <div className="pdf-document-history" role="group" aria-label="문서 변경 이력">
          <button type="button" onClick={undoDocumentChange} disabled={!isEditMode || !historyState.canUndo} aria-label="적용 전으로 되돌리기">&lt;</button>
          <button type="button" onClick={redoDocumentChange} disabled={!isEditMode || !historyState.canRedo} aria-label="다시 적용하기">&gt;</button>
          <button type="button" className="pdf-reset-all-button" onClick={resetAllDocumentChanges} disabled={!isEditMode || (!historyState.canReset && movableTexts.length === 0 && imageAttachments.length === 0)}>전체 초기화</button>
          <button
            type="button"
            className={`pdf-text-move-button ${textMoveMode ? 'active' : ''}`}
            onClick={() => {
              const next = !textMoveMode;
              setTextMoveMode(next);
              setTextReplaceMode(false);
              setAreaTextReplaceMode(!next);
              setSelectedMovableTextId(null);
              setEditingMovableText(null);
            }}
            disabled={!isEditMode}
            aria-pressed={textMoveMode}
            title={textMoveMode ? 'PDF 텍스트 이동을 종료합니다.' : 'PDF 본문에서 한 줄의 텍스트를 선택해 이동합니다.'}
          >
            텍스트 이동
          </button>
          <button
            type="button"
            className={`pdf-text-move-button ${textReplaceMode ? 'active' : ''}`}
            onClick={() => {
              const next = !textReplaceMode;
              setTextReplaceMode(next);
              setTextMoveMode(false);
              setAreaTextReplaceMode(!next);
              setSelectedMovableTextId(null);
              setEditingMovableText(null);
            }}
            disabled={!isEditMode}
            aria-pressed={textReplaceMode}
            title={textReplaceMode ? 'PDF 텍스트 교체를 종료합니다.' : 'PDF 본문에서 변경할 텍스트를 선택한 뒤 새 내용을 입력합니다.'}
          >
            텍스트 교체
          </button>
          <button type="button" className="pdf-text-move-button" disabled={!isEditMode} onClick={() => imageInputRef.current?.click()} title="현재 보고 있는 PDF 페이지에 이미지를 첨부합니다.">이미지 첨부</button>
          <input ref={imageInputRef} className="pdf-image-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={addImageAttachment} />
        </div>
        {toolbarActions}
        <div className="viewer-download-actions">
          {hasAppliedHighlights ? (
            <button
              type="button"
              className="viewer-highlight-clear-button"
              onClick={clearAppliedHighlights}
              disabled={downloadStatus !== 'idle'}
            >
              하이라이트 제거
            </button>
          ) : null}
          <span className="viewer-download-label">다운로드</span>
          <button
            type="button"
            className="viewer-download-button pdf"
            onClick={downloadAsPdf}
            disabled={downloadStatus !== 'idle'}
            aria-label="PDF 다운로드"
          >
            {downloadStatus === 'pdf-running' ? 'PDF 변환 중...' : 'PDF'}
          </button>
        </div>
      </div>
      {downloadMessage ? <div className={`pdf-visual-convert-message${downloadFailed ? ' is-error' : ''}`} role={downloadFailed ? 'alert' : 'status'}>{downloadMessage}</div> : null}
      {isEditMode ? <TextEditFormatToolbar
        editing={editingMovableText}
        onChange={updateEditingMovableTextStyle}
        onCommit={commitEditMovableText}
        fonts={availableFonts}
        onFontChange={changeEditingMovableTextFont}
      /> : null}
      <div ref={viewerRef} className="document-body-scroll pdf-viewer pdf-viewer-scroll">
        <div className="pdf-viewer-stack">
          {pageNumbers.map((pageNumber) => (
            <div key={`${pageNumber}-${scale}`} hidden={viewMode === 'page' && currentPage !== pageNumber}>
              <PdfPage
                pdf={pdfDocument}
                pageNumber={pageNumber}
                scale={scale}
                highlightKeyword={userHighlight.keyword}
                highlightOptions={userHighlight}
                highlightEntries={userHighlights}
                findResult={selectedSearchResult}
                replacePreview={appliedReplacePreview}
                batchReplaceRequest={batchReplaceRequest}
                onBatchReplaceHandled={acknowledgeBatchReplacePage}
                textMoveMode={textMoveMode}
                textReplaceMode={textReplaceMode}
                areaTextReplaceMode={isEditMode && areaTextReplaceMode}
                editingEnabled={isEditMode}
                movableTexts={movableTexts.filter((item) => item.pageNumber === pageNumber)}
                imageAttachments={imageAttachments.filter((item) => item.pageNumber === pageNumber)}
                selectedMovableTextId={selectedMovableTextId}
                editingMovableText={editingMovableText}
                onCreateMovableText={addMovableText}
                onCreateMovableTexts={addMovableTexts}
                onUpdateMovableTextPreviewFont={updateMovableTextPreviewFont}
                onMoveMovableText={moveMovableText}
                onMoveMovableTextEnd={finishMoveMovableText}
                onSelectMovableText={selectMovableText}
                onBeginEditMovableText={beginEditMovableText}
                onChangeEditMovableText={updateEditingMovableText}
                onChangeEditMovableTextStyle={updateEditingMovableTextStyle}
                onCommitEditMovableText={commitEditMovableText}
                onCancelEditMovableText={cancelEditMovableText}
                onDeleteMovableText={deleteMovableText}
                selectedImageId={selectedImageId}
                onSelectImage={setSelectedImageId}
                onMoveImage={moveImageAttachment}
                onMoveImageEnd={finishImageAttachmentMove}
                onDeleteImage={deleteImageAttachment}
                onPageReady={(element) => {
                  if (element) pageRefs.current[pageNumber] = element;
                  else delete pageRefs.current[pageNumber];
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

export default PdfJsViewer;
