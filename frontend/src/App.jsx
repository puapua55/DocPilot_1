import { useEffect, useRef, useState } from 'react';
import AppErrorBoundary from './components/AppErrorBoundary';
import AssistantPanel from './components/AssistantPanel';
import BatchTextReplaceModal from './components/BatchTextReplaceModal';
import DocumentWorkspace from './components/DocumentWorkspace';
import HighlightModal from './components/HighlightModal';
import SearchModal from './components/SearchModal';
import { useChat } from './hooks/useChat';
import { useDocument } from './hooks/useDocument';
import { searchKeywordInDocument } from './services/searchService';

function normalizeCount(result) {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) return result.length;
  if (result && typeof result.count === 'number') return result.count;
  if (result && typeof result.matchCount === 'number') return result.matchCount;
  if (result && typeof result.replaceCount === 'number') return result.replaceCount;
  return 0;
}

function getSearchResults(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.results)) return result.results;
  return [];
}

function App() {
  const documentViewerRef = useRef(null);
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isHighlightModalOpen, setIsHighlightModalOpen] = useState(false);
  const [isBatchReplaceModalOpen, setIsBatchReplaceModalOpen] = useState(false);
  const [highlightKeyword, setHighlightKeyword] = useState('');
  const [highlightStatusMessage, setHighlightStatusMessage] = useState('');
  const [selectedSearchResult, setSelectedSearchResult] = useState(null);
  const [runningActionId, setRunningActionId] = useState(null);
  const { selectedDocument, previewModel, documentText, errorMessage, handleDocumentSelect, clearSelectedDocument } = useDocument();
  const { messages, loading: chatLoading, error: chatError, handleSendMessage, appendAssistantMessage } = useChat(selectedDocument, previewModel, documentViewerRef);

  useEffect(() => { console.log('[App] highlightKeyword:', highlightKeyword); }, [highlightKeyword]);
  useEffect(() => { console.log('[App] selectedFile:', selectedDocument?.file ?? null); }, [selectedDocument]);
  useEffect(() => { console.log('[App] selectedSearchResult:', selectedSearchResult); }, [selectedSearchResult]);

  const resetDocumentViewState = () => {
    setIsSearchModalOpen(false); setIsHighlightModalOpen(false); setIsBatchReplaceModalOpen(false);
    setHighlightKeyword(''); setHighlightStatusMessage(''); setSelectedSearchResult(null); setRunningActionId(null); clearSelectedDocument();
  };

  const handleDocumentSearch = async (keyword, options = {}) => {
    if (!selectedDocument) {
      return [];
    }

    if (documentViewerRef.current?.searchDocument) {
      return await documentViewerRef.current.searchDocument(keyword, options);
    }

    if (previewModel?.type === 'pdf') {
      return searchKeywordInDocument(documentText, keyword, options);
    }

    console.warn('[App] searchDocument is not available for the current viewer.');
    return [];
  };

  const handleSearchResultClick = (result) => {
    console.log('[SearchResult] clicked:', result);
    const target = result?.raw || result;
    const moved = documentViewerRef.current?.scrollToSearchResult?.(target) ?? false;

    if (!moved) {
      console.warn('[App] search result navigation was not handled:', target);
    }

    setSelectedSearchResult({ ...target, clickedAt: Date.now() });
  };

  const handleSearchReset = () => {
    documentViewerRef.current?.clearSearchSelection?.();
    setSelectedSearchResult(null);
  };

  const handleTemporarySearchDismiss = (event) => {
    if (!selectedSearchResult) return;
    if (event.target instanceof Element && event.target.closest('[data-search-result-trigger="true"]')) return;
    handleSearchReset();
  };

  const handleHighlightSearch = async (keyword, options = {}) => {
    if (!selectedDocument) {
      return {
        ok: false,
        message: '현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.',
        count: 0,
        results: []
      };
    }

    if (previewModel?.type !== 'word' && previewModel?.type !== 'pdf') {
      return {
        ok: false,
        message: '지원하는 문서 형식이 아닙니다.',
        count: 0,
        results: []
      };
    }

    if (!documentViewerRef.current?.highlightText) {
      return {
        ok: false,
        message: '현재 뷰어에서 하이라이트 기능을 사용할 수 없습니다.',
        count: 0,
        results: []
      };
    }

    const result = await documentViewerRef.current.highlightText(keyword, {
      color: options?.color || 'yellow',
      matchMode: options?.matchMode === 'exact' ? 'exact' : 'contains'
    });
    const count = normalizeCount(result);
    const results = getSearchResults(result);

    setHighlightKeyword('');
    setHighlightStatusMessage(
      count > 0
        ? `총 ${count}건을 하이라이트했습니다.`
        : '하이라이트할 단어를 찾을 수 없습니다.'
    );

    return {
      ok: true,
      count,
      matchCount: count,
      results
    };
  };

  const handleHighlightClearAll = async () => {
    documentViewerRef.current?.clearHighlights?.();
    documentViewerRef.current?.clearHighlightSelection?.();
    setHighlightKeyword('');
    setHighlightStatusMessage('하이라이트를 모두 제거했습니다.');
    return true;
  };

  const handleHighlightReset = () => {
    documentViewerRef.current?.clearHighlightSelection?.();
  };

  const handleHighlightResultClick = (result) => {
    const target = result?.raw || result;
    const moved = documentViewerRef.current?.scrollToHighlightResult?.(target)
      ?? documentViewerRef.current?.scrollToSearchResult?.(target)
      ?? false;

    if (!moved) {
      console.warn('[App] highlight result navigation was not handled:', target);
    }
  };

  const handleVisualPdfConvert = async (payload = {}) => {
    const replacement = payload?.replacement || payload;
    const movableTexts = Array.isArray(payload?.movableTexts) ? payload.movableTexts : [];
    const highlights = Array.isArray(payload?.highlights) ? payload.highlights : [];
    const images = Array.isArray(payload?.images) ? payload.images : [];
    if (!selectedDocument?.file || previewModel?.type !== 'pdf') {
      throw new Error('현재 선택된 PDF 문서가 없습니다.');
    }

    if ((!replacement?.originalText || replacement?.newText == null) && movableTexts.length === 0 && highlights.length === 0 && images.length === 0) {
      throw new Error('화면에 적용된 텍스트 이동 또는 하이라이트 결과가 없습니다.');
    }
    const { convertPdfWithOriginalOverlay } = await import('./services/pdfOverlayConvertService');
    return convertPdfWithOriginalOverlay({ file: selectedDocument.file, replacement, movableTexts, highlights, images, download: payload?.download !== false });
  };

  const handleBatchReplaceApply = async (originalText, newText, options = {}) => {
    if (!selectedDocument?.file) throw new Error('먼저 문서를 선택해주세요.');
    if (!documentViewerRef.current?.replaceText) throw new Error('현재 문서 뷰어에서 텍스트 변경을 지원하지 않습니다.');

    const matchMode = options.matchMode === 'exact' ? 'exact' : 'contains';
    const selectedTargets = Array.isArray(options.selectedTargets) ? options.selectedTargets : [];
    const fileType = previewModel?.type;
    const result = await documentViewerRef.current.replaceText(originalText, newText, {
      matchMode,
      selectedTargets
    });
    const appliedCount = normalizeCount(result);
    if (!appliedCount) throw new Error('선택한 검색 결과를 적용할 수 없습니다. 검색을 다시 실행해주세요.');

    if (fileType === 'pdf') {
      // Batch results are promoted by PdfJsViewer to the same editor objects
      // created by a manual text selection. Save them through the PDF button.
      setHighlightStatusMessage(`${appliedCount}건을 변경했습니다. 변경된 문구는 텍스트 이동·텍스트 교체로 계속 편집할 수 있으며, PDF 버튼을 누르면 저장됩니다.`);
      return { count: appliedCount, replaceCount: appliedCount };

      let overlayCount = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        overlayCount = document.querySelectorAll('.pdf-viewer .replacement-layer > div').length;
        if (overlayCount >= appliedCount) break;
      }
      if (overlayCount < appliedCount) {
        throw new Error(`화면에서 교체 위치를 ${appliedCount}건 중 ${overlayCount}건만 확인했습니다. 검색 결과를 다시 확인해주세요.`);
      }
      const replacementReviewItems = documentViewerRef.current?.getInstantReplacementReviewItems?.() || [];
      replacementReviewItems.forEach((item) => {
        item.previousSourceText = originalText;
        item.sourceText = String(item.displayText || newText);
        item.originalText = item.sourceText;
        item.originalUnicodeText = item.sourceText;
      });

      const converted = await handleVisualPdfConvert({
        replacement: {
          originalText,
          newText,
          matchMode,
          selectedTargets: result.results
        },
        download: false
      });
      if (!converted?.outputBytes?.byteLength) throw new Error('변경된 PDF 데이터를 만들지 못했습니다.');

      const updatedFile = new File([converted.outputBytes], selectedDocument.file.name, {
        type: 'application/pdf',
        lastModified: Date.now()
      });
      await handleDocumentSelect(updatedFile);
      if (replacementReviewItems.length) {
        // Preserve the replacement objects in the viewer so subsequent move /
        // replace actions target the new text rather than a covered text layer.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        documentViewerRef.current?.setPersistedReplacementReviewItems?.(replacementReviewItems);
      }
      const unresolved = Number(converted.noCoverUnresolvedCount || 0);
      setHighlightStatusMessage(unresolved
        ? `${appliedCount}건을 변경했습니다. 원문 제거를 확인하지 못한 항목 ${unresolved}건은 PDF 구조상 남아 있을 수 있습니다.`
        : `${appliedCount}건을 변경해 PDF 뷰어에 적용했습니다.`);
      return { count: appliedCount, replaceCount: appliedCount };
    }

    if (fileType === 'word') {
      setHighlightStatusMessage(`${appliedCount}건을 변경해 문서 화면에 적용했습니다.`);
      return { count: appliedCount, replaceCount: appliedCount };
    }

    throw new Error('지원하지 않는 문서 형식입니다.');
  };

  const requireDocumentForAction = () => {
    if (selectedDocument?.file) return true;
    appendAssistantMessage('현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.');
    return false;
  };

  const validateKeywordAction = (action, label = '검색어') => {
    if (!requireDocumentForAction()) return false;
    if (String(action?.keyword || '').trim()) return true;
    appendAssistantMessage(label === '검색어' ? '검색어가 없어 작업을 실행할 수 없습니다.' : '하이라이트 대상 단어가 없어 작업을 실행할 수 없습니다.');
    return false;
  };

  const runAction = async (messageId, type, task) => {
    if (runningActionId) return;
    setRunningActionId(`${messageId}:${type}`);
    try { await task(); }
    catch (error) { appendAssistantMessage(`작업 실행 중 오류가 발생했습니다.\n사유: ${error?.message || '알 수 없는 오류'}`); }
    finally { setRunningActionId(null); }
  };

  const executeSearchAction = async (messageId, action) => {
    if (!validateKeywordAction(action)) return;
    await runAction(messageId, 'search', async () => {
      if (previewModel?.type !== 'word' && previewModel?.type !== 'pdf') {
        throw new Error('지원하지 않는 파일 형식입니다.');
      }
      if (!documentViewerRef.current?.searchDocument && previewModel?.type !== 'pdf') {
        throw new Error('현재 뷰어에서 검색 기능을 사용할 수 없습니다.');
      }
      const rawResult = await handleDocumentSearch(action.keyword, { matchMode: 'contains' });
      const results = getSearchResults(rawResult);
      const count = results.length || normalizeCount(rawResult);
      const visibleResults = results.slice(0, 20);
      const hasMoreResults = results.length > visibleResults.length;
      appendAssistantMessage(
        `검색을 실행했습니다.\n검색어: ${action.keyword}\n검색 결과: ${count}건${hasMoreResults ? '\n채팅에는 상위 20건을 표시합니다.' : ''}`,
        {
          searchResults: visibleResults,
          searchKeyword: action.keyword,
          searchResultCount: count,
          hasMoreSearchResults: hasMoreResults
        }
      );
    });
  };

  const executeHighlightAction = async (messageId, action) => {
    if (!validateKeywordAction(action, '하이라이트')) return;
    await runAction(messageId, 'highlight', async () => {
      if (!documentViewerRef.current?.highlightText) throw new Error('현재 뷰어에서 하이라이트 기능을 사용할 수 없습니다.');
      const result = await handleHighlightSearch(action.keyword, {
        color: 'yellow',
        matchMode: 'contains'
      });
      if (!result.ok) throw new Error(result.message || '하이라이트를 적용하지 못했습니다.');
      const count = normalizeCount(result);
      appendAssistantMessage(`하이라이트를 적용했습니다.\n대상 단어: ${action.keyword}\n적용 건수: ${count}건\n총 ${count}건을 하이라이트했습니다.`);
    });
  };

  const appContent = (
    <div className="app-page" onPointerDown={handleTemporarySearchDismiss}><div className="ambient ambient-left" /><div className="ambient ambient-right" /><div className="app-shell"><main className="main-layout">
      <DocumentWorkspace ref={documentViewerRef} selectedDocument={selectedDocument} previewModel={previewModel} highlightKeyword={highlightKeyword} highlightStatusMessage={highlightStatusMessage} selectedSearchResult={selectedSearchResult} errorMessage={errorMessage} onDocumentSelect={handleDocumentSelect} onDocumentClear={resetDocumentViewState} onDocumentReselect={resetDocumentViewState} onVisualPdfConvert={handleVisualPdfConvert} />
      <AssistantPanel messages={messages} loading={chatLoading} error={chatError} selectedDocument={selectedDocument} runningActionId={runningActionId} onSendMessage={handleSendMessage} onSearchCardClick={() => setIsSearchModalOpen(true)} onHighlightCardClick={() => setIsHighlightModalOpen(true)} onBatchReplaceCardClick={() => setIsBatchReplaceModalOpen(true)} onSearchResultClick={handleSearchResultClick} onExecuteSearchAction={executeSearchAction} onExecuteHighlightAction={executeHighlightAction} />
    </main></div>
    {isSearchModalOpen ? <SearchModal selectedDocument={selectedDocument} previewModel={previewModel} onSearch={handleDocumentSearch} onReset={handleSearchReset} onResultClick={handleSearchResultClick} onClose={() => setIsSearchModalOpen(false)} /> : null}
    <HighlightModal
      isOpen={isHighlightModalOpen}
      selectedDocument={selectedDocument}
      previewModel={previewModel}
      onApply={handleHighlightSearch}
      onClearAll={handleHighlightClearAll}
      onReset={handleHighlightReset}
      onResultClick={handleHighlightResultClick}
      onClose={() => setIsHighlightModalOpen(false)}
    />
    <BatchTextReplaceModal
      isOpen={isBatchReplaceModalOpen}
      selectedDocument={selectedDocument}
      previewModel={previewModel}
      onSearch={handleDocumentSearch}
      onApply={handleBatchReplaceApply}
      onClose={() => setIsBatchReplaceModalOpen(false)}
    />
    </div>
  );
  return <AppErrorBoundary>{appContent}</AppErrorBoundary>;
}

export default App;
