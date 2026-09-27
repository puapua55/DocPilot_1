import { forwardRef } from 'react';
import DocumentViewer from './DocumentViewer';
import UploadPanel from './UploadPanel';

const DocumentWorkspace = forwardRef(function DocumentWorkspace({
  selectedDocument,
  previewModel,
  highlightKeyword,
  highlightStatusMessage,
  replacePreview,
  selectedSearchResult,
  errorMessage,
  onDocumentSelect,
  onDocumentClear,
  onDocumentReselect,
  onVisualPdfConvert
}, ref) {
  return (
    <section className="panel document-panel">
      {selectedDocument ? (
        <DocumentViewer
          ref={ref}
          file={selectedDocument.file}
          previewModel={previewModel}
          highlightKeyword={highlightKeyword}
          highlightStatusMessage={highlightStatusMessage}
          replacePreview={replacePreview}
          selectedSearchResult={selectedSearchResult}
          onClose={onDocumentClear}
          onChangeFile={onDocumentSelect}
          onReselect={onDocumentReselect}
          onVisualPdfConvert={onVisualPdfConvert}
        />
      ) : (
        <UploadPanel
          errorMessage={errorMessage}
          onFileSelect={onDocumentSelect}
        />
      )}
    </section>
  );
});

export default DocumentWorkspace;
