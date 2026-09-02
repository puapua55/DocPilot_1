import { useState } from 'react';
import { sendChatMessage } from '../services/llmService';
import { INITIAL_CHAT_MESSAGES } from '../utils/constants';

export function useChat(selectedDocument, previewModel, documentText = '') {
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
      const reply = await sendChatMessage(trimmed, {
        documentName: selectedDocument?.file?.name ?? selectedDocument?.name ?? '',
        documentType: previewModel?.type ?? '',
        documentText: String(documentText || '').slice(0, 30000),
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
