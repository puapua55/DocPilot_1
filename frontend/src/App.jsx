import { useEffect, useRef, useState } from 'react';
import AppErrorBoundary from './components/AppErrorBoundary';
import AssistantPanel from './components/AssistantPanel';
import DocumentWorkspace from './components/DocumentWorkspace';
import HighlightModal from './components/HighlightModal';
import ReplaceModal from './components/ReplaceModal';
import SearchModal from './components/SearchModal';
import { useChat } from './hooks/useChat';
import { useDocument } from './hooks/useDocument';
import { countKeywordMatches } from './services/highlightService';
import { convertTextReplacement, getDocumentFileType } from './services/documentReplaceService';
import { searchKeywordInDocument } from './services/searchService';

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
  const { selectedDocument, previewModel, documentText, errorMessage, handleDocumentSelect, clearSelectedDocument } = useDocument();
  const { messages, loading: chatLoading, error: chatError, handleSendMessage, appendAssistantMessage } = useChat(selectedDocument, previewModel, documentViewerRef);

  useEffect(() => { console.log('[App] highlightKeyword:', highlightKeyword); }, [highlightKeyword]);
  useEffect(() => { console.log('[App] selectedFile:', selectedDocument?.file ?? null); }, [selectedDocument]);
  useEffect(() => { console.log('[App] selectedSearchResult:', selectedSearchResult); }, [selectedSearchResult]);

  const resetDocumentViewState = () => {
    setIsSearchModalOpen(false); setIsHighlightModalOpen(false); setIsReplaceModalOpen(false);
    setHighlightKeyword(''); setHighlightStatusMessage(''); setReplacePreview(null); setSelectedSearchResult(null); setModifiedDocxHtml(''); clearSelectedDocument();
  };

  const handleDocxSearch = (keyword) => previewModel?.type === 'word' ? (documentViewerRef.current?.searchDocument?.(keyword) ?? []) : [];

  const handleSearchResultClick = (result) => {
    console.log('[SearchResult] clicked:', result);
    if (result?.type === 'docx') documentViewerRef.current?.scrollToSearchResult?.(result.index);
    setSelectedSearchResult({ ...result, clickedAt: Date.now() });
    setIsSearchModalOpen(false);
  };

  const handleHighlightSearch = (keyword) => {
    if (!selectedDocument) return { ok: false, message: '먼저 문서를 선택해주세요.', matchCount: 0 };
    if (previewModel?.type === 'word') {
      const matchCount = documentViewerRef.current?.highlightText?.(keyword) ?? 0;
      setHighlightKeyword('');
      setHighlightStatusMessage(matchCount === 0 ? '검색 결과가 없습니다.' : `${matchCount}개의 DOCX 검색 결과를 표시했습니다.`);
      return { ok: true, closeModal: true, matchCount };
    }
    if (previewModel?.type !== 'pdf') return { ok: false, message: '지원하는 문서 형식이 아닙니다.', matchCount: 0 };
    const matchCount = countKeywordMatches(documentText, keyword);
    setHighlightKeyword(keyword);
    setHighlightStatusMessage(matchCount === 0 ? '검색 결과가 없습니다.' : `${matchCount}개의 검색 결과를 표시했습니다.`);
    return { ok: true, closeModal: true, matchCount };
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

  const executeSearchAction = async (action) => {
    if (!requireDocumentForAction() || !action?.keyword) return;
    const results = previewModel?.type === 'word'
      ? handleDocxSearch(action.keyword)
      : await searchKeywordInDocument(documentText, action.keyword);
    appendAssistantMessage(`검색을 실행했습니다. '${action.keyword}' 검색 결과 ${results.length}건을 찾았습니다.`);
  };

  const executeHighlightAction = (action) => {
    if (!requireDocumentForAction() || !action?.keyword) return;
    const result = handleHighlightSearch(action.keyword);
    appendAssistantMessage(result.ok
      ? `'${action.keyword}' 하이라이트를 ${result.matchCount ?? 0}건 적용했습니다.`
      : result.message);
  };

  const executeReplaceApplyAction = (action) => {
    if (!requireDocumentForAction() || !action?.originalText || action.newText == null) return;
    if (previewModel?.type === 'word') {
      const result = handleDocxReplace(action.originalText, action.newText);
      appendAssistantMessage(`화면에 '${action.originalText}' → '${action.newText}' 치환을 ${result.replaceCount}건 적용했습니다.`);
      return;
    }
    if (previewModel?.type === 'pdf') {
      setReplacePreview({ originalText: action.originalText, newText: action.newText, appliedAt: Date.now() });
      appendAssistantMessage(`현재 PDF 화면에 '${action.originalText}' → '${action.newText}' 치환 미리보기를 적용했습니다.`);
      return;
    }
    appendAssistantMessage('지원하는 문서 형식이 아닙니다.');
  };

  const executeReplaceConvertAction = async (action) => {
    if (!requireDocumentForAction() || !action?.originalText || action.newText == null) return;
    const file = selectedDocument.file;
    try {
      const result = await convertTextReplacement({
        file,
        fileType: getDocumentFileType(file),
        originalText: action.originalText,
        newText: action.newText
      });
      appendAssistantMessage(`'${action.originalText}' → '${action.newText}'이 반영된 변환 파일을 다운로드했습니다.${result.replaceCount != null ? ` 치환 ${result.replaceCount}건` : ''}`);
    } catch (error) {
      appendAssistantMessage(error?.message || '문서 변환 중 오류가 발생했습니다.');
    }
  };

  const appContent = (
    <div className="app-page"><div className="ambient ambient-left" /><div className="ambient ambient-right" /><div className="app-shell"><main className="main-layout">
      <DocumentWorkspace ref={documentViewerRef} selectedDocument={selectedDocument} previewModel={previewModel} highlightKeyword={highlightKeyword} highlightStatusMessage={highlightStatusMessage} replacePreview={replacePreview} selectedSearchResult={selectedSearchResult} errorMessage={errorMessage} onDocumentSelect={handleDocumentSelect} onDocumentClear={resetDocumentViewState} onDocumentReselect={resetDocumentViewState} />
      <AssistantPanel messages={messages} loading={chatLoading} error={chatError} selectedDocument={selectedDocument} onSendMessage={handleSendMessage} onSearchCardClick={() => setIsSearchModalOpen(true)} onHighlightCardClick={() => setIsHighlightModalOpen(true)} onReplaceCardClick={() => setIsReplaceModalOpen(true)} onExecuteSearchAction={executeSearchAction} onExecuteHighlightAction={executeHighlightAction} onExecuteReplaceApplyAction={executeReplaceApplyAction} onExecuteReplaceConvertAction={executeReplaceConvertAction} />
    </main></div>
    {isSearchModalOpen ? <SearchModal documentText={documentText} selectedDocument={selectedDocument} previewModel={previewModel} onDocxSearch={handleDocxSearch} onResultClick={handleSearchResultClick} onClose={() => setIsSearchModalOpen(false)} /> : null}
    <HighlightModal isOpen={isHighlightModalOpen} onClose={() => setIsHighlightModalOpen(false)} onSearch={handleHighlightSearch} />
    <ReplaceModal isOpen={isReplaceModalOpen} selectedDocument={selectedDocument} previewModel={previewModel} onDocxReplace={handleDocxReplace} onApplyPreview={setReplacePreview} onClose={() => setIsReplaceModalOpen(false)} />
    </div>
  );
  return <AppErrorBoundary>{appContent}</AppErrorBoundary>;
}

export default App;
