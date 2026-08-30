import PdfJsViewer from './PdfJsViewer';

function PdfViewer({ file, highlightKeyword, selectedSearchResult, replacePreview, scale }) {
  return (
    <PdfJsViewer
      file={file}
      highlightKeyword={highlightKeyword}
      selectedSearchResult={selectedSearchResult}
      replacePreview={replacePreview}
      scale={scale}
    />
  );
}

export default PdfViewer;
