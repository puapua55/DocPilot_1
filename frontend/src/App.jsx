import { useEffect, useRef, useState } from 'react';
import AppErrorBoundary from './components/AppErrorBoundary';
import AssistantPanel from './components/AssistantPanel';
import DocumentWorkspace from './components/DocumentWorkspace';
import HighlightModal from './components/HighlightModal';
import ReplaceModal from './components/ReplaceModal';
import SearchModal from './components/SearchModal';
import { useChat } from './hooks/useChat';
import { useDocument } from './hooks/useDocument';
import { applyTextReplacement, convertTextReplacement, getDocumentFileType } from './services/documentReplaceService';
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

function formatSearchResultSummary(results) {
  if (!results.length) return '';
  const visible = results.slice(0, 5);
  const lines = visible.map((result, index) => {
    const page = result.pageNumber ?? result.page ?? result.pageIndex;
    const line = result.lineNumber ?? result.line ?? result.lineIndex;
    const location = [page != null ? `${page}페이지` : '', line != null ? `${line}번째 줄` : ''].filter(Boolean).join(' / ');
    const text = String(result.text ?? result.matchText ?? result.context ?? result.word ?? '').trim();
    return `${index + 1}. ${location || '문서 내 검색 결과'}${text ? `\n   ${text}` : ''}`;
  });
  if (results.length > 5) lines.push(`총 ${results.length}건 중 상위 5건만 표시합니다.`);
  return `\n\n${lines.join('\n')}`;
}

