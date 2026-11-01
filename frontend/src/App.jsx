import { useEffect, useRef, useState } from 'react';
import AppErrorBoundary from './components/AppErrorBoundary';
import AssistantPanel from './components/AssistantPanel';
import BatchTextReplaceModal from './components/BatchTextReplaceModal';
import DocumentWorkspace from './components/DocumentWorkspace';
import HighlightModal from './components/HighlightModal';
import PdfPasswordDialog from './components/PdfPasswordDialog';
import SearchModal from './components/SearchModal';
import { useChat } from './hooks/useChat';
import { useDocument } from './hooks/useDocument';
import { searchKeywordInDocument } from './services/searchService';
import { findSimilarDocumentTexts } from './services/similarTextSearch';

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

function filterResultsByPageScope(results, scope, viewer) {
  if (!scope) return results;
  const pageCount = viewer?.getPageCount?.();
  const currentPage = viewer?.getCurrentPageNumber?.();
  if (['last', 'last-n'].includes(scope.kind) && (!Number.isSafeInteger(pageCount) || pageCount < 1)) {
    throw new Error('문서의 마지막 페이지를 확인하지 못했습니다.');
  }
  if (['current', 'from-current'].includes(scope.kind) && (!Number.isSafeInteger(currentPage) || currentPage < 1)) {
    throw new Error('현재 페이지를 확인하지 못했습니다.');
  }
  const isIncluded = (page) => {
    switch (scope.kind) {
      case 'page': return page === scope.page;
      case 'range': return page >= scope.startPage && page <= scope.endPage;
      case 'pages': return scope.pages.includes(page);
      case 'first-n': return page <= scope.count;
      case 'last-n': return page > pageCount - scope.count;
      case 'from': return page >= scope.startPage;
      case 'from-current': return page >= currentPage;
      case 'current': return page === currentPage;
      case 'first': return page === 1;
      case 'last': return page === pageCount;
      default: throw new Error('지원하지 않는 페이지 범위입니다.');
    }
  };
  return results.filter((result) => isIncluded(Number(result?.pageNumber ?? result?.page)));
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
  if (!targets.length && ['first', 'last', 'current'].includes(action?.pageScope?.kind)) {
    const selected = orderedResults[0];
    return selected ? [{ ...(selected.raw || selected), color: action.color, highlightOccurrence: 1 }] : [];
  }
  if (!targets.length) return [];

  return targets.map((target) => {
    const page = Number(target?.page);
    const line = Number(target?.line ?? target?.lineNumber);
    const occurrence = Number(target?.occurrence);
    const pageResults = orderedResults.filter((result) => Number(result?.pageNumber ?? result?.page) === page);
    const lineResults = Number.isInteger(line) && line > 0
      ? pageResults.filter((result) => Number(result?.lineNumber ?? result?.line) === line)
      : pageResults;
    const selected = target?.occurrence === 'last' ? lineResults.at(-1)
      : lineResults[Number.isInteger(occurrence) && occurrence > 0 ? occurrence - 1 : 0];
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
  const [pendingSimilarSearch, setPendingSimilarSearch] = useState(null);
  const [pendingLimitedSearch, setPendingLimitedSearch] = useState(null);
  const [isAiEnabled, setIsAiEnabled] = useState(() => {
    try { return window.localStorage.getItem('docpilot-ai-enabled') !== 'false'; }
    catch { return true; }
  });
  const [pageStructureHistory, setPageStructureHistory] = useState({ past: [], future: [] });
  const [protectedPdfFile, setProtectedPdfFile] = useState(null);
  const { selectedDocument, previewModel, documentText, errorMessage, handleDocumentSelect, clearSelectedDocument } = useDocument();
  const { messages, loading: chatLoading, error: chatError, handleSendMessage, appendAssistantMessage, appendUserMessage } = useChat(selectedDocument, previewModel, documentViewerRef, isEditMode, isAiEnabled);
  const isPdfEditRestricted = previewModel?.type === 'pdf' && selectedDocument?.file?.docPilotEditRestricted === true;
  const pdfEditRestrictedMessage = '이 PDF는 비밀번호 없이 열리는 암호화 문서이므로 편집할 수 없습니다.';

  useEffect(() => { console.log('[App] highlightKeyword:', highlightKeyword); }, [highlightKeyword]);
  useEffect(() => { console.log('[App] selectedSearchResult:', selectedSearchResult); }, [selectedSearchResult]);
  useEffect(() => {
    try { window.localStorage.setItem('docpilot-ai-enabled', String(isAiEnabled)); }
    catch { /* localStorage may be unavailable in restricted browser contexts. */ }
  }, [isAiEnabled]);

  const handleAiEnabledChange = (enabled) => {
    const nextEnabled = Boolean(enabled);
    setIsAiEnabled(nextEnabled);
    appendAssistantMessage(nextEnabled
      ? 'AI 온라인 모드로 전환했습니다. 설정된 AI 공급자를 사용해 자연어 요청을 해석합니다.'
      : 'AI 오프라인 모드로 전환했습니다. 외부 AI에 연결하지 않고 이 PC에서 검색, 하이라이트, 텍스트 일괄 변경 명령을 해석합니다.');
  };

  const resetDocumentViewState = () => {
    setIsSearchModalOpen(false); setIsHighlightModalOpen(false); setIsBatchReplaceModalOpen(false); setBatchReplaceInitialValues(null); setBatchReplaceSearchContext(null);
    setHighlightKeyword(''); setHighlightStatusMessage(''); setSelectedSearchResult(null); setRunningActionId(null); setPendingSimilarSearch(null); setPendingLimitedSearch(null); setIsEditMode(false); setPageStructureHistory({ past: [], future: [] }); setProtectedPdfFile(null); clearSelectedDocument();
  };

  const handleNewDocumentSelect = async (file) => {
    setPendingSimilarSearch(null);
    setPendingLimitedSearch(null);
    setPageStructureHistory({ past: [], future: [] });
    setIsHighlightModalOpen(false);
    setIsBatchReplaceModalOpen(false);
    setIsEditMode(false);
    if (file?.name?.toLowerCase().endsWith('.pdf')) {
      try {
        const { requiresPdfPassword, isPdfEncrypted } = await import('./services/pdfEncryption.js');
        if (await requiresPdfPassword(file)) {
          setProtectedPdfFile(file);
          return;
        }
        file.docPilotEditRestricted = await isPdfEncrypted(file);
      } catch (error) {
        // Let the regular viewer report damaged or unsupported PDFs.
        console.warn('[App] PDF password check failed:', error);
      }
    }
    await handleDocumentSelect(file);
  };

  const openProtectedPdf = async (password) => {
    if (!protectedPdfFile) return;
    const { unlockPdfForViewing } = await import('./services/pdfEncryption.js');
    const unlockedFile = await unlockPdfForViewing(protectedPdfFile, password);
    await handleDocumentSelect(unlockedFile);
    setProtectedPdfFile(null);
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
    if (isPdfEditRestricted) return { ok: false, message: pdfEditRestrictedMessage, count: 0, results: [] };
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
    if (isPdfEditRestricted) throw new Error(pdfEditRestrictedMessage);
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
    if (isPdfEditRestricted) throw new Error(pdfEditRestrictedMessage);
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
    if (isPdfEditRestricted) throw new Error(pdfEditRestrictedMessage);
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

  const askSimilarSearchQuestion = (candidates, index, originalKeyword, documentFile) => {
    if (index >= candidates.length) {
      setPendingSimilarSearch(null);
      appendAssistantMessage(`'${originalKeyword}'와 비슷한 문구를 더 찾지 못했습니다.`);
      return;
    }
    const questionId = `similar-search-${Date.now()}-${Math.random()}`;
    setPendingSimilarSearch({ questionId, candidates, index, originalKeyword, documentFile });
    appendAssistantMessage(`찾으려는 텍스트가 '${candidates[index]}'인가요?`, { id: questionId });
  };

  const executeSearchAction = async (messageId, action) => {
    if (!validateKeywordAction(action)) return;
    const requestedLimit = Number(action?.limit);
    const hasLimit = Number.isInteger(requestedLimit) && requestedLimit > 0;
    if (hasLimit && !['first', 'last'].includes(action?.order)) {
      const questionId = `limited-search-${Date.now()}-${Math.random()}`;
      setPendingLimitedSearch({ questionId, action: { ...action, limit: requestedLimit }, documentFile: selectedDocument?.file });
      appendAssistantMessage(`'${action.keyword}' 검색 결과 ${requestedLimit}개를 어느 방향에서 찾을까요?`, {
        id: questionId,
        searchOrderQuestion: true
      });
      return;
    }
    await runAction(messageId, 'search', async () => {
      if (previewModel?.type !== 'word' && previewModel?.type !== 'pdf') {
        throw new Error('지원하지 않는 파일 형식입니다.');
      }
      if (!documentViewerRef.current?.searchDocument && previewModel?.type !== 'pdf') {
        throw new Error('현재 뷰어에서 검색 기능을 사용할 수 없습니다.');
      }
      const rawResult = await handleDocumentSearch(action.keyword, { matchMode: action.matchMode === 'exact' ? 'exact' : 'contains' });
      const results = filterResultsByPageScope(getSearchResults(rawResult), action.pageScope, documentViewerRef.current);
      const totalCount = action.pageScope ? results.length : results.length || normalizeCount(rawResult);
      if (totalCount === 0 && !getSearchResults(rawResult).length && !action.skipSimilarSearch) {
        let segments = [];
        try {
          segments = await documentViewerRef.current?.getSearchableTextSegments?.() || [];
        } catch (error) {
          console.warn('[App] similar text source unavailable:', error);
        }
        const candidates = findSimilarDocumentTexts(segments, action.keyword);
        if (candidates.length) {
          askSimilarSearchQuestion(candidates, 0, action.keyword, selectedDocument?.file);
          return;
        }
      }
      const orderedResults = action?.order === 'last' ? [...results].reverse() : results;
      const scopedResults = action.occurrence === 'last' ? orderedResults.slice(-1)
        : Number.isInteger(Number(action.occurrence)) && Number(action.occurrence) > 0
          ? orderedResults.slice(Number(action.occurrence) - 1, Number(action.occurrence))
          : hasLimit ? orderedResults.slice(0, requestedLimit) : orderedResults;
      const count = hasLimit || action.occurrence ? scopedResults.length : totalCount;
      const visibleResults = scopedResults.slice(0, 20);
      const hasMoreResults = scopedResults.length > visibleResults.length;
      const scopeText = hasLimit
        ? `\n검색 기준: ${action.order === 'last' ? '끝 페이지' : '첫 페이지'}부터 ${requestedLimit}개`
        : '';
      appendAssistantMessage(
        `검색을 실행했습니다.\n검색어: ${action.keyword}${scopeText}\n검색 결과: ${count}건${hasLimit && totalCount > count ? ` (전체 ${totalCount}건)` : ''}${hasMoreResults ? '\n채팅에는 상위 20건을 표시합니다.' : ''}`,
        {
          searchResults: visibleResults,
          searchKeyword: action.keyword,
          searchResultCount: count,
          hasMoreSearchResults: hasMoreResults
        }
      );
    });
  };

  const answerLimitedSearch = async (questionId, order, fromChat = false) => {
    const pending = pendingLimitedSearch;
    if (!pending || pending.questionId !== questionId || pending.documentFile !== selectedDocument?.file) return;
    if (!fromChat) appendUserMessage(order === 'last' ? '끝 페이지 기준' : '첫 페이지 기준');
    setPendingLimitedSearch(null);
    await executeSearchAction(questionId, { ...pending.action, order });
  };

  const answerSimilarSearch = async (questionId, accepted, fromChat = false) => {
    const pending = pendingSimilarSearch;
    if (!pending || pending.questionId !== questionId || pending.documentFile !== selectedDocument?.file) return;
    if (!fromChat) appendUserMessage(accepted ? '맞아요' : '아니요');
    setPendingSimilarSearch(null);
    if (accepted) {
      await executeSearchAction(questionId, {
        keyword: pending.candidates[pending.index],
        skipSimilarSearch: true
      });
    } else {
      askSimilarSearchQuestion(pending.candidates, pending.index + 1,
        pending.originalKeyword, pending.documentFile);
    }
  };

  const handleChatMessage = (message) => {
    const answer = String(message || '').trim();
    if (pendingLimitedSearch?.documentFile === selectedDocument?.file) {
      if (/^(첫\s*페이지|처음|앞|첫페이지)(?:\s*기준)?$/u.test(answer)) {
        appendUserMessage(answer);
        void answerLimitedSearch(pendingLimitedSearch.questionId, 'first', true);
        return;
      }
      if (/^(끝\s*페이지|마지막|뒤|끝페이지)(?:\s*기준)?$/u.test(answer)) {
        appendUserMessage(answer);
        void answerLimitedSearch(pendingLimitedSearch.questionId, 'last', true);
        return;
      }
    }
    if (pendingSimilarSearch?.documentFile === selectedDocument?.file) {
      if (/^(네|예|응|맞아|맞아요|맞습니다|그거야|yes|y)$/iu.test(answer)) {
        appendUserMessage(answer);
        void answerSimilarSearch(pendingSimilarSearch.questionId, true, true);
        return;
      }
      if (/^(아니|아니요|아닙니다|다음|no|n)$/iu.test(answer)) {
        appendUserMessage(answer);
        void answerSimilarSearch(pendingSimilarSearch.questionId, false, true);
        return;
      }
    }
    setPendingSimilarSearch(null);
    setPendingLimitedSearch(null);
    void handleSendMessage(message);
  };

  const executeHighlightAction = async (messageId, action) => {
    if (!validateKeywordAction(action, '하이라이트')) return;
    await runAction(messageId, 'highlight', async () => {
      if (!documentViewerRef.current?.highlightText) throw new Error('현재 뷰어에서 하이라이트 기능을 사용할 수 없습니다.');
      const searchResponse = await handleDocumentSearch(action.keyword, { matchMode: 'contains' });
      const searchResults = filterResultsByPageScope(getSearchResults(searchResponse), action.pageScope, documentViewerRef.current);
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
    if (isPdfEditRestricted) { appendAssistantMessage(pdfEditRestrictedMessage); return; }
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
      const searchResults = filterResultsByPageScope(getSearchResults(searchResponse), action.pageScope, documentViewerRef.current);
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

  const executeDocumentHistoryAction = async (messageId, action) => {
    if (!requireDocumentForAction()) return;
    const actionType = action?.type;
    if (actionType === 'viewer-command') {
      await runAction(messageId, actionType, async () => {
        const operations = Array.isArray(action?.operations) ? action.operations : [];
        if (!operations.length || typeof documentViewerRef.current?.executeViewerCommand !== 'function') {
          throw new Error('현재 문서 뷰어에서 요청한 보기 작업을 사용할 수 없습니다.');
        }
        for (const operation of operations) {
          const result = await documentViewerRef.current.executeViewerCommand(operation);
          if (result?.ok === false) {
            if (result.message === '지원되지 않는 기능입니다.') {
              appendAssistantMessage(result.message);
              return;
            }
            throw new Error(result.message || '문서 보기 작업을 실행하지 못했습니다.');
          }
        }
        const fitOperation = operations.findLast((operation) => operation.command === 'fit');
        appendAssistantMessage(fitOperation
          ? `${fitOperation.mode === 'width' ? '너비 맞춤' : '페이지 맞춤'}을 적용했습니다.`
          : operations.length > 1 ? '요청한 문서 작업을 순서대로 실행했습니다.' : '요청한 문서 작업을 실행했습니다.');
      });
      return;
    }
    if (!['undo', 'redo', 'reset'].includes(actionType)) return;
    await runAction(messageId, actionType, async () => {
      if (actionType === 'reset' && previewModel?.type === 'word' && !window.confirm('모든 기능 적용전으로 초기화 하시겠습니다?')) {
        appendAssistantMessage('전체 초기화를 취소했습니다.');
        return;
      }
      const methodName = actionType === 'undo' ? 'undoDocumentChange'
        : actionType === 'redo' ? 'redoDocumentChange'
          : 'resetAllDocumentChanges';
      const method = documentViewerRef.current?.[methodName];
      if (typeof method !== 'function') throw new Error('현재 문서 뷰어에서 변경 이력 기능을 사용할 수 없습니다.');
      const requestedCount = actionType === 'reset' ? 1 : Math.min(10, Math.max(1, Number(action?.count) || 1));
      let changedCount = 0;
      for (let index = 0; index < requestedCount; index += 1) {
        if (!await method()) break;
        changedCount += 1;
      }
      const successMessage = actionType === 'undo' ? '문서를 이전 상태로 되돌렸습니다.'
        : actionType === 'redo' ? '되돌린 문서 변경을 다시 적용했습니다.'
          : '문서의 편집 내용을 전체 초기화했습니다.';
      const emptyMessage = actionType === 'undo' ? '되돌릴 문서 변경이 없습니다.'
        : actionType === 'redo' ? '다시 적용할 문서 변경이 없습니다.'
          : '초기화할 문서 변경이 없습니다.';
      appendAssistantMessage(changedCount
        ? requestedCount > 1 ? `${successMessage} (${changedCount}회)` : successMessage
        : emptyMessage);
    });
  };

  const appContent = (
    <div className="app-page" onPointerDown={handleTemporarySearchDismiss}><div className="ambient ambient-left" /><div className="ambient ambient-right" /><div className="app-shell"><main className="main-layout">
      <DocumentWorkspace ref={documentViewerRef} selectedDocument={selectedDocument} previewModel={previewModel} highlightKeyword={highlightKeyword} highlightStatusMessage={highlightStatusMessage} selectedSearchResult={selectedSearchResult} errorMessage={errorMessage} isEditMode={isEditMode && !isPdfEditRestricted} isPdfEditRestricted={isPdfEditRestricted} onEditModeChange={(enabled) => setIsEditMode(enabled && !isPdfEditRestricted)} onDocumentSelect={handleNewDocumentSelect} onDocumentClear={resetDocumentViewState} onDocumentReselect={resetDocumentViewState} onVisualPdfConvert={handleVisualPdfConvert} onPdfPagesChanged={handlePdfPagesChanged} onUndoPdfPageChange={undoPdfPageChange} onRedoPdfPageChange={redoPdfPageChange} onPdfDocumentChanged={() => setPageStructureHistory((history) => history.future.length ? { ...history, future: [] } : history)} canUndoPdfPageChange={pageStructureHistory.past.length > 0} canRedoPdfPageChange={pageStructureHistory.future.length > 0} />
      <AssistantPanel messages={messages} loading={chatLoading} error={chatError} selectedDocument={selectedDocument} runningActionId={runningActionId} activeSuggestionId={pendingSimilarSearch?.questionId} activeSearchOrderId={pendingLimitedSearch?.questionId} isAiEnabled={isAiEnabled} isEditMode={isEditMode && !isPdfEditRestricted} isPdfEditRestricted={isPdfEditRestricted} onAiEnabledChange={handleAiEnabledChange} onSendMessage={handleChatMessage} onSearchCardClick={() => setIsSearchModalOpen(true)} onHighlightCardClick={() => { if (isPdfEditRestricted) return; setIsHighlightModalOpen(true); }} onBatchReplaceCardClick={() => { if (isPdfEditRestricted) { appendAssistantMessage(pdfEditRestrictedMessage); return; } if (!isEditMode) { appendAssistantMessage('편집모드를 활성화 해주세요'); return; } setBatchReplaceInitialValues(null); setBatchReplaceSearchContext(null); setIsBatchReplaceModalOpen(true); }} onSearchResultClick={handleSearchResultClick} onSuggestionAnswer={answerSimilarSearch} onSearchOrderAnswer={answerLimitedSearch} onExecuteSearchAction={executeSearchAction} onExecuteHighlightAction={executeHighlightAction} onExecuteBatchReplaceAction={executeBatchReplaceAction} onExecuteDocumentHistoryAction={executeDocumentHistoryAction} />
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
    {protectedPdfFile ? <PdfPasswordDialog
      fileName={protectedPdfFile.name}
      onConfirm={openProtectedPdf}
      onCancel={resetDocumentViewState}
    /> : null}
    </div>
  );
  return <AppErrorBoundary>{appContent}</AppErrorBoundary>;
}

export default App;
