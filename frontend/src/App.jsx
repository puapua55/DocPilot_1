import { useEffect, useState } from 'react';
import AssistantPanel from './components/AssistantPanel';
import DocumentWorkspace from './components/DocumentWorkspace';
import HighlightModal from './components/HighlightModal';
import SearchModal from './components/SearchModal';
import { useChat } from './hooks/useChat';
import { useDocument } from './hooks/useDocument';
import { countKeywordMatches } from './services/highlightService';

function App() {
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isHighlightModalOpen, setIsHighlightModalOpen] = useState(false);
  const [highlightKeyword, setHighlightKeyword] = useState('');
  const [highlightStatusMessage, setHighlightStatusMessage] = useState('');
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

  const resetDocumentViewState = () => {
    setIsSearchModalOpen(false);
    setIsHighlightModalOpen(false);
    setHighlightKeyword('');
    setHighlightStatusMessage('');
    clearSelectedDocument();
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

  return (
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
          />
        </main>
      </div>
      {isSearchModalOpen ? (
        <SearchModal
          documentText={documentText}
          selectedDocument={selectedDocument}
          onClose={() => setIsSearchModalOpen(false)}
        />
      ) : null}
      <HighlightModal
        isOpen={isHighlightModalOpen}
        onClose={() => setIsHighlightModalOpen(false)}
        onSearch={handleHighlightSearch}
      />
    </div>
  );
}

export default App;
