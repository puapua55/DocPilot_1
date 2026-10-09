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

function resolveHighlightTargets(results, action) {
  const orderedResults = Array.isArray(results) ? results : [];
  if (action?.all === true) {
    return orderedResults.map((result) => ({
      ...(result?.raw || result),
      color: ['yellow', 'green', 'blue', 'pink'].includes(action.color) ? action.color : 'yellow'
    }));
  }

  const targets = Array.isArray(action?.targets) ? action.targets : [];
  if (!targets.length) return [];

  return targets.map((target) => {
    const page = Number(target?.page);
    const line = Number(target?.line ?? target?.lineNumber);
    const occurrence = Number(target?.occurrence);
    const pageResults = orderedResults.filter((result) => Number(result?.pageNumber ?? result?.page) === page);
    const lineResults = Number.isInteger(line) && line > 0
      ? pageResults.filter((result) => Number(result?.lineNumber ?? result?.line) === line)
      : pageResults;
    const selected = lineResults[Number.isInteger(occurrence) && occurrence > 0 ? occurrence - 1 : 0];
    return selected
      ? { ...(selected.raw || selected), color: target.color, highlightOccurrence: occurrence }
      : null;
  }).filter(Boolean);
}

function resolveReplacementTargets(results, action) {
  const orderedResults = Array.isArray(results) ? results : [];
  if (action?.all === true) return orderedResults.map((result) => result?.raw || result);
  const targets = Array.isArray(action?.targets) ? action.targets : [];
  return targets.map((target) => {
    const page = Number(target?.page);
    const line = Number(target?.line ?? target?.lineNumber);
    const occurrence = Number(target?.occurrence);
    const pageResults = orderedResults.filter((result) => Number(result?.pageNumber ?? result?.page) === page);
    const lineResults = Number.isInteger(line) && line > 0
      ? pageResults.filter((result) => Number(result?.lineNumber ?? result?.line) === line)
      : pageResults;
    const selected = lineResults[Number.isInteger(occurrence) && occurrence > 0 ? occurrence - 1 : 0];
    return selected?.raw || selected || null;
  }).filter(Boolean);
}

