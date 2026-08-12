import ChatInput from './ChatInput';

const CARDS = [
  {
    title: '정확한 문서 검색',
    description: '문서 전체에서 원하는 단어나 문장을 빠르게 찾을 수 있도록 준비 중입니다.'
  },
  {
    title: '위치 하이라이트',
    description: '검색 결과 위치를 문서에서 바로 강조 표시하는 흐름을 다음 단계에서 연결합니다.'
  },
  {
    title: '즉시 텍스트 교체',
    description: '선택한 내용을 바꾸고 저장하는 편집 기능은 추후 단계에서 구현 예정입니다.'
  }
];

function AssistantPanel({ messages, onSendMessage, onSearchCardClick, onHighlightCardClick }) {
  const getCardActionProps = (index) => {
    if (index === 0) {
      return {
        className: 'feature-card feature-card-actionable',
        onClick: onSearchCardClick,
        role: 'button',
        tabIndex: 0,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSearchCardClick?.();
          }
        }
      };
    }

    if (index === 1) {
      return {
        className: 'feature-card feature-card-actionable',
        onClick: onHighlightCardClick,
        role: 'button',
        tabIndex: 0,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onHighlightCardClick?.();
          }
        }
      };
    }

    return {
      className: 'feature-card'
    };
  };

  return (
    <aside className="panel assistant-panel">
      <div className="assistant-head">
        <h2>문서 관리 AI 어시스턴트</h2>
        <p>문서를 이해하고, 필요한 정보를 정확히 찾아 즉시 편집까지 도와드립니다.</p>
      </div>

      <div className="assistant-grid">
        {CARDS.map((card, index) => (
          <div
            key={card.title}
            {...getCardActionProps(index)}
          >
            <h3>{card.title}</h3>
            <p>{card.description}</p>
          </div>
        ))}
      </div>

      <div className="chat-feed" aria-label="assistant conversation">
        {messages.map((message) => (
          <div key={message.id} className={`chat-row ${message.role === 'user' ? 'user' : 'assistant'}`}>
            <div className="chat-bubble">{message.text}</div>
          </div>
        ))}
      </div>

      <ChatInput onSendMessage={onSendMessage} />
    </aside>
  );
}

export default AssistantPanel;
