import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { formatFileSize, isPdfFile } from '../utils/fileUtils';
import PdfViewer from './PdfViewer';
import PreviewInfoBox from './PreviewInfoBox';
import WordViewer from './WordViewer';
import { convertDocxFileWithHighlights } from '../services/docxHighlightService';
import ZoomControls from './ZoomControls';

function requestedDownloadName(operation, file) {
  if (!operation?.filename && !operation?.nameSuffix) return null;
  const extension = operation.format === 'pdf' ? '.pdf' : '.docx';
  const base = String(file?.name || 'document').replace(/\.(?:pdf|docx?)$/i, '');
  const name = operation.filename
    ? String(operation.filename).trim()
    : `${base}${String(operation.nameSuffix).trim()}`;
  if (!name || /[\\/:*?"<>|\x00-\x1f]/u.test(name) || name === '.' || name === '..') {
    throw new Error('저장 파일명에 사용할 수 없는 문자가 있습니다.');
  }
  if (/\.(?:pdf|docx?)$/i.test(name) && !name.toLowerCase().endsWith(extension)) {
    throw new Error(`저장 파일명의 확장자는 ${extension}여야 합니다.`);
  }
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

const DEFAULT_SCALE = 1;
const DOCX_DEFAULT_SCALE = 1;
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
  isEditMode = false,
  isPdfEditRestricted = false,
  onEditModeChange,
  onClose,
  onChangeFile,
  onReselect,
  onVisualPdfConvert,
  onPdfPagesChanged,
  onUndoPdfPageChange,
  onRedoPdfPageChange,
  onPdfDocumentChanged,
  canUndoPdfPageChange,
  canRedoPdfPageChange
}, ref) {
  const inputRef = useRef(null);
  const viewerRef = useRef(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [pdfFitScale, setPdfFitScale] = useState(1);
  const [docxPdfDownloadState, setDocxPdfDownloadState] = useState('idle');
  const [isReselectConfirmOpen, setIsReselectConfirmOpen] = useState(false);
  const viewerType = previewModel?.type || (isPdfFile(file) ? 'pdf' : 'docx');

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
    getSearchableTextSegments() {
      return viewerRef.current?.getSearchableTextSegments?.() ?? [];
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
    getCurrentPageNumber() {
      return viewerRef.current?.getCurrentPageNumber?.() ?? null;
    },
    getPageCount() {
      return viewerRef.current?.getPageCount?.() ?? null;
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
    async executeViewerCommand(operation) {
      const command = operation?.command;
      if (command === 'zoom') {
        if (Number.isFinite(Number(operation.value))) setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(operation.value))));
        else if (Number.isFinite(Number(operation.delta))) setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + Number(operation.delta))));
        else if (Number.isFinite(Number(operation.multiplier))) setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * Number(operation.multiplier))));
        else return { ok: false, message: '변경할 확대 비율이 지정되지 않았습니다.' };
        return { ok: true };
      }
      if (command === 'download') {
        const fileName = requestedDownloadName(operation, file);
        if (operation.format === 'pdf') {
          if (viewerType === 'pdf') { const opened = await viewerRef.current?.downloadAsPdf?.(null, { fileName }); return { ok: opened === true }; }
          if (viewerType === 'word') { const saved = await downloadCurrentDocxAsPdf(fileName); return { ok: saved }; }
        }
        if (operation.format === 'docx' && viewerType === 'word') { const saved = await downloadCurrentDocx(fileName); return { ok: saved }; }
        return { ok: false, message: '지원되지 않는 기능입니다.' };
      }
      if (command === 'fit' && viewerType === 'word') return { ok: false, message: '지원되지 않는 기능입니다.' };
      return await viewerRef.current?.executeViewerCommand?.(operation)
        ?? { ok: false, message: '현재 뷰어에서 요청한 보기 작업을 지원하지 않습니다.' };
    },
    getModifiedHtml() {
      return viewerRef.current?.getModifiedHtml?.() ?? '';
    }
  }));

  if (file) {
    console.log('[DocumentViewer] viewerType:', viewerType);
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

  const downloadCurrentDocx = async (fileName = null) => {
    if (!file) return false;
    try {
      if (viewerRef.current?.downloadEditedDocx) return await viewerRef.current.downloadEditedDocx(fileName);
    } catch (error) {
      console.error('[DocumentViewer] DOCX edit download failed:', error);
      window.alert(`DOCX 저장에 실패했습니다. ${error.message || error}`);
      return false;
    }
    const highlights = viewerRef.current?.getDocxHighlights?.() || [];
    if (highlights.length > 0) {
      try {
        await convertDocxFileWithHighlights(file, highlights, fileName);
        return true;
      } catch (error) {
        console.error('[DocumentViewer] DOCX highlight download failed:', error);
        return false;
      }
    }
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName || file.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  };

  const downloadCurrentDocxAsPdf = async (fileName = null) => {
    if (docxPdfDownloadState !== 'idle') return false;
    setDocxPdfDownloadState('running');
    try {
      await viewerRef.current?.downloadAsPdf?.(fileName);
      setDocxPdfDownloadState('idle');
      return true;
    } catch (error) {
      console.error('[DocumentViewer] DOCX PDF download failed:', error);
      setDocxPdfDownloadState('error');
      window.setTimeout(() => setDocxPdfDownloadState('idle'), 2500);
      return false;
    }
  };

  const docxDownloadActions = (
    <div className="viewer-download-actions docx-download-actions" aria-label="DOCX 다운로드">
      <span className="viewer-download-label">다운로드</span>
      <button type="button" className="viewer-download-button pdf" onClick={() => downloadCurrentDocxAsPdf()} disabled={docxPdfDownloadState === 'running'} aria-label="PDF 다운로드">
        {docxPdfDownloadState === 'running' ? 'PDF 생성 중...' : docxPdfDownloadState === 'error' ? 'PDF 실패' : 'PDF'}
      </button>
      <button type="button" className="viewer-download-button docx" onClick={() => downloadCurrentDocx()} aria-label="DOCX 다운로드">
        DOCX
      </button>
    </div>
  );

  const viewerActions = (
        <div className="document-viewer-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setIsReselectConfirmOpen(true)}
          >
            다시 선택
          </button>
          {previewModel?.type === 'pdf' || previewModel?.type === 'word' ? (
            <ZoomControls
              scale={viewerType === 'pdf' ? scale * pdfFitScale : scale}
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
          isEditMode={isEditMode}
          isPdfEditRestricted={isPdfEditRestricted}
          onEditModeChange={onEditModeChange}
          scale={scale}
          onFitScaleChange={setPdfFitScale}
          onResetZoom={() => setScale(1)}
          toolbarActions={viewerActions}
          onVisualConvert={onVisualPdfConvert}
          onPagesChanged={onPdfPagesChanged}
          onUndoPageChange={onUndoPdfPageChange}
          onRedoPageChange={onRedoPdfPageChange}
          onDocumentChanged={onPdfDocumentChanged}
          canUndoPageChange={canUndoPdfPageChange}
          canRedoPageChange={canRedoPdfPageChange}
        />
      );
    }

    if (previewModel.type === 'word') {
      return <WordViewer ref={viewerRef} file={file} previewModel={previewModel} scale={scale} toolbarActions={viewerActions} downloadActions={docxDownloadActions} onEditModeChange={onEditModeChange} />;
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
      {isReselectConfirmOpen ? (
        <div className="docx-reset-confirm-backdrop" role="presentation">
          <div className="docx-reset-confirm" role="dialog" aria-modal="true" aria-labelledby="document-reselect-confirm-title">
            <p id="document-reselect-confirm-title">이전 파일을 닫고 새 파일을 불러오시겠습니까?</p>
            <div>
              <button
                type="button"
                onClick={() => {
                  setIsReselectConfirmOpen(false);
                  onReselect?.();
                }}
              >
                예
              </button>
              <button type="button" onClick={() => setIsReselectConfirmOpen(false)}>아니오</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
});

export default DocumentViewer;
