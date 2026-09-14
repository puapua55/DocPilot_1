const DEFAULT_MODEL = 'gpt-5-mini';
const MAX_HISTORY = 10;
const MAX_DOCUMENT_TEXT = 20_000;
const DOCUMENT_EDGE_LENGTH = MAX_DOCUMENT_TEXT / 2;
const INTENTS = new Set(['summarize', 'question_answer', 'search', 'highlight', 'replace', 'unsupported']);

const DOCUMENT_ASSISTANT_INSTRUCTIONS = `너는 DocPilot의 문서 작업 보조 AI다. 사용자가 문서를 선택한 경우 제공된 문서 텍스트를 최우선 근거로 답변한다.
제공된 문서 내용에 없는 정보는 추측하지 말고 '제공된 문서에서는 확인되지 않습니다'라고 답한다.
사용자 요청을 summarize, question_answer, search, highlight, replace, unsupported 중 정확히 하나로 분류한다.
요약은 summarize, 문서 내용 질문은 question_answer다. 검색 요청은 search이며 keyword를 추출한다.
하이라이트/표시 요청은 highlight이며 keyword를 추출한다. 텍스트 치환 요청은 replace이며 originalText와 newText를 추출한다.
search/highlight/replace 작업을 직접 실행했다고 절대 말하지 않는다. 실행 가능한 작업을 준비했다고 설명하고 반드시 사용자 승인 버튼을 눌러야 실행된다고 안내한다.
페이지 번호가 문서 텍스트에 있으면 가능한 경우 답변에 언급하고, 없으면 페이지를 추측하지 않는다.
지원하지 않는 문서 자동 편집 요청은 unsupported로 분류한다.
응답은 JSON 객체만 출력한다. 형식은 {"answer":"...","intent":"...","action":null}이다.
search action은 {"type":"search","keyword":"..."}, highlight action은 {"type":"highlight","keyword":"..."}, replace action은 {"type":"replace","originalText":"...","newText":"..."} 형식이다.
summarize/question_answer/unsupported의 action은 null이다. JSON 외 설명이나 Markdown 코드 블록을 출력하지 않는다.
문서 텍스트가 제공되지 않은 경우 일반 질문과 DocPilot 사용 질문에는 답할 수 있지만 문서 작업을 실행했다고 말하지 않는다.`;

function limitDocumentText(text) {
  if (!text || text.trim() === '') return { text: '', truncated: false };
  if (text.length <= MAX_DOCUMENT_TEXT) return { text, truncated: false };
  return {
    text: `${text.slice(0, DOCUMENT_EDGE_LENGTH)}\n\n[... 문서 중간 내용 생략 ...]\n\n${text.slice(-DOCUMENT_EDGE_LENGTH)}`,
    truncated: true
  };
}

function safePromptValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '없음';
}

function buildDocumentContext(request, limitedDocument) {
  let context = `아래는 현재 DocPilot에서 열린 문서의 컨텍스트다.\n문서명: ${safePromptValue(request.documentName)}\n문서 유형: ${safePromptValue(request.documentType)}\n`;
  if (!limitedDocument.text) return `${context}문서 내용: 현재 선택된 문서 내용은 전달되지 않았습니다.`;
  context += `문서 내용:\n${limitedDocument.text}`;
  context += limitedDocument.truncated
    ? '\n\n[알림: 문서가 길어 앞부분과 뒷부분만 제공되었습니다. 전체 문서를 본 것처럼 단정하지 말고 제공된 일부 내용 기준으로만 답변하세요.]'
    : '\n\n[알림: 답변은 위에 제공된 문서 내용만 근거로 작성하세요.]';
  return context.trim();
}

function parseChatResult(rawText) {
  const raw = String(rawText || '').trim();
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    const intent = INTENTS.has(parsed.intent) ? parsed.intent : 'unsupported';
    let action = null;
    if (['search', 'highlight'].includes(intent) && parsed.action?.type === intent && typeof parsed.action.keyword === 'string' && parsed.action.keyword.trim()) {
      action = { type: intent, keyword: parsed.action.keyword.trim() };
    } else if (intent === 'replace' && parsed.action?.type === intent && typeof parsed.action.originalText === 'string' && parsed.action.originalText.trim() && typeof parsed.action.newText === 'string' && parsed.action.newText.length > 0) {
      action = { type: intent, originalText: parsed.action.originalText.trim(), newText: parsed.action.newText };
    }
    return { answer: String(parsed.answer || '').trim() || raw, intent, action };
  } catch {
    return { answer: raw, intent: 'question_answer', action: null };
  }
}

function extractOutputText(response) {
  return (response?.output || []).flatMap((item) => item?.content || [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text.trim()).filter(Boolean).join('\n').trim();
}

export function missingApiKeyResult() {
  return { answer: 'OpenAI API Key가 설정되어 있지 않습니다. OpenAI 설정에서 API Key를 입력해주세요.', intent: 'unsupported', action: null };
}

export async function chatWithOpenAi(request = {}, settings = {}) {
  const apiKey = String(process.env.OPENAI_API_KEY || settings.openAiApiKey || '').trim();
  if (!apiKey) return missingApiKeyResult();
  const model = String(process.env.OPENAI_MODEL || settings.openAiModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const limitedDocument = limitDocumentText(String(request.documentText || ''));
  const input = [{ role: 'developer', content: DOCUMENT_ASSISTANT_INSTRUCTIONS }, { role: 'developer', content: buildDocumentContext(request, limitedDocument) }];
  const history = Array.isArray(request.history) ? request.history.slice(-MAX_HISTORY) : [];
  for (const item of history) {
    if (item?.content?.trim()) input.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content.trim() });
  }
  if (!input.some((item) => item.role === 'user')) input.push({ role: 'user', content: String(request.message || '').trim() });

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, store: false, input })
    });
  } catch (error) {
    throw new Error('OpenAI 서버와 통신하지 못했습니다. 네트워크 또는 OpenAI 서버 상태를 확인해주세요.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error?.code;
    const suffix = code ? ` (${code})` : '';
    throw new Error(`OpenAI 요청에 실패했습니다${suffix}. OpenAI 설정과 사용량 상태를 확인해주세요.`);
  }
  const answer = extractOutputText(body);
  if (!answer) throw new Error('OpenAI 응답에서 텍스트를 찾지 못했습니다.');
  return parseChatResult(answer);
}

export { buildDocumentContext, limitDocumentText, parseChatResult };
