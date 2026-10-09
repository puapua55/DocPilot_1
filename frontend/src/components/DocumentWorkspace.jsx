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
  isEditMode,
  onEditModeChange,
  onDocumentSelect,
  onDocumentClear,
  onDocumentReselect,
  onVisualPdfConvert,
  onPdfPagesChanged,
  onUndoPdfPageChange,
  onRedoPdfPageChange,
  onPdfDocumentChanged,
  canUndoPdfPageChange,
  canRedoPdfPageChange
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
          isEditMode={isEditMode}
          onEditModeChange={onEditModeChange}
          onClose={onDocumentClear}
          onChangeFile={onDocumentSelect}
          onReselect={onDocumentReselect}
          onVisualPdfConvert={onVisualPdfConvert}
          onPdfPagesChanged={onPdfPagesChanged}
          onUndoPdfPageChange={onUndoPdfPageChange}
          onRedoPdfPageChange={onRedoPdfPageChange}
          onPdfDocumentChanged={onPdfDocumentChanged}
          canUndoPdfPageChange={canUndoPdfPageChange}
          canRedoPdfPageChange={canRedoPdfPageChange}
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
