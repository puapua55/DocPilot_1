import { inferDocumentCommand } from '../../electron/documentCommandParser.js';

const OFFLINE_UNSUPPORTED_MESSAGE = '이 요청은 오프라인 모드에서 지원하지 않습니다.\n\n오프라인 채팅에서 가능한 작업:\n• 문서 내 문구 검색 (예: 문서를 찾아줘)\n• 문구 하이라이트 (예: 문서를 하이라이트 표시, 2페이지 문서를 노란색으로 하이라이트해줘)\n• 텍스트 일괄 변경 (예: PDF를 TXT로 바꿔줘, 편집 모드 필요)\n• 보기 모드 변경, 페이지 이동, 확대·축소, PDF 화면 맞춤\n• PDF 다운로드, DOCX 문서의 DOCX 저장 (PDF를 DOCX로 저장할 수 없음)\n• 실행 취소, 다시 실행, 전체 초기화\n\n대상 선택이나 파일 첨부가 필요한 편집 작업은 화면에서 먼저 대상을 선택해주세요.';

export async function sendChatMessage(message, context = {}) {
  const payload = {
    message,
    documentName: context.documentName || '',
    documentType: context.documentType || '',
    documentText: context.documentText || '',
    history: Array.isArray(context.history) ? context.history : []
  };
  const localCommand = inferDocumentCommand(message);
  const operations = localCommand?.action?.type === 'viewer-command' ? localCommand.action.operations || [] : [];
  if ((context.documentType === 'word' && operations.some((operation) => operation.command === 'fit'))
    || (context.documentType === 'pdf' && operations.some((operation) => operation.command === 'download' && operation.format === 'docx'))) {
    return { answer: '지원되지 않는 기능입니다.', intent: 'unsupported', action: null };
  }
  if (['undo', 'redo', 'reset', 'viewer-command'].includes(localCommand?.action?.type)) return localCommand;
  if (context.aiEnabled === false) {
    return localCommand || {
      answer: OFFLINE_UNSUPPORTED_MESSAGE,
      intent: 'unsupported',
      action: null
    };
  }
  if (typeof window !== 'undefined' && window.docPilotAi?.chat) {
    return window.docPilotAi.chat(payload);
  }

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 503 && data?.message?.includes('GEMINI_API_KEY')) {
      const isElectron = typeof window !== 'undefined' && Boolean(window.docPilotSettings);
      throw new Error(isElectron
        ? 'Gemini API Key가 설정되지 않았습니다. 우측 상단 Gemini 설정에서 API Key를 입력해주세요.'
        : 'Gemini API Key가 설정되지 않았습니다. 백엔드 환경변수 GEMINI_API_KEY를 설정해주세요.');
    }
    throw new Error(data?.message || 'AI 응답 요청에 실패했습니다.');
  }

  return {
    answer: data?.answer || '응답을 받지 못했습니다.',
    intent: data?.intent || 'question_answer',
    action: data?.action || null
  };
}
