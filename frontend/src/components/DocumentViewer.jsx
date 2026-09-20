import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { formatFileSize, isPdfFile } from '../utils/fileUtils';
import PdfViewer from './PdfViewer';
import PreviewInfoBox from './PreviewInfoBox';
import WordViewer from './WordViewer';
import { convertDocxFileWithHighlights } from '../services/docxHighlightService';
import ZoomControls from './ZoomControls';

const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.1;

const DocumentViewer = forwardRef(function DocumentViewer({
  file,
  previewModel,
  highlightKeyword,
  highlightStatusMessage,
  replacePreview,
  selectedSearchResult,
  onClose,
  onChangeFile,
  onReselect,
  onVisualPdfConvert
}, ref) {
  const inputRef = useRef(null);
  const viewerRef = useRef(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [docxPdfDownloadState, setDocxPdfDownloadState] = useState('idle');

  useImperativeHandle(ref, () => ({
    async getDocumentText() {
      try {
        return await viewerRef.current?.getDocumentText?.() ?? '';
      } catch (error) {
        console.warn('[DocumentViewer] document text extraction failed:', error);
        return '';
      }
    },
    searchDocument(keyword, options) {
      return viewerRef.current?.searchDocument?.(keyword, options) ?? [];
    },
    getPdfHighlights() {
      return viewerRef.current?.getPdfHighlights?.() ?? [];
    },
    getMovableTexts() {
      return viewerRef.current?.getMovableTexts?.() ?? [];
    },
    getInstantReplacementReviewItems() {
      return viewerRef.current?.getInstantReplacementReviewItems?.() ?? [];
    },
    scrollToSearchResult(result) {
      return viewerRef.current?.scrollToSearchResult?.(result) ?? false;
    },
    clearSearchSelection() {
      viewerRef.current?.clearSearchSelection?.();
    },
    highlightText(keyword, options) {
      return viewerRef.current?.highlightText?.(keyword, options) ?? { count: 0, results: [] };
    },
    scrollToHighlightResult(result) {
      return viewerRef.current?.scrollToHighlightResult?.(result)
        ?? viewerRef.current?.scrollToSearchResult?.(result)
        ?? false;
    },
    clearHighlightSelection() {
      viewerRef.current?.clearHighlightSelection?.();
    },
    replaceText(originalText, newText, options) {
      return viewerRef.current?.replaceText?.(originalText, newText, options)
        ?? { count: 0, replaceCount: 0, results: [] };
    },
    scrollToReplaceResult(result) {
      return viewerRef.current?.scrollToReplaceResult?.(result)
        ?? viewerRef.current?.scrollToSearchResult?.(result)
        ?? false;
    },
    clearHighlights() {
      viewerRef.current?.clearHighlights?.();
    },
    undoDocumentChange() {
      return viewerRef.current?.undoDocumentChange?.() ?? false;
    },
    redoDocumentChange() {
      return viewerRef.current?.redoDocumentChange?.() ?? false;
    },
    resetAllDocumentChanges() {
      return viewerRef.current?.resetAllDocumentChanges?.() ?? false;
    },
    getModifiedHtml() {
      return viewerRef.current?.getModifiedHtml?.() ?? '';
    }
  }));

  if (file) {
    console.log('[DocumentViewer] file:', file);
    console.log('[selectedFile.name]', file.name);
    console.log('[selectedFile.size]', file.size);
    console.log('[selectedFile.type]', file.type);
    console.log('[isPdf]', isPdfFile(file));
  }

  const handleFileChange = (event) => {
    const nextFile = event.target.files?.[0];
    if (nextFile) {
      onChangeFile(nextFile);
    }
    event.target.value = '';
  };

  const downloadCurrentDocx = () => {
    if (!file) return;
    const highlights = viewerRef.current?.getDocxHighlights?.() || [];
    if (highlights.length > 0) {
      convertDocxFileWithHighlights(file, highlights).catch((error) => {
        console.error('[DocumentViewer] DOCX highlight download failed:', error);
      });
      return;
    }
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadCurrentDocxAsPdf = async () => {
    if (docxPdfDownloadState !== 'idle') return;
    setDocxPdfDownloadState('running');
    try {
      await viewerRef.current?.downloadAsPdf?.();
      setDocxPdfDownloadState('idle');
    } catch (error) {
      console.error('[DocumentViewer] DOCX PDF download failed:', error);
      setDocxPdfDownloadState('error');
      window.setTimeout(() => setDocxPdfDownloadState('idle'), 2500);
    }
  };

  const docxDownloadActions = (
    <div className="viewer-download-actions docx-download-actions" aria-label="DOCX 다운로드">
      <span className="viewer-download-label">다운로드</span>
      <button type="button" className="viewer-download-button pdf" onClick={downloadCurrentDocxAsPdf} disabled={docxPdfDownloadState === 'running'} aria-label="PDF 다운로드">
        {docxPdfDownloadState === 'running' ? 'PDF 생성 중...' : docxPdfDownloadState === 'error' ? 'PDF 실패' : 'PDF'}
      </button>
      <button type="button" className="viewer-download-button docx" onClick={downloadCurrentDocx} aria-label="DOCX 다운로드">
        DOCX
      </button>
    </div>
  );

  const viewerActions = (
        <div className="document-viewer-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onReselect}
          >
            다시 선택
          </button>
          {previewModel?.type === 'pdf' || previewModel?.type === 'word' ? (
            <ZoomControls
              scale={scale}
              onZoomOut={() => setScale((current) => Math.max(MIN_SCALE, current - SCALE_STEP))}
              onZoomIn={() => setScale((current) => Math.min(MAX_SCALE, current + SCALE_STEP))}
            />
          ) : null}
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept=".pdf,.doc,.docx"
            onChange={handleFileChange}
          />
        </div>
  );

  const renderContent = () => {
    if (!previewModel) {
      return <PreviewInfoBox />;
    }

    if (previewModel.type === 'pdf') {
      return (
        <PdfViewer
          ref={viewerRef}
          file={file}
          highlightKeyword={highlightKeyword}
          replacePreview={replacePreview}
          selectedSearchResult={selectedSearchResult}
          scale={scale}
          toolbarActions={viewerActions}
          onVisualConvert={onVisualPdfConvert}
        />
      );
    }

    if (previewModel.type === 'word') {
      return <WordViewer ref={viewerRef} file={file} previewModel={previewModel} scale={scale} toolbarActions={viewerActions} downloadActions={docxDownloadActions} />;
    }

    return (
      <div className="unsupported-document">
        지원하지 않는 문서 형식입니다.
      </div>
    );
  };

  return (
    <section className="document-viewer">
      <div className="document-viewer-header document-file-header">
        <div className="document-viewer-file">
          <strong>{file?.name}</strong>
          <span>{formatFileSize(file?.size ?? 0)}</span>
        </div>
        {previewModel?.type !== 'word' && previewModel?.type !== 'pdf' ? viewerActions : null}
      </div>
      {highlightStatusMessage ? (
        <div className="inline-notice" role="status">
          {highlightStatusMessage}
        </div>
      ) : null}
      {renderContent()}
    </section>
  );
});

export default DocumentViewer;
