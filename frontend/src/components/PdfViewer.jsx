import { forwardRef } from 'react';
import PdfJsViewer from './PdfJsViewer';

const PdfViewer = forwardRef(function PdfViewer({ file, highlightKeyword, selectedSearchResult, replacePreview, scale, onFitScaleChange, onResetZoom, toolbarActions, onVisualConvert, onPagesChanged, onUndoPageChange, onRedoPageChange, onDocumentChanged, canUndoPageChange, canRedoPageChange, isEditMode, onEditModeChange }, ref) {
  return (
    <PdfJsViewer
      ref={ref}
      file={file}
      highlightKeyword={highlightKeyword}
      selectedSearchResult={selectedSearchResult}
      replacePreview={replacePreview}
      scale={scale}
      onFitScaleChange={onFitScaleChange}
      onResetZoom={onResetZoom}
      toolbarActions={toolbarActions}
      onVisualConvert={onVisualConvert}
      onPagesChanged={onPagesChanged}
      onUndoPageChange={onUndoPageChange}
      onRedoPageChange={onRedoPageChange}
      onDocumentChanged={onDocumentChanged}
      canUndoPageChange={canUndoPageChange}
      canRedoPageChange={canRedoPageChange}
      isEditMode={isEditMode}
      onEditModeChange={onEditModeChange}
    />
  );
});

export default PdfViewer;
