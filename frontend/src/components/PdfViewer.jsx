import PdfJsViewer from './PdfJsViewer';

function PdfViewer({ file, highlightKeyword, selectedSearchResult, scale }) {
  return (
    <PdfJsViewer
      file={file}
      highlightKeyword={highlightKeyword}
      selectedSearchResult={selectedSearchResult}
      scale={scale}
    />
  );
}

export default PdfViewer;
