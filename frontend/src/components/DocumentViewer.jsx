import PdfPreview from './PdfPreview';
import PreviewInfoBox from './PreviewInfoBox';
import WordPreviewPlaceholder from './WordPreviewPlaceholder';

function DocumentViewer({ previewModel }) {
  if (!previewModel) {
    return <PreviewInfoBox />;
  }

  if (previewModel.type === 'pdf') {
    return <PdfPreview file={previewModel.file} />;
  }

  if (previewModel.type === 'word') {
    return (
      <WordPreviewPlaceholder
        fileName={previewModel.fileName}
        fileSize={previewModel.fileSize}
      />
    );
  }

  return <PreviewInfoBox />;
}

export default DocumentViewer;
