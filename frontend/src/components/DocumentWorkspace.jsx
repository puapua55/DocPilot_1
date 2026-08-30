import DocumentViewer from './DocumentViewer';
import UploadPanel from './UploadPanel';

function DocumentWorkspace({
  selectedDocument,
  previewModel,
  highlightKeyword,
  highlightStatusMessage,
  replacePreview,
  selectedSearchResult,
  errorMessage,
  onDocumentSelect,
  onDocumentClear,
  onDocumentReselect
}) {
  return (
    <section className="panel document-panel">
      {selectedDocument ? (
        <DocumentViewer
          file={selectedDocument.file}
          previewModel={previewModel}
          highlightKeyword={highlightKeyword}
          highlightStatusMessage={highlightStatusMessage}
          replacePreview={replacePreview}
          selectedSearchResult={selectedSearchResult}
          onClose={onDocumentClear}
          onChangeFile={onDocumentSelect}
          onReselect={onDocumentReselect}
        />
      ) : (
        <UploadPanel
          errorMessage={errorMessage}
          onFileSelect={onDocumentSelect}
        />
      )}
    </section>
  );
}

export default DocumentWorkspace;
