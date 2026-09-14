export async function sendChatMessage(message, context = {}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://localhost:8080' : '';
  const response = await fetch(`${apiBase}/api/chat`, {
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
    if (response.status === 503 && data?.message?.includes('OPENAI_API_KEY')) {
      const isElectron = typeof window !== 'undefined' && Boolean(window.docPilotSettings);
      throw new Error(isElectron
        ? 'OpenAI API Key가 설정되지 않았습니다. 우측 상단 OpenAI 설정에서 API Key를 입력한 뒤 앱을 다시 시작해주세요.'
        : 'OpenAI API Key가 설정되지 않았습니다. 백엔드 환경변수 OPENAI_API_KEY를 설정해주세요.');
    }
    throw new Error(data?.message || 'AI 응답 요청에 실패했습니다.');
  }

  return {
    answer: data?.answer || '응답을 받지 못했습니다.',
    intent: data?.intent || 'question_answer',
    action: data?.action || null
  };
}
