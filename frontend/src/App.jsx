import Header from './components/Header';
import AssistantPanel from './components/AssistantPanel';
import DocumentWorkspace from './components/DocumentWorkspace';
import { useChat } from './hooks/useChat';
import { useDocument } from './hooks/useDocument';

function App() {
  const {
    selectedDocument,
    previewModel,
    errorMessage,
    statusMessage,
    handleDocumentSelect,
    handleFeatureClick
  } = useDocument();
  const { messages, handleSendMessage } = useChat(selectedDocument);

  return (
    <div className="app-page">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <div className="app-shell">
        <Header />
        <main className="main-layout">
          <DocumentWorkspace
            selectedDocument={selectedDocument}
            previewModel={previewModel}
            errorMessage={errorMessage}
            statusMessage={statusMessage}
            onDocumentSelect={handleDocumentSelect}
            onFeatureClick={handleFeatureClick}
          />
          <AssistantPanel messages={messages} onSendMessage={handleSendMessage} />
        </main>
      </div>
    </div>
  );
}

export default App;
