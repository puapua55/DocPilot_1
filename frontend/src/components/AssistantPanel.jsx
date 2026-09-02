import AiActionCard from './AiActionCard';
import ChatInput from './ChatInput';
import './ChatPanel.css';

const CARDS = [
  { title: '정확한 문서 검색', description: '현재 문서에서 원하는 단어나 문장을 정확하게 찾습니다.' },
  { title: '위치 하이라이트', description: '검색어가 있는 위치를 현재 문서에서 바로 강조 표시합니다.' },
  { title: '즉시 텍스트 교체', description: '현재 문서의 텍스트를 찾아 즉시 교체하거나 변환합니다.' }
];

function AssistantPanel({
  messages, loading, error, selectedDocument, runningActionId, onSendMessage,
  onSearchCardClick, onHighlightCardClick, onReplaceCardClick,
  onExecuteSearchAction, onExecuteHighlightAction,
  onExecuteReplaceApplyAction, onExecuteReplaceConvertAction
}) {
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
          <h2>DocPilot AI</h2>
          <p>{documentName ? `${documentName} 문서가 열려 있습니다. 일반 질문부터 시작할 수 있습니다.` : '문서를 선택하거나 일반 질문을 입력하세요.'}</p>
        </div>
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
        <ChatInput onSendMessage={onSendMessage} loading={loading} />
      </section>
      <section className="document-tool-section">
        <div className="document-tool-header"><h3>문서 작업</h3><p>현재 열린 문서에 빠르게 기능을 적용합니다.</p></div>
        <div className="assistant-grid">
          {CARDS.map((card, index) => <div key={card.title} {...getCardActionProps(index)}><h3>{card.title}</h3><p>{card.description}</p></div>)}
        </div>
      </section>
    </aside>
  );
}

export default AssistantPanel;