function App() {
  const documentViewerRef = useRef(null);
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isHighlightModalOpen, setIsHighlightModalOpen] = useState(false);
  const [isReplaceModalOpen, setIsReplaceModalOpen] = useState(false);
  const [highlightKeyword, setHighlightKeyword] = useState('');
  const [highlightStatusMessage, setHighlightStatusMessage] = useState('');
  const [replacePreview, setReplacePreview] = useState(null);
  const [selectedSearchResult, setSelectedSearchResult] = useState(null);
  const [, setModifiedDocxHtml] = useState('');
  const [runningActionId, setRunningActionId] = useState(null);
  const { selectedDocument, previewModel, documentText, errorMessage, handleDocumentSelect, clearSelectedDocument } = useDocument();
  const { messages, loading: chatLoading, error: chatError, handleSendMessage, appendAssistantMessage } = useChat(selectedDocument, previewModel, documentViewerRef);

  useEffect(() => { console.log('[App] highlightKeyword:', highlightKeyword); }, [highlightKeyword]);
  useEffect(() => { console.log('[App] selectedFile:', selectedDocument?.file ?? null); }, [selectedDocument]);
  useEffect(() => { console.log('[App] selectedSearchResult:', selectedSearchResult); }, [selectedSearchResult]);

  const resetDocumentViewState = () => {
    setIsSearchModalOpen(false); setIsHighlightModalOpen(false); setIsReplaceModalOpen(false);
    setHighlightKeyword(''); setHighlightStatusMessage(''); setReplacePreview(null); setSelectedSearchResult(null); setModifiedDocxHtml(''); setRunningActionId(null); clearSelectedDocument();
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

  const handleDocxReplace = (originalText, newText) => {
    if (previewModel?.type !== 'word') return { replaceCount: 0, html: '' };
    const replaceCount = documentViewerRef.current?.replaceText?.(originalText, newText) ?? 0;
    const html = documentViewerRef.current?.getModifiedHtml?.() ?? '';
    setModifiedDocxHtml(html);
    setHighlightStatusMessage(replaceCount > 0 ? `DOCX 텍스트 치환 ${replaceCount}건` : '교체할 텍스트를 찾을 수 없습니다.');
    return { replaceCount, html };
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

  const validateReplaceAction = (action) => {
    if (!requireDocumentForAction()) return false;
    if (!String(action?.originalText || '').trim() || !String(action?.newText || '').trim()) {
      appendAssistantMessage('기존 단어와 변경 단어를 확인해주세요.');
      return false;
    }
    return true;
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
      appendAssistantMessage(`검색을 실행했습니다.\n검색어: ${action.keyword}\n검색 결과: ${count}건${formatSearchResultSummary(results)}`);
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

  const executeReplaceApplyAction = async (messageId, action) => {
    if (!validateReplaceAction(action)) return;
    await runAction(messageId, 'replace-apply', async () => {
      const file = selectedDocument.file;
      const fileType = getDocumentFileType(file);
      if ((fileType === 'docx' || fileType === 'word') && !documentViewerRef.current?.replaceText) throw new Error('현재 뷰어에서 텍스트 교체 기능을 사용할 수 없습니다.');
      const result = await applyTextReplacement({ file, fileType, documentViewerRef, originalText: action.originalText, newText: action.newText, onPdfApply: setReplacePreview });
      if (fileType === 'docx') {
        setModifiedDocxHtml(documentViewerRef.current?.getModifiedHtml?.() ?? '');
        setHighlightStatusMessage(normalizeCount(result) > 0 ? `DOCX 텍스트 치환 ${normalizeCount(result)}건` : '교체할 텍스트를 찾을 수 없습니다.');
      }
      const countText = result.replaceCount == null ? '미리보기 적용' : `${normalizeCount(result)}건`;
      appendAssistantMessage(`화면에 텍스트 치환을 적용했습니다.\n기존 단어: ${action.originalText}\n변경 단어: ${action.newText}\n적용 건수: ${countText}`);
    });
  };

  const executeReplaceConvertAction = async (messageId, action) => {
    if (!validateReplaceAction(action)) return;
    await runAction(messageId, 'replace-convert', async () => {
      const file = selectedDocument.file;
      const fileType = getDocumentFileType(file);
      const result = await convertTextReplacement({ file, fileType, originalText: action.originalText, newText: action.newText });
      const fileName = result?.fileName || result?.outputFileName || `${file.name} 변환 파일`;
      appendAssistantMessage(`변환 파일 다운로드를 실행했습니다.\n기존 단어: ${action.originalText}\n변경 단어: ${action.newText}\n파일명: ${fileName}${result?.replaceCount != null ? `\n치환 건수: ${result.replaceCount}건` : ''}`);
    });
  };

  const appContent = (
    <div className="app-page"><div className="ambient ambient-left" /><div className="ambient ambient-right" /><div className="app-shell"><main className="main-layout">
      <DocumentWorkspace ref={documentViewerRef} selectedDocument={selectedDocument} previewModel={previewModel} highlightKeyword={highlightKeyword} highlightStatusMessage={highlightStatusMessage} replacePreview={replacePreview} selectedSearchResult={selectedSearchResult} errorMessage={errorMessage} onDocumentSelect={handleDocumentSelect} onDocumentClear={resetDocumentViewState} onDocumentReselect={resetDocumentViewState} />
      <AssistantPanel messages={messages} loading={chatLoading} error={chatError} selectedDocument={selectedDocument} runningActionId={runningActionId} onSendMessage={handleSendMessage} onSearchCardClick={() => setIsSearchModalOpen(true)} onHighlightCardClick={() => setIsHighlightModalOpen(true)} onReplaceCardClick={() => setIsReplaceModalOpen(true)} onExecuteSearchAction={executeSearchAction} onExecuteHighlightAction={executeHighlightAction} onExecuteReplaceApplyAction={executeReplaceApplyAction} onExecuteReplaceConvertAction={executeReplaceConvertAction} />
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
    <ReplaceModal isOpen={isReplaceModalOpen} selectedDocument={selectedDocument} previewModel={previewModel} onDocxReplace={handleDocxReplace} onApplyPreview={setReplacePreview} onClose={() => setIsReplaceModalOpen(false)} />
    </div>
  );
  return <AppErrorBoundary>{appContent}</AppErrorBoundary>;
}

export default App;
