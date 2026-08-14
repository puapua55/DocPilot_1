import DocumentViewer from './DocumentViewer';
import UploadPanel from './UploadPanel';

function DocumentWorkspace({
  selectedDocument,
  previewModel,
  highlightKeyword,
  highlightStatusMessage,
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
