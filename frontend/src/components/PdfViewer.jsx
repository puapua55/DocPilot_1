import { forwardRef } from 'react';
import PdfJsViewer from './PdfJsViewer';

const PdfViewer = forwardRef(function PdfViewer({ file, highlightKeyword, selectedSearchResult, replacePreview, scale }, ref) {
  return (
    <PdfJsViewer
      ref={ref}
      file={file}
      highlightKeyword={highlightKeyword}
      selectedSearchResult={selectedSearchResult}
      replacePreview={replacePreview}
      scale={scale}
    />
  );
});

export default PdfViewer;
