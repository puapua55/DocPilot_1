import { useState } from 'react';
import { sendChatMessage } from '../services/llmService';
import { INITIAL_CHAT_MESSAGES } from '../utils/constants';

export function useChat(documentFile) {
  const [messages, setMessages] = useState(INITIAL_CHAT_MESSAGES);

  const handleSendMessage = async (message) => {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: trimmed
    };

    setMessages((current) => [...current, userMessage]);

    const reply = await sendChatMessage(trimmed, {
      documentName: documentFile?.name ?? ''
    });

    setMessages((current) => [
      ...current,
      {
        id: `assistant-${Date.now() + 1}`,
        role: 'assistant',
        text: reply
      }
    ]);
  };

  return {
    messages,
    handleSendMessage
  };
}
