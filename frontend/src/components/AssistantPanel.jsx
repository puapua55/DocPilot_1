import AiActionCard from './AiActionCard';
import ChatInput from './ChatInput';
import GeminiSettingsModal from './GeminiSettingsModal';
import './ChatPanel.css';
import { useEffect, useState } from 'react';

const CARDS = [
  { title: '정확한 문서 검색' },
  { title: '위치 하이라이트' },
  { title: '즉시 텍스트 교체' }
];

function AssistantPanel({
  messages, loading, error, selectedDocument, runningActionId, onSendMessage,
  onSearchCardClick, onHighlightCardClick, onReplaceCardClick,
  onExecuteSearchAction, onExecuteHighlightAction,
  onExecuteReplaceApplyAction, onExecuteReplaceConvertAction
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [geminiStatus, setGeminiStatus] = useState(null);
  const settingsApi = typeof window !== 'undefined' ? window.docPilotSettings : null;

  useEffect(() => {
    if (!settingsApi?.getGeminiStatus) return;
    settingsApi.getGeminiStatus().then(setGeminiStatus).catch(() => setGeminiStatus(null));
  }, [settingsApi]);

  const getCardActionProps = (index) => {
    const handler = [onSearchCardClick, onHighlightCardClick, onReplaceCardClick][index];
    return {
      className: 'feature-card feature-card-actionable', onClick: handler, role: 'button', tabIndex: 0,
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handler?.(); }
      }
    };
  };

  const selectedFile = selectedDocument?.file ?? null;
  const documentName = selectedFile?.name ?? selectedDocument?.name ?? '';

  return (
    <aside className="panel assistant-panel">
      <section className="ai-chat-section">
        <div className="assistant-head">
          <div className="assistant-head-row">
            <h2>DocPilot AI</h2>
            <button className="gemini-settings-button" type="button" onClick={() => setSettingsOpen(true)}>Gemini 설정</button>
          </div>
          <p>{documentName ? `${documentName} 문서가 열려 있습니다. 문서 작업 요청만 입력할 수 있습니다.` : '문서를 선택한 뒤 문서 작업 요청을 입력하세요.'}</p>
        </div>
        {settingsApi && geminiStatus && !geminiStatus.hasApiKey ? (
          <div className="gemini-missing-banner" role="status">
            <span>Gemini API Key가 설정되지 않았습니다.</span>
            <button type="button" onClick={() => setSettingsOpen(true)}>설정하기</button>
          </div>
        ) : null}
        <section className="document-tool-section">
          <div className="document-tool-header"><h3>문서 작업</h3><p>현재 열린 문서에 빠르게 기능을 적용합니다.</p></div>
          <div className="assistant-grid">
            {CARDS.map((card, index) => <div key={card.title} {...getCardActionProps(index)}><h3>{card.title}</h3></div>)}
          </div>
        </section>
        <div className="chat-feed" aria-label="assistant conversation" aria-live="polite">
          {messages.map((message) => {
            const runningType = runningActionId?.startsWith(`${message.id}:`) ? runningActionId.slice(message.id.length + 1) : '';
            return (
              <div key={message.id} className={`chat-row ${message.role === 'user' ? 'user' : 'assistant'}`}>
                <div className="chat-bubble">
                  {message.text}
                  {message.role === 'assistant' && message.action ? (
                    <AiActionCard
                      action={message.action}
                      selectedFile={selectedFile}
                      disabled={!selectedFile}
                      runningType={runningType}
                      onSearch={(action) => onExecuteSearchAction?.(message.id, action)}
                      onHighlight={(action) => onExecuteHighlightAction?.(message.id, action)}
                      onReplaceApply={(action) => onExecuteReplaceApplyAction?.(message.id, action)}
                      onReplaceConvert={(action) => onExecuteReplaceConvertAction?.(message.id, action)}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
          {loading ? <div className="chat-row assistant"><div className="chat-bubble chat-loading">답변을 작성 중입니다...</div></div> : null}
        </div>
        {error ? <div className="chat-error" role="alert">{error}</div> : null}
        <ChatInput onSendMessage={onSendMessage} loading={loading} disabled={!selectedFile} />
      </section>
      <GeminiSettingsModal
        isOpen={settingsOpen}
        status={geminiStatus}
        onSaved={setGeminiStatus}
        onClose={() => setSettingsOpen(false)}
      />
    </aside>
  );
}

export default AssistantPanel;
