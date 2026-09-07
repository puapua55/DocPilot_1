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

const PdfJsViewer = forwardRef(function PdfJsViewer({ file, highlightKeyword, selectedSearchResult, replacePreview, scale = 1 }, ref) {
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pageNumbers, setPageNumbers] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const loadingTaskRef = useRef(null);
  const pdfDocumentRef = useRef(null);
  const pagesTextRef = useRef([]);
  const viewerRef = useRef(null);
  const pageRefs = useRef({});

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
    scrollToSearchResult(result) {
      return scrollToPdfSearchResult(result);
    },
    clearSearchSelection() {
      // PDF 검색은 별도의 검색 선택 DOM을 만들지 않으므로 초기화할 항목이 없습니다.
    }
  }));

  useEffect(() => {
    console.log('[PdfJsViewer] highlightKeyword:', highlightKeyword);
  }, [highlightKeyword]);

  useEffect(() => {
    console.log('[PdfJsViewer] selectedSearchResult:', selectedSearchResult);
  }, [selectedSearchResult]);

  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      pagesTextRef.current = [];
      pdfDocumentRef.current = null;

      if (!file || !isPdfFile(file)) {
        setPdfDocument(null);
        setPageNumbers([]);
        setErrorMessage('');
        return;
      }

      try {
        console.log('[PdfJsViewer] start render:', file?.name);
        const arrayBuffer = await file.arrayBuffer();
        console.log('[PdfJsViewer] arrayBuffer size:', arrayBuffer.byteLength);
        const { loadingTask, pdf } = await loadPdfDocument(arrayBuffer);

        loadingTaskRef.current = loadingTask;
        console.log('[PdfJsViewer] pdf loaded pages:', pdf.numPages);

        if (cancelled) {
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
          setErrorMessage('PDF를 표시하는 중 오류가 발생했습니다. 콘솔 로그를 확인해주세요.');
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

      if (loadingTaskRef.current && typeof loadingTaskRef.current.destroy === 'function') {
        loadingTaskRef.current.destroy();
        loadingTaskRef.current = null;
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
    return <div className="pdf-loading">{errorMessage}</div>;
  }

  if (!pdfDocument) {
    return <div className="pdf-loading">PDF 미리보기를 준비 중입니다...</div>;
  }

  return (
    <div className="pdf-viewer-shell">
      <div ref={viewerRef} className="pdf-viewer pdf-viewer-scroll">
        <div className="pdf-viewer-stack">
          {pageNumbers.map((pageNumber) => (
            <PdfPage
              key={`${pageNumber}-${scale}`}
              pdf={pdfDocument}
              pageNumber={pageNumber}
              scale={scale}
              highlightKeyword={highlightKeyword}
              replacePreview={replacePreview}
              onPageReady={(element) => {
                if (element) {
                  pageRefs.current[pageNumber] = element;
                  return;
                }

                delete pageRefs.current[pageNumber];
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

export default PdfJsViewer;
