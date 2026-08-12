import { useEffect, useRef, useState } from 'react';
import PdfPage from './PdfPage';
import { loadPdfDocument } from '../services/pdfService';
import { isPdfFile } from '../utils/fileUtils';

function PdfJsViewer({ file, highlightKeyword, scale = 1 }) {
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pageNumbers, setPageNumbers] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const loadingTaskRef = useRef(null);

  console.log('[PdfJsViewer] file:', file);

  useEffect(() => {
    console.log('[PdfJsViewer] highlightKeyword:', highlightKeyword);
  }, [highlightKeyword]);

  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
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

        setPdfDocument(pdf);
        setPageNumbers(Array.from({ length: pdf.numPages }, (_, index) => index + 1));
        setErrorMessage('');
      } catch (error) {
        if (error?.name === 'RenderingCancelledException') {
          return;
        }

        console.error('[PdfJsViewer] Failed to load PDF document', error);

        if (!cancelled) {
          setPdfDocument(null);
          setPageNumbers([]);
          setErrorMessage('PDF를 표시하는 중 오류가 발생했습니다. 콘솔 로그를 확인해주세요.');
        }
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
      setPdfDocument(null);
      setPageNumbers([]);

      if (loadingTaskRef.current && typeof loadingTaskRef.current.destroy === 'function') {
        loadingTaskRef.current.destroy();
        loadingTaskRef.current = null;
      }
    };
  }, [file]);

  if (errorMessage) {
    return <div className="pdf-loading">{errorMessage}</div>;
  }

  if (!pdfDocument) {
    return <div className="pdf-loading">PDF 미리보기를 준비 중입니다...</div>;
  }

  return (
    <div className="pdf-viewer-shell">
      <div className="pdf-viewer pdf-viewer-scroll">
        <div className="pdf-viewer-stack">
          {pageNumbers.map((pageNumber) => (
            <PdfPage
              key={`${pageNumber}-${scale}`}
              pdf={pdfDocument}
              pageNumber={pageNumber}
              scale={scale}
              highlightKeyword={highlightKeyword}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default PdfJsViewer;
