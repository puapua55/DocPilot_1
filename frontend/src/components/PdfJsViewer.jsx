import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import PdfPage from './PdfPage';
import { loadPdfDocument } from '../services/pdfService';
import { searchKeywordInDocument } from '../services/searchService';
import { isPdfFile } from '../utils/fileUtils';

function normalizePdfLines(textItems) {
  const groupedLines = [];

  textItems.forEach((item) => {
    const value = String(item?.str || '').trim();
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
      text: line.parts.join(' ').replace(/\s+/g, ' ').trim()
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

const PdfJsViewer = forwardRef(function PdfJsViewer({ file, highlightKeyword, selectedSearchResult, replacePreview, scale = 1, toolbarActions, onVisualConvert }, ref) {
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
  const [movableTexts, setMovableTexts] = useState([]);
  const [imageAttachments, setImageAttachments] = useState([]);
  const [batchReplaceRequest, setBatchReplaceRequest] = useState(null);
  const [selectedMovableTextId, setSelectedMovableTextId] = useState(null);
  const [editingMovableText, setEditingMovableText] = useState(null);
  const [selectedImageId, setSelectedImageId] = useState(null);
  const imageInputRef = useRef(null);
  const [userHighlight, setUserHighlight] = useState({
    keyword: String(highlightKeyword || ''),
    color: 'yellow',
    matchMode: 'contains'
  });

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
    setUserHighlight(snapshot.highlight);
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
    if (history.index > 0) {
      history.index = 0;
      restorePdfSnapshot(history.snapshots[0]);
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
      color: selection.color || '#111111'
    } : null);
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
      color: item.color || '#111111'
    });
  };

  const updateEditingMovableText = (value) => {
    setEditingMovableText((current) => current ? { ...current, value } : current);
  };

  const updateEditingMovableTextStyle = (style) => {
    setEditingMovableText((current) => current ? { ...current, ...style } : current);
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
    const next = movableTexts.map((item) => item.id === editingMovableText.id
      ? {
        ...item,
        displayText: value,
        text: value,
        editedText: value,
        hasChanges: item.persistedToPdf ? true : item.hasChanges,
        fontWeight: editingMovableText.fontWeight || item.fontWeight || 'normal',
        fontStyle: editingMovableText.fontStyle || item.fontStyle || 'normal',
        textDecoration: editingMovableText.textDecoration || item.textDecoration || 'none',
        color: editingMovableText.color || item.color || '#111111'
      }
      : item);
    setMovableTexts(next);
    setSelectedMovableTextId(editingMovableText.id);
    setEditingMovableText(null);
    commitPdfChange(userHighlight, appliedReplacePreview, next, editingMovableText.id);
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
          setDownloadMessage(`PDF 저장 완료 · 원본 텍스트 제거 ${result.directEditCount}건 · 배경색 덮기 ${result.fallbackCount}건 · 직접 제거 미확인 ${result.noCoverUnresolvedCount || 0}건 · 원본 글꼴 유지 ${result.fontPreservedCount}건`);
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
      return filterMovedSourceSearchResults(
        searchKeywordInDocument(documentText, keyword, options), movableTexts
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
      const results = searchKeywordInDocument(
        documentText,
        normalizedKeyword,
        { matchMode }
      ).map((result, index) => ({
        ...result,
        id: result.id || `pdf-highlight-${result.pageNumber}-${result.lineNumber}-${index}`,
        color
      }));

      setUserHighlight({ keyword: normalizedKeyword, color, matchMode });
      commitPdfChange({ keyword: normalizedKeyword, color, matchMode }, appliedReplacePreview);
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
        setBatchReplaceRequest({
          id: `batch-range-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
          allowMove: true,
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
      setUserHighlight({
        keyword: '',
        color: 'yellow',
        matchMode: 'contains'
      });
      commitPdfChange({ keyword: '', color: 'yellow', matchMode: 'contains' }, appliedReplacePreview);
      return true;
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
        {pageNumbers.length > 1 ? (
          <>
            <div className="pdf-view-mode-toggle" role="group" aria-label="보기 방식 선택">
              <button type="button" className={viewMode === 'scroll' ? 'active' : ''} onClick={() => setViewMode('scroll')} aria-pressed={viewMode === 'scroll'}>스크롤</button>
              <button type="button" className={viewMode === 'page' ? 'active' : ''} onClick={() => setViewMode('page')} aria-pressed={viewMode === 'page'}>페이지 이동</button>
            </div>
            {viewMode === 'page' ? (
              <div className="pdf-page-navigation" role="group" aria-label="페이지 이동">
                <button type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage === 1}>이전</button>
                <span aria-live="polite">{currentPage} / {pageNumbers.length}</span>
                <button type="button" onClick={() => setCurrentPage((page) => Math.min(pageNumbers.length, page + 1))} disabled={currentPage === pageNumbers.length}>다음</button>
              </div>
            ) : null}
          </>
        ) : null}
        <div className="pdf-document-history" role="group" aria-label="문서 변경 이력">
          <button type="button" onClick={undoDocumentChange} disabled={!historyState.canUndo} aria-label="적용 전으로 되돌리기">&lt;</button>
          <button type="button" onClick={redoDocumentChange} disabled={!historyState.canRedo} aria-label="다시 적용하기">&gt;</button>
          <button type="button" className="pdf-reset-all-button" onClick={resetAllDocumentChanges} disabled={!historyState.canReset && movableTexts.length === 0 && imageAttachments.length === 0}>전체 초기화</button>
          <button
            type="button"
            className={`pdf-text-move-button ${textMoveMode ? 'active' : ''}`}
            onClick={() => {
              setTextMoveMode((current) => !current);
              setTextReplaceMode(false);
              setSelectedMovableTextId(null);
              setEditingMovableText(null);
            }}
            aria-pressed={textMoveMode}
            title={textMoveMode ? 'PDF 텍스트 이동을 종료합니다.' : 'PDF 본문에서 한 줄의 텍스트를 선택해 이동합니다.'}
          >
            텍스트 이동
          </button>
          <button
            type="button"
            className={`pdf-text-move-button ${textReplaceMode ? 'active' : ''}`}
            onClick={() => {
              setTextReplaceMode((current) => !current);
              setTextMoveMode(false);
              setSelectedMovableTextId(null);
              setEditingMovableText(null);
            }}
            aria-pressed={textReplaceMode}
            title={textReplaceMode ? 'PDF 텍스트 교체를 종료합니다.' : 'PDF 본문에서 변경할 텍스트를 선택한 뒤 새 내용을 입력합니다.'}
          >
            텍스트 교체
          </button>
          <button type="button" className="pdf-text-move-button" onClick={() => imageInputRef.current?.click()} title="현재 보고 있는 PDF 페이지에 이미지를 첨부합니다.">이미지 첨부</button>
          <input ref={imageInputRef} className="pdf-image-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={addImageAttachment} />
        </div>
        {toolbarActions}
        <div className="viewer-download-actions">
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
                findResult={selectedSearchResult}
                replacePreview={appliedReplacePreview}
                batchReplaceRequest={batchReplaceRequest}
                textMoveMode={textMoveMode}
                textReplaceMode={textReplaceMode}
                movableTexts={movableTexts.filter((item) => item.pageNumber === pageNumber)}
                imageAttachments={imageAttachments.filter((item) => item.pageNumber === pageNumber)}
                selectedMovableTextId={selectedMovableTextId}
                editingMovableText={editingMovableText}
                onCreateMovableText={addMovableText}
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
