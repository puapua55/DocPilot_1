import { useRef, useState } from 'react';
import { formatFileSize, isPdfFile } from '../utils/fileUtils';
import PdfViewer from './PdfViewer';
import PreviewInfoBox from './PreviewInfoBox';
import ZoomControls from './ZoomControls';
import WordPreviewPlaceholder from './WordPreviewPlaceholder';

const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;

function DocumentViewer({
  file,
  previewModel,
  highlightKeyword,
  highlightStatusMessage,
  selectedSearchResult,
  onClose,
  onChangeFile,
  onReselect
}) {
  const inputRef = useRef(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);

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

  const renderContent = () => {
    if (!previewModel) {
      return <PreviewInfoBox />;
    }

    if (previewModel.type === 'pdf') {
      return (
        <PdfViewer
          file={file}
          highlightKeyword={highlightKeyword}
          selectedSearchResult={selectedSearchResult}
          scale={scale}
        />
      );
    }

    if (previewModel.type === 'word') {
      return (
        <WordPreviewPlaceholder
          fileName={previewModel.fileName}
          fileSize={formatFileSize(previewModel.fileSize)}
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
          {previewModel?.type === 'pdf' ? (
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
}

export default DocumentViewer;
