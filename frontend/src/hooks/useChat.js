import { useState } from 'react';
import { sendChatMessage } from '../services/llmService';
import { INITIAL_CHAT_MESSAGES } from '../utils/constants';

const RESTRICTED_CHAT_MESSAGE = '채팅은 정확한 문서 검색, 위치 하이라이트, 즉시 텍스트 교체 요청에만 사용할 수 있습니다.';
const ALLOWED_ACTION_TYPES = new Set(['search', 'highlight', 'replace']);

export function useChat(selectedDocument, previewModel, documentViewerRef) {
  const [messages, setMessages] = useState(INITIAL_CHAT_MESSAGES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const appendAssistantMessage = (text, extra = {}) => {
    setMessages((current) => [
      ...current,
      { id: `assistant-action-${Date.now()}-${Math.random()}`, role: 'assistant', text, ...extra }
    ]);
  };

  const handleSendMessage = async (message) => {
    const trimmed = message.trim();
    if (!trimmed || loading) return;

    const userMessage = { id: `user-${Date.now()}`, role: 'user', text: trimmed };
    if (!selectedDocument?.file) {
      setMessages((current) => [...current, userMessage, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: '문서를 먼저 선택한 뒤 정확한 문서 검색, 위치 하이라이트 또는 즉시 텍스트 교체를 요청해주세요.',
        intent: 'unsupported',
        action: null
      }]);
      return;
    }
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setLoading(true);
    setError('');

    try {
      let documentText = '';
      try {
        documentText = await documentViewerRef?.current?.getDocumentText?.() || '';
      } catch (extractionError) {
        console.warn('[useChat] document text extraction failed:', extractionError);
      }

      const documentName = selectedDocument?.file?.name ?? selectedDocument?.name ?? '';
      const documentType = previewModel?.type ?? '';
      console.log('[AssistantPanel] chat request:', { documentName, documentType, documentTextLength: documentText.length });

      const reply = await sendChatMessage(trimmed, {
        documentName,
        documentType,
        documentText,
        history: nextMessages.slice(-10).map(({ role, text }) => ({ role, content: text }))
      });

      const documentAction = ALLOWED_ACTION_TYPES.has(reply.action?.type);
      const action = documentAction ? reply.action : null;
      const text = documentAction ? reply.answer : RESTRICTED_CHAT_MESSAGE;

      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text,
          intent: reply.intent,
          action
        }
      ]);
    } catch (chatError) {
      console.error('[useChat] chat failed:', chatError);
      setError(chatError?.message || 'AI 응답을 가져오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return { messages, loading, error, handleSendMessage, appendAssistantMessage };
}
