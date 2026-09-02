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
import { applyTextReplacement, convertTextReplacement, getDocumentFileType } from './services/documentReplaceService';
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
  const [runningActionId, setRunningActionId] = useState('');
  const {
    selectedDocument,
    previewModel,
    documentText,
    errorMessage,
    handleDocumentSelect,
    clearSelectedDocument
  } = useDocument();
  const { messages, handleSendMessage, appendAssistantMessage } = useChat(selectedDocument);

  useEffect(() => {
    console.log('[App] highlightKeyword:', highlightKeyword);
  }, [highlightKeyword]);

  useEffect(() => {
    console.log('[App] selectedFile:', selectedDocument?.file ?? null);
  }, [selectedDocument]);

  useEffect(() => {
    console.log('[App] selectedSearchResult:', selectedSearchResult);
  }, [selectedSearchResult]);

  const resetDocumentViewState = () => {
    setIsSearchModalOpen(false);
    setIsHighlightModalOpen(false);
    setIsReplaceModalOpen(false);
    setHighlightKeyword('');
    setHighlightStatusMessage('');
    setReplacePreview(null);
    setSelectedSearchResult(null);
    clearSelectedDocument();
  };

  const handleSearchResultClick = (result) => {
    console.log('[SearchResult] clicked:', result);

    if (result?.type === 'docx') {
      documentViewerRef.current?.scrollToSearchResult?.(result);
    }

    setSelectedSearchResult({
      ...result,
      clickedAt: Date.now()
    });
    setIsSearchModalOpen(false);
  };

  const searchActiveDocument = (keyword) => {
    if (documentViewerRef.current?.getViewerType?.() === 'docx') {
      return documentViewerRef.current?.searchDocument?.(keyword) || [];
    }

    return searchKeywordInDocument(documentText, keyword);
  };

  const handleHighlightSearch = (keyword) => {
    if (!selectedDocument) {
      return {
        ok: false,
        message: '먼저 문서를 선택해주세요.'
      };
    }

    if (documentViewerRef.current?.getViewerType?.() === 'docx') {
      const matchCount = documentViewerRef.current?.highlightText?.(keyword) || 0;

      if (matchCount === 0) {
        setHighlightStatusMessage('검색 결과가 없습니다.');
        return {
          ok: true,
          closeModal: true
        };
      }

      setHighlightStatusMessage(`${matchCount}개의 검색 결과를 표시했습니다.`);

      return {
        ok: true,
        closeModal: true
      };
    }

    const matchCount = countKeywordMatches(documentText, keyword);

    setHighlightKeyword(keyword);

    if (matchCount === 0) {
      setHighlightStatusMessage('검색 결과가 없습니다.');
      return {
        ok: true,
        closeModal: true
      };
    }

    setHighlightStatusMessage(`${matchCount}개의 검색 결과를 표시했습니다.`);

    return {
      ok: true,
      closeModal: true
    };
  };

  const runAiDocumentAction = async (messageId, actionType, run) => {
    setRunningActionId(`${messageId}:${actionType}`);

    try {
      await run();
    } catch (error) {
      console.error('[App] AI document action failed:', error);
      appendAssistantMessage(error?.message || '문서 작업을 완료하지 못했습니다.');
    } finally {
      setRunningActionId('');
    }
  };

  const getAiActionFile = () => {
    const file = selectedDocument?.file;
    if (!file) {
      throw new Error('먼저 문서를 선택해주세요.');
    }

    return { file, fileType: getDocumentFileType(file) };
  };

  const handleAiReplaceApply = (messageId, action) => runAiDocumentAction(messageId, 'replace-apply', async () => {
    const { file, fileType } = getAiActionFile();
    const result = await applyTextReplacement({
      file,
      fileType,
      documentViewerRef,
      originalText: action.originalText,
      newText: action.newText,
      onPdfApply: setReplacePreview
    });

    appendAssistantMessage(`화면 적용 완료: ${result.replaceCount ?? 0}건`);
  });

  const handleAiReplaceConvert = (messageId, action) => runAiDocumentAction(messageId, 'replace-convert', async () => {
    const { file, fileType } = getAiActionFile();
    const result = await convertTextReplacement({
      file,
      fileType,
      originalText: action.originalText,
      newText: action.newText
    });

    appendAssistantMessage(
      result.replaceCount > 0
        ? `변환 파일 다운로드 완료: ${result.outputFileName}`
        : '교체할 텍스트를 찾을 수 없습니다.'
    );
  });

  const handleAiSearch = (messageId, action) => runAiDocumentAction(messageId, 'search', async () => {
    getAiActionFile();
    const keyword = String(action?.keyword || '').trim();
    const results = searchActiveDocument(keyword);

    if (!keyword) {
      appendAssistantMessage('검색어를 확인해주세요.');
      return;
    }

    if (results.length === 0) {
      appendAssistantMessage(`"${keyword}" 검색 결과가 없습니다.`);
      return;
    }

    const summary = results.slice(0, 5).map((result, index) => {
      const pageNumber = result.pageNumber ?? result.page;
      const paragraphNumber = result.paragraphNumber ?? result.paragraphIndex ?? result.lineNumber ?? result.line;
      const text = result.text || result.previewText || result.fullText || result.matchedText || '';
      const location = [
        pageNumber ? `${pageNumber}페이지` : null,
        paragraphNumber ? `문단 ${paragraphNumber}` : null
      ].filter(Boolean).join(' / ');

      return `${index + 1}. ${location || '-'}\n${text}`;
    }).join('\n\n');

    appendAssistantMessage(`"${keyword}" 검색 결과 ${results.length}건을 찾았습니다.\n\n${summary}`);
  });

  const appContent = (
    <div className="app-page">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <div className="app-shell">
        <main className="main-layout">
          <DocumentWorkspace
            viewerRef={documentViewerRef}
            selectedDocument={selectedDocument}
            previewModel={previewModel}
            highlightKeyword={highlightKeyword}
            highlightStatusMessage={highlightStatusMessage}
            replacePreview={replacePreview}
            selectedSearchResult={selectedSearchResult}
            errorMessage={errorMessage}
            onDocumentSelect={handleDocumentSelect}
            onDocumentClear={resetDocumentViewState}
            onDocumentReselect={resetDocumentViewState}
          />
          <AssistantPanel
            messages={messages}
            selectedDocument={selectedDocument}
            runningActionId={runningActionId}
            onSendMessage={handleSendMessage}
            onSearchCardClick={() => setIsSearchModalOpen(true)}
            onHighlightCardClick={() => setIsHighlightModalOpen(true)}
            onReplaceCardClick={() => setIsReplaceModalOpen(true)}
            onExecuteSearchAction={handleAiSearch}
            onExecuteReplaceApplyAction={handleAiReplaceApply}
            onExecuteReplaceConvertAction={handleAiReplaceConvert}
          />
        </main>
      </div>
      {isSearchModalOpen ? (
        <SearchModal
          documentText={documentText}
          selectedDocument={selectedDocument}
          onResultClick={handleSearchResultClick}
          onSearchDocument={(keyword) => {
            return searchActiveDocument(keyword);
          }}
          onClose={() => setIsSearchModalOpen(false)}
        />
      ) : null}
      <HighlightModal
        isOpen={isHighlightModalOpen}
        onClose={() => setIsHighlightModalOpen(false)}
        onSearch={handleHighlightSearch}
      />
      <ReplaceModal
        isOpen={isReplaceModalOpen}
        selectedDocument={selectedDocument}
        previewModel={previewModel}
        onApplyPreview={setReplacePreview}
        onReplaceDocument={(originalText, newText) => {
          if (documentViewerRef.current?.getViewerType?.() === 'docx') {
            return documentViewerRef.current?.replaceText?.(originalText, newText) || 0;
          }

          return null;
        }}
        onClose={() => setIsReplaceModalOpen(false)}
      />
    </div>
  );

  return <AppErrorBoundary>{appContent}</AppErrorBoundary>;
}

export default App;
