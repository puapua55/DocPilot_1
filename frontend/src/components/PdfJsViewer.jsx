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

const PdfJsViewer = forwardRef(function PdfJsViewer({ file, highlightKeyword, selectedSearchResult, replacePreview, scale = 1, toolbarActions, onVisualConvert }, ref) {
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pageNumbers, setPageNumbers] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [appliedReplacePreview, setAppliedReplacePreview] = useState(replacePreview);
  const [visualConvertStatus, setVisualConvertStatus] = useState('idle');
  const [visualConvertMessage, setVisualConvertMessage] = useState('');
  const [downloadStatus, setDownloadStatus] = useState('idle');
  const [downloadMessage, setDownloadMessage] = useState('');
  const pdfDocumentRef = useRef(null);
  const pagesTextRef = useRef([]);
  const viewerRef = useRef(null);
  const pageRefs = useRef({});
  const historyRef = useRef({ snapshots: [], index: -1 });
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false, canReset: false });
  const [viewMode, setViewMode] = useState('scroll');
  const [currentPage, setCurrentPage] = useState(1);
  const [userHighlight, setUserHighlight] = useState({
    keyword: String(highlightKeyword || ''),
    color: 'yellow',
    matchMode: 'contains'
  });

  const updateHistoryState = () => {
    const { snapshots, index } = historyRef.current;
    setHistoryState({ canUndo: index > 0, canRedo: index >= 0 && index < snapshots.length - 1, canReset: index > 0 });
  };

  const commitPdfChange = (highlight, replace) => {
    const history = historyRef.current;
    const snapshot = { highlight, replace };
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
    if (history.index <= 0) return false;
    history.index = 0;
    restorePdfSnapshot(history.snapshots[0]);
    updateHistoryState();
    return true;
  };

  const downloadAsPdf = async () => {
    if (downloadStatus !== 'idle') return;
    setDownloadStatus('pdf-running');
    setDownloadMessage('');
    try {
      if (appliedReplacePreview?.originalText) {
        await onVisualConvert?.(appliedReplacePreview);
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
      return searchKeywordInDocument(documentText, keyword, options);
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
      const results = Array.isArray(options.selectedTargets)
        ? matches.filter((match) => options.selectedTargets.some((target) => {
          const raw = target.raw || target;
          return Number(raw.pageNumber ?? raw.page) === match.pageNumber
            && Number(raw.lineNumber ?? raw.line) === match.lineNumber
            && Number(raw.matchIndex) === match.matchIndex;
        }))
        : matches;
      if (results.length) {
        const nextReplace = { originalText, newText, matchMode, selectedTargets: results };
        setAppliedReplacePreview(nextReplace);
        commitPdfChange(userHighlight, nextReplace);
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
    setAppliedReplacePreview(replacePreview);
    setVisualConvertStatus('idle');
    setVisualConvertMessage('');
  }, [file, replacePreview]);

  const handleVisualConvert = async () => {
    if (!appliedReplacePreview?.originalText || appliedReplacePreview?.newText == null) return;

    setVisualConvertStatus('running');
    setVisualConvertMessage('');
    try {
      const result = await onVisualConvert?.(appliedReplacePreview);
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
          replace: replacePreview
        }],
        index: 0
      };
      updateHistoryState();
      setPdfDocument(null);
      setPageNumbers([]);
      setCurrentPage(1);
      setViewMode('scroll');
      setErrorMessage('');

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
      <div className="pdf-view-mode-controls" aria-label="PDF 보기 방식">
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
          <button type="button" className="pdf-reset-all-button" onClick={resetAllDocumentChanges} disabled={!historyState.canReset}>전체 초기화</button>
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
      {downloadMessage ? <div className="pdf-visual-convert-message is-error" role="alert">{downloadMessage}</div> : null}
      <div ref={viewerRef} className="pdf-viewer pdf-viewer-scroll">
        <div className="pdf-viewer-stack">
          {pageNumbers.map((pageNumber) => (
            <div key={`${pageNumber}-${scale}`} hidden={viewMode === 'page' && currentPage !== pageNumber}>
              <PdfPage
                pdf={pdfDocument}
                pageNumber={pageNumber}
                scale={scale}
                highlightKeyword={userHighlight.keyword}
                highlightOptions={userHighlight}
                replacePreview={appliedReplacePreview}
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
