import FileSupportBar from './FileSupportBar';
import SearchPanel from './SearchPanel';
import UploadPanel from './UploadPanel';
import DocumentViewer from './DocumentViewer';

function DocumentWorkspace({
  selectedDocument,
  previewModel,
  errorMessage,
  statusMessage,
  onDocumentSelect,
  onFeatureClick
}) {
  return (
    <section className="panel document-panel">
      <UploadPanel
        selectedFile={selectedDocument}
        errorMessage={errorMessage}
        onFileSelect={onDocumentSelect}
      />
      <FileSupportBar />
      <SearchPanel statusMessage={statusMessage} onFeatureClick={onFeatureClick} />
      <div className="preview-stage">
        <DocumentViewer previewModel={previewModel} />
      </div>
    </section>
  );
}

export default DocumentWorkspace;
