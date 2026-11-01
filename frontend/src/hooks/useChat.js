import { useState } from 'react';
import { sendChatMessage } from '../services/llmService';
import { INITIAL_CHAT_MESSAGES } from '../utils/constants';

const RESTRICTED_CHAT_MESSAGE = '채팅은 문서 검색, 하이라이트, 텍스트 변경, 보기·이력 명령을 지원합니다.';
const ALLOWED_ACTION_TYPES = new Set(['search', 'highlight', 'batch-replace', 'undo', 'redo', 'reset', 'viewer-command']);

export function useChat(selectedDocument, previewModel, documentViewerRef, isEditMode = false, isAiEnabled = true) {
  const [messages, setMessages] = useState(INITIAL_CHAT_MESSAGES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const appendAssistantMessage = (text, extra = {}) => {
    setMessages((current) => [
      ...current,
      { id: `assistant-action-${Date.now()}-${Math.random()}`, role: 'assistant', text, ...extra }
    ]);
  };

  const appendUserMessage = (text) => {
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}-${Math.random()}`, role: 'user', text: String(text) }
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
        text: '문서를 먼저 선택한 뒤 검색, 하이라이트, 텍스트 변경 또는 보기·이력 명령을 요청해주세요.',
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
        history: nextMessages.slice(-10).map(({ role, text }) => ({ role, content: text })),
        aiEnabled: isAiEnabled
      });

      // Older AI responses may still call this action "replace". A request
      // such as "A를 B로 바꿔줘" must always enter the reviewable batch
      // workflow, never perform an immediate one-off replacement.
      const normalizedAction = reply.action?.type === 'replace'
        ? { ...reply.action, type: 'batch-replace' }
        : reply.action
          ? { ...reply.action, requestText: trimmed }
          : reply.action;
      const documentAction = ALLOWED_ACTION_TYPES.has(normalizedAction?.type);
      const needsEditMode = normalizedAction?.type === 'batch-replace';
      const action = documentAction && (!needsEditMode || isEditMode) ? normalizedAction : null;
      const text = documentAction && needsEditMode && !isEditMode
        ? '편집모드를 활성화 해주세요'
        : documentAction && normalizedAction?.type === 'batch-replace'
          ? '텍스트 변경 요청을 확인했습니다. 검색 결과를 확인합니다.'
          : documentAction ? reply.answer
            : !isAiEnabled || reply.answer === '지원되지 않는 기능입니다.' ? reply.answer
              : RESTRICTED_CHAT_MESSAGE;

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

  return { messages, loading, error, handleSendMessage, appendAssistantMessage, appendUserMessage };
}