function resolveListIndex(requestText) {
  const text = String(requestText || '');
  const arabic = text.match(/(?:목록|리스트)\s*(?:에서|의)?\s*(\d+)\s*(?:번째|번)/i);
  if (arabic) return Number(arabic[1]);
  const koreanNumbers = { 첫: 1, 둘: 2, 두: 2, 이: 2, 셋: 3, 세: 3, 넷: 4, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
  const korean = text.match(/(?:목록|리스트)\s*(?:에서|의)?\s*(첫|둘|두|이|셋|세|넷|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:번째|번)/);
  return korean ? koreanNumbers[korean[1]] : null;
}

function App() {
  const documentViewerRef = useRef(null);
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isHighlightModalOpen, setIsHighlightModalOpen] = useState(false);
  const [isBatchReplaceModalOpen, setIsBatchReplaceModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [batchReplaceInitialValues, setBatchReplaceInitialValues] = useState(null);
  const [batchReplaceSearchContext, setBatchReplaceSearchContext] = useState(null);
  const [highlightKeyword, setHighlightKeyword] = useState('');
  const [highlightStatusMessage, setHighlightStatusMessage] = useState('');
  const [selectedSearchResult, setSelectedSearchResult] = useState(null);
  const [runningActionId, setRunningActionId] = useState(null);
  const [pageStructureHistory, setPageStructureHistory] = useState({ past: [], future: [] });
  const { selectedDocument, previewModel, documentText, errorMessage, handleDocumentSelect, clearSelectedDocument } = useDocument();
  const { messages, loading: chatLoading, error: chatError, handleSendMessage, appendAssistantMessage } = useChat(selectedDocument, previewModel, documentViewerRef, isEditMode);

  useEffect(() => { console.log('[App] highlightKeyword:', highlightKeyword); }, [highlightKeyword]);
  useEffect(() => { console.log('[App] selectedFile:', selectedDocument?.file ?? null); }, [selectedDocument]);
  useEffect(() => { console.log('[App] selectedSearchResult:', selectedSearchResult); }, [selectedSearchResult]);

  const resetDocumentViewState = () => {
    setIsSearchModalOpen(false); setIsHighlightModalOpen(false); setIsBatchReplaceModalOpen(false); setBatchReplaceInitialValues(null); setBatchReplaceSearchContext(null);
    setHighlightKeyword(''); setHighlightStatusMessage(''); setSelectedSearchResult(null); setRunningActionId(null); setIsEditMode(false); setPageStructureHistory({ past: [], future: [] }); clearSelectedDocument();
  };

  const handleNewDocumentSelect = async (file) => {
    setPageStructureHistory({ past: [], future: [] });
    await handleDocumentSelect(file);
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
      matchMode: options?.matchMode === 'exact' ? 'exact' : 'contains',
      selectedTargets: Array.isArray(options?.selectedTargets) ? options.selectedTargets : null,
      append: options?.append === true
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
    const tables = Array.isArray(payload?.tables) ? payload.tables : undefined;
    if (!selectedDocument?.file || previewModel?.type !== 'pdf') {
      throw new Error('현재 선택된 PDF 문서가 없습니다.');
    }

    if ((!replacement?.originalText || replacement?.newText == null) && movableTexts.length === 0 && highlights.length === 0 && images.length === 0 && !tables?.length && !payload?.tablesChanged) {
      throw new Error('화면에 적용된 텍스트 이동 또는 하이라이트 결과가 없습니다.');
    }
    const { convertPdfWithOriginalOverlay } = await import('./services/pdfOverlayConvertService');
    return convertPdfWithOriginalOverlay({ file: selectedDocument.file, replacement, movableTexts, highlights, images, tables, tablesChanged: payload?.tablesChanged, download: payload?.download !== false });
  };

  const handlePdfPagesChanged = async ({ sourceBytes, outputBytes, action, containsEncryptedSource = false, encryptionSource = undefined }) => {
    if (!selectedDocument?.file || !sourceBytes?.byteLength || !outputBytes?.byteLength) throw new Error('변경된 PDF 데이터를 만들지 못했습니다.');
    const previousFile = new File([sourceBytes], selectedDocument.file.name, {
      type: 'application/pdf',
      lastModified: Date.now()
    });
    const updatedFile = new File([outputBytes], selectedDocument.file.name, {
      type: 'application/pdf',
      lastModified: Date.now()
    });
    previousFile.docPilotContainsEncryptedSource = Boolean(selectedDocument.file.docPilotContainsEncryptedSource);
    updatedFile.docPilotContainsEncryptedSource = previousFile.docPilotContainsEncryptedSource || containsEncryptedSource;
    previousFile.docPilotEncryptionSource = selectedDocument.file.docPilotEncryptionSource;
    updatedFile.docPilotEncryptionSource = encryptionSource === undefined
      ? previousFile.docPilotEncryptionSource
      : encryptionSource;
    await handleDocumentSelect(updatedFile);
    setPageStructureHistory((history) => ({ past: [...history.past, { before: previousFile, after: updatedFile, action }], future: [] }));
    setSelectedSearchResult(null);
    setHighlightKeyword('');
    setHighlightStatusMessage(`페이지 ${action === 'insert' ? '삽입' : '삭제'}가 적용되었습니다. 변경된 페이지 번호로 계속 작업할 수 있습니다.`);
  };

  const undoPdfPageChange = async () => {
    const entry = pageStructureHistory.past.at(-1);
    if (!entry) return false;
    await handleDocumentSelect(entry.before);
    setPageStructureHistory((history) => ({ past: history.past.slice(0, -1), future: [entry, ...history.future] }));
    setSelectedSearchResult(null);
    setHighlightKeyword('');
    setHighlightStatusMessage(entry.action === 'insert' ? '삽입한 페이지를 되돌렸습니다.' : '삭제한 페이지를 복원했습니다.');
    return true;
  };

  const redoPdfPageChange = async () => {
    const entry = pageStructureHistory.future[0];
    if (!entry) return false;
    await handleDocumentSelect(entry.after);
    setPageStructureHistory((history) => ({ past: [...history.past, entry], future: history.future.slice(1) }));
    setSelectedSearchResult(null);
    setHighlightKeyword('');
    setHighlightStatusMessage(`페이지 ${entry.action === 'insert' ? '삽입' : '삭제'}를 다시 적용했습니다.`);
    return true;
  };

  const handleBatchReplaceApply = async (originalText, newText, options = {}) => {
    if (!isEditMode) throw new Error('편집모드를 활성화 해주세요');
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
      const searchResponse = await handleDocumentSearch(action.keyword, { matchMode: 'contains' });
      const searchResults = getSearchResults(searchResponse);
      const selectedTargets = resolveHighlightTargets(searchResults, action);
      if (!searchResults.length) {
        throw new Error('하이라이트 검색 결과가 없습니다.');
      }
      if (!action.all && !selectedTargets.length) {
        throw new Error('하이라이트 대상의 페이지와 페이지 내 순번을 검색 결과에서 확인하지 못했습니다.');
      }
      const result = await handleHighlightSearch(action.keyword, {
        color: action.color || 'yellow',
        matchMode: 'contains',
        selectedTargets: action.all ? selectedTargets : selectedTargets,
        append: true
      });
      if (!result.ok) throw new Error(result.message || '하이라이트를 적용하지 못했습니다.');
      const count = normalizeCount(result);
      const locations = selectedTargets.map((target) => `${target.pageNumber ?? target.page}페이지 ${target.highlightOccurrence ? `${target.highlightOccurrence}번째` : '전체'} (${target.color})`).join(', ');
      appendAssistantMessage(`검색 결과를 확인한 뒤 하이라이트를 적용했습니다.\n대상 단어: ${action.keyword}\n적용 건수: ${count}건${locations ? `\n적용 위치: ${locations}` : ''}`);
    });
  };

  const executeBatchReplaceAction = async (messageId, action) => {
    if (!requireDocumentForAction()) return;
    if (!isEditMode) {
      appendAssistantMessage('편집모드를 활성화 해주세요');
      return;
    }
    const originalText = String(action?.originalText || '').trim();
    const newText = String(action?.newText ?? '');
    if (!originalText || !newText.trim()) {
      appendAssistantMessage('일괄 변경할 찾을 텍스트 또는 변경할 텍스트가 없습니다. 요청을 다시 입력해주세요.');
      return;
    }
    await runAction(messageId, 'batch-replace', async () => {
      const searchResponse = await handleDocumentSearch(originalText, { matchMode: 'contains' });
      const searchResults = getSearchResults(searchResponse);
      if (!searchResults.length) throw new Error('텍스트 변경 검색 결과가 없습니다.');
      const selectedTargets = resolveReplacementTargets(searchResults, action);

      if (action?.all === true || selectedTargets.length > 0) {
        const result = await handleBatchReplaceApply(originalText, newText, {
          matchMode: 'contains',
          selectedTargets
        });
        appendAssistantMessage(`텍스트 변경을 적용했습니다.\n변경 전: ${originalText}\n변경 후: ${newText}\n적용 건수: ${normalizeCount(result)}건`);
        return;
      }

      const listIndex = resolveListIndex(action?.requestText);
      const contextResults = batchReplaceSearchContext?.originalText === originalText
        ? batchReplaceSearchContext.results
        : searchResults;
      if (listIndex && contextResults[listIndex - 1]) {
        await handleBatchReplaceApply(originalText, newText, {
          matchMode: 'contains',
          selectedTargets: [contextResults[listIndex - 1]?.raw || contextResults[listIndex - 1]]
        });
        appendAssistantMessage(`목록 ${listIndex}번 항목에 텍스트 변경을 적용했습니다.\n변경 전: ${originalText}\n변경 후: ${newText}`);
        return;
      }

      setBatchReplaceSearchContext({ originalText, newText, results: searchResults });
      appendAssistantMessage(
        `변경할 범위가 지정되지 않았습니다. 아래 목록에서 전체 적용할지, 특정 목록 번호를 적용할지 말씀해주세요.`,
        { batchReplaceResults: searchResults, batchReplacementText: newText }
      );
    });
  };

  const appContent = (
    <div className="app-page" onPointerDown={handleTemporarySearchDismiss}><div className="ambient ambient-left" /><div className="ambient ambient-right" /><div className="app-shell"><main className="main-layout">
      <DocumentWorkspace ref={documentViewerRef} selectedDocument={selectedDocument} previewModel={previewModel} highlightKeyword={highlightKeyword} highlightStatusMessage={highlightStatusMessage} selectedSearchResult={selectedSearchResult} errorMessage={errorMessage} isEditMode={isEditMode} onEditModeChange={setIsEditMode} onDocumentSelect={handleNewDocumentSelect} onDocumentClear={resetDocumentViewState} onDocumentReselect={resetDocumentViewState} onVisualPdfConvert={handleVisualPdfConvert} onPdfPagesChanged={handlePdfPagesChanged} onUndoPdfPageChange={undoPdfPageChange} onRedoPdfPageChange={redoPdfPageChange} onPdfDocumentChanged={() => setPageStructureHistory((history) => history.future.length ? { ...history, future: [] } : history)} canUndoPdfPageChange={pageStructureHistory.past.length > 0} canRedoPdfPageChange={pageStructureHistory.future.length > 0} />
      <AssistantPanel messages={messages} loading={chatLoading} error={chatError} selectedDocument={selectedDocument} runningActionId={runningActionId} isEditMode={isEditMode} onSendMessage={handleSendMessage} onSearchCardClick={() => setIsSearchModalOpen(true)} onHighlightCardClick={() => setIsHighlightModalOpen(true)} onBatchReplaceCardClick={() => { if (!isEditMode) { appendAssistantMessage('편집모드를 활성화 해주세요'); return; } setBatchReplaceInitialValues(null); setBatchReplaceSearchContext(null); setIsBatchReplaceModalOpen(true); }} onSearchResultClick={handleSearchResultClick} onExecuteSearchAction={executeSearchAction} onExecuteHighlightAction={executeHighlightAction} onExecuteBatchReplaceAction={executeBatchReplaceAction} />
    </main></div>
    {isSearchModalOpen ? <SearchModal selectedDocument={selectedDocument} previewModel={previewModel} onSearch={handleDocumentSearch} onReset={handleSearchReset} onResultClick={handleSearchResultClick} onClose={() => setIsSearchModalOpen(false)} /> : null}
    <HighlightModal
      isOpen={isHighlightModalOpen}
      selectedDocument={selectedDocument}
      previewModel={previewModel}
      onSearch={handleDocumentSearch}
      onApply={handleHighlightSearch}
      onReset={handleHighlightReset}
      onResultClick={handleHighlightResultClick}
      onClose={() => setIsHighlightModalOpen(false)}
    />
    <BatchTextReplaceModal
      isOpen={isBatchReplaceModalOpen}
      selectedDocument={selectedDocument}
      previewModel={previewModel}
      initialValues={batchReplaceInitialValues}
      onSearch={handleDocumentSearch}
      onApply={handleBatchReplaceApply}
      onResultClick={handleSearchResultClick}
      onClose={() => { setIsBatchReplaceModalOpen(false); setBatchReplaceInitialValues(null); setBatchReplaceSearchContext(null); }}
    />
    </div>
  );
  return <AppErrorBoundary>{appContent}</AppErrorBoundary>;
}

export default App;
