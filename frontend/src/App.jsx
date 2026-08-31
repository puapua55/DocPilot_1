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
    setModifiedDocxHtml('');
    clearSelectedDocument();
  };

  const handleDocxSearch = (keyword) => {
    if (previewModel?.type !== 'word') {
      return [];
    }

    return documentViewerRef.current?.searchDocument?.(keyword) ?? [];
  };

  const handleSearchResultClick = (result) => {
    console.log('[SearchResult] clicked:', result);

    if (result?.type === 'docx') {
      documentViewerRef.current?.scrollToSearchResult?.(result.index);
      setSelectedSearchResult({
        ...result,
        clickedAt: Date.now()
      });
      setIsSearchModalOpen(false);
      return;
    }

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

    if (previewModel?.type === 'word') {
      const matchCount = documentViewerRef.current?.highlightText?.(keyword) ?? 0;

      setHighlightKeyword('');
      setHighlightStatusMessage(
        matchCount === 0
          ? '검색 결과가 없습니다.'
          : `${matchCount}개의 DOCX 검색 결과를 표시했습니다.`
      );

      return {
        ok: true,
        closeModal: true
      };
    }

    if (previewModel?.type !== 'pdf') {
      return {
        ok: false,
        message: '지원하는 문서 형식이 아닙니다.'
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

  const handleDocxReplace = (originalText, newText) => {
    if (previewModel?.type !== 'word') {
      return {
        replaceCount: 0,
        html: ''
      };
    }

    const replaceCount = documentViewerRef.current?.replaceText?.(originalText, newText) ?? 0;
    const html = documentViewerRef.current?.getModifiedHtml?.() ?? '';
    setModifiedDocxHtml(html);
    setHighlightStatusMessage(
      replaceCount > 0
        ? `DOCX 텍스트 치환 ${replaceCount}건`
        : '교체할 텍스트를 찾을 수 없습니다.'
    );

    return {
      replaceCount,
      html
    };
  };

  const appContent = (
    <div className="app-page">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <div className="app-shell">
        <main className="main-layout">
          <DocumentWorkspace
            ref={documentViewerRef}
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
          previewModel={previewModel}
          onDocxSearch={handleDocxSearch}
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
        onDocxReplace={handleDocxReplace}
        onApplyPreview={setReplacePreview}
        onClose={() => setIsReplaceModalOpen(false)}
      />
    </div>
  );

  return <AppErrorBoundary>{appContent}</AppErrorBoundary>;
}

export default App;
