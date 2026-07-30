export const APP_COPY = {
  title: 'DocPilot',
  subtitle: '문서 관리 AI 어시스턴트'
};

export const ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx'];
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

export const INITIAL_CHAT_MESSAGES = [
  {
    id: 'welcome-ai',
    role: 'assistant',
    text: '안녕하세요! 문서 검색, 요약, 수정 흐름을 준비하고 있습니다. 원하는 작업을 입력해 주세요.'
  },
  {
    id: 'sample-user',
    role: 'user',
    text: '프로젝트 일정이라는 내용을 찾아줘'
  },
  {
    id: 'sample-ai',
    role: 'assistant',
    text: '현재 AI 연동은 준비 중입니다. 다음 단계에서 실제 검색 결과와 연결할 예정입니다.'
  }
];

export const FEATURE_MESSAGES = {
  search: '정확한 문서 검색 기능은 다음 단계에서 구현 예정입니다.',
  highlight: '위치 하이라이트 기능은 다음 단계에서 구현 예정입니다.',
  replace: '즉시 텍스트 교체 기능은 다음 단계에서 구현 예정입니다.'
};

export const DOCUMENT_LABELS = {
  emptyTitle: '문서 미리보기 영역',
  emptyDescription: '문서를 선택하면 이 영역에 PDF 기본 미리보기 또는 Word 안내 화면이 표시됩니다.',
  emptyNote: 'PDF.js textLayer, 글자 선택, 글씨체/선택영역 보정 로직은 이번 단계에서 제외했습니다.'
};
