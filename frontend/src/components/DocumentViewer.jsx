import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { formatFileSize, isPdfFile } from '../utils/fileUtils';
import PdfViewer from './PdfViewer';
import PreviewInfoBox from './PreviewInfoBox';
import ZoomControls from './ZoomControls';
import WordPreviewPlaceholder from './WordPreviewPlaceholder';
import DocxViewer from './DocxViewer';

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
  onClose,
  onChangeFile,
  onReselect
}, ref) {
  const inputRef = useRef(null);
  const innerViewerRef = useRef(null);
  const viewerType = getViewerType(file, previewModel);
  const [scale, setScale] = useState(() => (viewerType === 'docx' ? DOCX_DEFAULT_SCALE : DEFAULT_SCALE));

  useEffect(() => {
    if (viewerType === 'docx') {
      setScale(DOCX_DEFAULT_SCALE);
      return;
    }

    setScale(DEFAULT_SCALE);
  }, [viewerType]);

  useImperativeHandle(ref, () => ({
    searchDocument(keyword) {
      return innerViewerRef.current?.searchDocument?.(keyword) || [];
    },

    highlightText(keyword) {
      return innerViewerRef.current?.highlightText?.(keyword) || 0;
    },

    replaceText(originalText, newText) {
      return innerViewerRef.current?.replaceText?.(originalText, newText) || 0;
    },

    scrollToSearchResult(result) {
      return innerViewerRef.current?.scrollToSearchResult?.(result);
    },

    clearHighlights() {
      return innerViewerRef.current?.clearHighlights?.();
    },

    getViewerType() {
      return viewerType;
    }
  }));

  if (file) {
    console.log('[DocumentViewer] file:', file);
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

  const renderContent = () => {
    if (!previewModel) {
      return <PreviewInfoBox />;
    }

    if (viewerType === 'pdf') {
      return (
        <PdfViewer
          file={file}
          highlightKeyword={highlightKeyword}
          replacePreview={replacePreview}
          selectedSearchResult={selectedSearchResult}
          scale={scale}
        />
      );
    }

    if (viewerType === 'docx') {
      return (
        <DocxViewer
          ref={innerViewerRef}
          file={file}
          scale={scale}
          onZoomChange={setScale}
        />
      );
    }

    if (viewerType === 'doc') {
      return (
        <WordPreviewPlaceholder
          fileName={previewModel.fileName}
          fileSize={formatFileSize(previewModel.fileSize)}
          message="DOC 형식은 현재 미리보기가 제한됩니다."
          description="DOCX 파일을 사용해주세요."
        />
      );
    }

    return (
      <div className="unsupported-document">
        지원하지 않는 문서 형식입니다.
      </div>
    );
  };

  return (
    <section className="document-viewer">
      <div className="document-viewer-header">
        <div className="document-viewer-file">
          <strong>{file?.name}</strong>
          <span>{formatFileSize(file?.size ?? 0)}</span>
        </div>
        <div className="document-viewer-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onReselect}
          >
            다시 선택
          </button>
          {previewModel && (previewModel.type === 'pdf' || viewerType === 'docx') ? (
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

function getViewerType(file, previewModel) {
  const name = file?.name?.toLowerCase?.() || previewModel?.fileName?.toLowerCase?.() || '';
  const type = file?.type || '';

  if (previewModel?.type === 'pdf' || type === 'application/pdf' || name.endsWith('.pdf')) {
    return 'pdf';
  }

  if (
    previewModel?.type === 'docx' ||
    previewModel?.type === 'word' ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    type === 'application/msword' ||
    name.endsWith('.docx') ||
    name.endsWith('.doc')
  ) {
    if (name.endsWith('.docx') || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || previewModel?.type === 'docx') {
      return 'docx';
    }
    return 'doc';
  }

  return previewModel?.type || 'unknown';
}

export default DocumentViewer;
