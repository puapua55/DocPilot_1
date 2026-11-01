import AiActionCard from './AiActionCard';
import ChatInput from './ChatInput';
import GeminiSettingsModal from './GeminiSettingsModal';
import './ChatPanel.css';
import { useEffect, useRef, useState } from 'react';

const CARDS = [
  { title: '정확한 문서 검색' },
  { title: '위치 하이라이트' },
  { title: '텍스트 일괄 변경' }
];

function formatSearchLocation(result) {
  const page = Number(result?.pageNumber ?? result?.page ?? result?.pageIndex);
  const line = Number(result?.lineNumber ?? result?.line ?? result?.lineIndex);
  return {
    page: Number.isFinite(page) && page > 0 ? `${page}페이지` : '-',
    line: Number.isFinite(line) && line > 0 ? `줄 ${line}` : '-'
  };
}

function getSearchResultText(result) {
  return String(
    result?.matchedText
    ?? result?.originalText
    ?? result?.matchText
    ?? result?.text
    ?? result?.context
    ?? result?.word
    ?? ''
  ).trim() || '-';
}

function ChatSearchResults({ results, keyword, hasMoreResults, onResultClick }) {
  if (!Array.isArray(results) || results.length === 0) return null;

  return (
    <div className="chat-search-results" aria-label="AI 문서 검색 결과">
      <div className="chat-search-table-wrap">
        <table className="chat-search-table chat-search-table--search">
          <colgroup><col /><col /><col /><col /></colgroup>
          <thead>
            <tr><th>페이지</th><th>위치</th><th>내용</th><th>검색어</th></tr>
          </thead>
          <tbody>
            {results.map((result, index) => {
              const location = formatSearchLocation(result);
              return (
                <tr
                  key={result?.id || `${location.page}-${location.line}-${index}`}
                  data-search-result-trigger="true"
                  className="chat-search-result-row"
                  onClick={() => onResultClick?.(result)}
                >
                  <td>{location.page}</td>
                  <td>{location.line}</td>
                  <td className="chat-search-result-text" title={getSearchResultText(result)}>{getSearchResultText(result)}</td>
                  <td title={String(result?.keyword || keyword || '-')}>{String(result?.keyword || keyword || '-')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMoreResults ? <p className="chat-search-more">나머지 결과는 정확한 문서 검색에서 확인할 수 있습니다.</p> : null}
    </div>
  );
}

function ChatBatchReplaceResults({ results, replacementText, onResultClick }) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return (
    <div className="chat-search-results chat-batch-replace-results" aria-label="텍스트 변경 검색 결과">
      <div className="chat-search-table-wrap">
        <table className="chat-search-table chat-search-table--replace">
          <colgroup><col /><col /><col /><col /><col /></colgroup>
          <thead><tr><th>번호</th><th>페이지</th><th>위치</th><th>찾는 텍스트</th><th>변경할 텍스트</th></tr></thead>
          <tbody>
            {results.map((result, index) => {
              const location = formatSearchLocation(result);
              const foundText = getSearchResultText(result);
              const nextText = String(replacementText || '');
              return (
                <tr
                  key={result?.id || `batch-chat-result-${index}`}
                  data-search-result-trigger="true"
                  className="chat-search-result-row"
                  onClick={() => onResultClick?.(result)}
                >
                  <td>{index + 1}</td>
                  <td>{location.page}</td>
                  <td>{location.line}</td>
                  <td title={foundText}>{foundText}</td>
                  <td title={nextText}>{nextText}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AssistantPanel({
  messages, loading, error, selectedDocument, runningActionId, onSendMessage,
  isAiEnabled = true, onAiEnabledChange,
  isEditMode = false,
  isPdfEditRestricted = false,
  onSearchCardClick, onHighlightCardClick, onBatchReplaceCardClick,
  onSearchResultClick, onSuggestionAnswer, activeSuggestionId, activeSearchOrderId, onSearchOrderAnswer,
  onExecuteSearchAction, onExecuteHighlightAction, onExecuteBatchReplaceAction, onExecuteDocumentHistoryAction
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [geminiStatus, setGeminiStatus] = useState(null);
  const autoSearchIdsRef = useRef(new Set());
  const autoBatchIdsRef = useRef(new Set());
  const autoHistoryIdsRef = useRef(new Set());
  const chatFeedRef = useRef(null);
  const settingsApi = typeof window !== 'undefined' ? window.docPilotSettings : null;

  useEffect(() => {
    if (!settingsApi?.getGeminiStatus) return;
    settingsApi.getGeminiStatus().then(setGeminiStatus).catch(() => setGeminiStatus(null));
  }, [settingsApi]);

  useEffect(() => {
    messages.forEach((message) => {
      if (message.role !== 'assistant' || message.action?.type !== 'search' || autoSearchIdsRef.current.has(message.id)) return;
      autoSearchIdsRef.current.add(message.id);
      onExecuteSearchAction?.(message.id, message.action);
    });
  }, [messages, onExecuteSearchAction]);

  useEffect(() => {
    messages.forEach((message) => {
      if (message.role !== 'assistant' || message.action?.type !== 'batch-replace' || autoBatchIdsRef.current.has(message.id)) return;
      autoBatchIdsRef.current.add(message.id);
      onExecuteBatchReplaceAction?.(message.id, message.action);
    });
  }, [messages, onExecuteBatchReplaceAction]);

  useEffect(() => {
    messages.forEach((message) => {
      if (message.role !== 'assistant' || !['undo', 'redo', 'reset', 'viewer-command'].includes(message.action?.type) || autoHistoryIdsRef.current.has(message.id)) return;
      autoHistoryIdsRef.current.add(message.id);
      onExecuteDocumentHistoryAction?.(message.id, message.action);
    });
  }, [messages, onExecuteDocumentHistoryAction]);

  useEffect(() => {
    const feed = chatFeedRef.current;
    if (!feed) return;
    requestAnimationFrame(() => {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    });
  }, [messages, loading]);

  const getCardActionProps = (index) => {
    const handler = [onSearchCardClick, onHighlightCardClick, onBatchReplaceCardClick][index];
    const disabled = (index === 1 && isPdfEditRestricted) || (index === 2 && (!isEditMode || isPdfEditRestricted));
    return {
      className: `feature-card feature-card-actionable${disabled ? ' is-disabled' : ''}`,
      onClick: disabled ? undefined : handler, role: 'button', tabIndex: disabled ? -1 : 0,
      'aria-disabled': disabled,
      onKeyDown: (event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); handler?.(); }
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
            <div className="assistant-head-actions">
              <button
                className={`ai-mode-toggle ${isAiEnabled ? 'is-on' : 'is-off'}`}
                type="button"
                aria-pressed={isAiEnabled}
                title={isAiEnabled ? '외부 AI 사용 중' : '완전한 오프라인 명령 처리 중'}
                onClick={() => onAiEnabledChange?.(!isAiEnabled)}
              >
                AI {isAiEnabled ? 'ON' : 'OFF'}
              </button>
              <button className="gemini-settings-button" type="button" onClick={() => setSettingsOpen(true)}>설정</button>
            </div>
          </div>
        </div>
        {isAiEnabled && settingsApi && geminiStatus && !geminiStatus.hasApiKey ? (
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
        <div ref={chatFeedRef} className="chat-feed" aria-label="assistant conversation" aria-live="polite">
          {messages.map((message) => {
            const runningType = runningActionId?.startsWith(`${message.id}:`) ? runningActionId.slice(message.id.length + 1) : '';
            return (
              <div key={message.id} className={`chat-row ${message.role === 'user' ? 'user' : 'assistant'} ${message.role === 'assistant' && (message.searchResults?.length || message.batchReplaceResults?.length) ? 'has-result-table' : ''}`}>
                <div className="chat-bubble">
                  {message.text}
                  {message.role === 'assistant' ? (
                    <ChatSearchResults
                      results={message.searchResults}
                      keyword={message.searchKeyword}
                      hasMoreResults={message.hasMoreSearchResults}
                      onResultClick={onSearchResultClick}
                    />
                  ) : null}
                  {message.role === 'assistant' ? (
                    <ChatBatchReplaceResults
                      results={message.batchReplaceResults}
                      replacementText={message.batchReplacementText}
                      onResultClick={onSearchResultClick}
                    />
                  ) : null}
                  {message.role === 'assistant' && activeSuggestionId === message.id ? (
                    <div className="chat-similar-choice" aria-label="비슷한 텍스트 확인">
                      <button type="button" onClick={() => onSuggestionAnswer?.(message.id, true)} disabled={Boolean(runningActionId)}>맞아요</button>
                      <button type="button" onClick={() => onSuggestionAnswer?.(message.id, false)} disabled={Boolean(runningActionId)}>아니요</button>
                    </div>
                  ) : null}
                  {message.role === 'assistant' && activeSearchOrderId === message.id ? (
                    <div className="chat-similar-choice" aria-label="검색 방향 선택">
                      <button type="button" onClick={() => onSearchOrderAnswer?.(message.id, 'first')} disabled={Boolean(runningActionId)}>첫 페이지 기준</button>
                      <button type="button" onClick={() => onSearchOrderAnswer?.(message.id, 'last')} disabled={Boolean(runningActionId)}>끝 페이지 기준</button>
                    </div>
                  ) : null}
                  {message.role === 'assistant' && message.action && !['search', 'batch-replace', 'undo', 'redo', 'reset', 'viewer-command'].includes(message.action.type) ? (
                    <AiActionCard
                      action={message.action}
                      selectedFile={selectedFile}
                      disabled={!selectedFile || (isPdfEditRestricted && ['highlight', 'batch-replace'].includes(message.action.type)) || (message.action.type === 'batch-replace' && !isEditMode)}
                      runningType={runningType}
                      onSearch={(action) => onExecuteSearchAction?.(message.id, action)}
                      onHighlight={(action) => onExecuteHighlightAction?.(message.id, action)}
                      onBatchReplace={(action) => onExecuteBatchReplaceAction?.(message.id, action)}
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
