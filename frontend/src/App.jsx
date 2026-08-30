import { useEffect, useState } from 'react';
import AppErrorBoundary from './components/AppErrorBoundary';
import AssistantPanel from './components/AssistantPanel';
import DocumentWorkspace from './components/DocumentWorkspace';
import HighlightModal from './components/HighlightModal';
import ReplaceModal from './components/ReplaceModal';
import SearchModal from './components/SearchModal';
import { useChat } from './hooks/useChat';
import { useDocument } from './hooks/useDocument';
import { countKeywordMatches } from './services/highlightService';

function App() {
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isHighlightModalOpen, setIsHighlightModalOpen] = useState(false);
  const [isReplaceModalOpen, setIsReplaceModalOpen] = useState(false);
  const [highlightKeyword, setHighlightKeyword] = useState('');
  const [highlightStatusMessage, setHighlightStatusMessage] = useState('');
  const [replacePreview, setReplacePreview] = useState(null);
  const [selectedSearchResult, setSelectedSearchResult] = useState(null);
  const {
    selectedDocument,
    previewModel,
    documentText,
    errorMessage,
    handleDocumentSelect,
    clearSelectedDocument
  } = useDocument();
  const { messages, handleSendMessage } = useChat(selectedDocument);

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
    setSelectedSearchResult({
      ...result,
      clickedAt: Date.now()
    });
    setIsSearchModalOpen(false);
  };

  const handleHighlightSearch = (keyword) => {
    if (!selectedDocument) {
      return {
        ok: false,
        message: '먼저 문서를 선택해주세요.'
      };
    }

    if (previewModel?.type !== 'pdf') {
      return {
        ok: false,
        message: '위치 하이라이트는 현재 PDF 문서에서만 지원됩니다.'
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

  const appContent = (
    <div className="app-page">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <div className="app-shell">
        <main className="main-layout">
          <DocumentWorkspace
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
            onSendMessage={handleSendMessage}
            onSearchCardClick={() => setIsSearchModalOpen(true)}
            onHighlightCardClick={() => setIsHighlightModalOpen(true)}
            onReplaceCardClick={() => setIsReplaceModalOpen(true)}
          />
        </main>
      </div>
      {isSearchModalOpen ? (
        <SearchModal
          documentText={documentText}
          selectedDocument={selectedDocument}
          onResultClick={handleSearchResultClick}
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
        onClose={() => setIsReplaceModalOpen(false)}
      />
    </div>
  );

  return <AppErrorBoundary>{appContent}</AppErrorBoundary>;
}

export default App;
