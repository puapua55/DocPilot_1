import { useState } from 'react';
import { sendChatMessage } from '../services/llmService';
import { INITIAL_CHAT_MESSAGES } from '../utils/constants';

export function useChat(selectedDocument, previewModel, documentViewerRef) {
  const [messages, setMessages] = useState(INITIAL_CHAT_MESSAGES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSendMessage = async (message) => {
    const trimmed = message.trim();
    if (!trimmed || loading) {
      return;
    }

    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: trimmed
    };

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

      console.log('[AssistantPanel] chat request:', {
        documentName,
        documentType,
        documentTextLength: documentText.length
      });

      const reply = await sendChatMessage(trimmed, {
        documentName,
        documentType,
        documentText,
        history: nextMessages.slice(-10).map(({ role, text }) => ({
          role,
          content: text
        }))
      });

      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: reply
        }
      ]);
    } catch (chatError) {
      console.error('[useChat] chat failed:', chatError);
      setError(chatError?.message || 'AI 응답을 가져오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return {
    messages,
    loading,
    error,
    handleSendMessage
  };
}
