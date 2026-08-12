import PdfJsViewer from './PdfJsViewer';

function PdfViewer({ file, highlightKeyword, scale }) {
  return <PdfJsViewer file={file} highlightKeyword={highlightKeyword} scale={scale} />;
}

export default PdfViewer;
