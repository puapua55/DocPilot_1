export async function sendChatMessage(message, context = {}) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message,
      documentName: context.documentName || '',
      documentType: context.documentType || '',
      documentText: context.documentText || '',
      history: Array.isArray(context.history) ? context.history : []
    })
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.message || 'AI 응답 요청에 실패했습니다.');
  }

  return data?.answer || '응답을 받지 못했습니다.';
}
