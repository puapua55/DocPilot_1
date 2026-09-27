const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MAX_HISTORY = 10;
const MAX_DOCUMENT_TEXT = 20_000;
const DOCUMENT_EDGE_LENGTH = MAX_DOCUMENT_TEXT / 2;
const ALLOWED_ACTION_TYPES = new Set(['search', 'highlight', 'replace', 'batch-replace']);
const RESTRICTED_CHAT_MESSAGE = '채팅은 정확한 문서 검색, 위치 하이라이트, 즉시 텍스트 교체 요청에만 사용할 수 있습니다.';

const DOCUMENT_ASSISTANT_INSTRUCTIONS = `너는 DocPilot의 문서 작업 보조 AI다. 지원하는 요청은 정확한 문서 검색(search), 위치 하이라이트(highlight), 즉시 텍스트 교체(replace)뿐이다.
요약, 문서 질의응답, 일반 대화, 사용법 안내, 그 밖의 모든 요청은 지원하지 않는다.
지원하지 않는 요청에는 intent를 unsupported로, answer를 '${RESTRICTED_CHAT_MESSAGE}'로, action을 null로 설정한다.
검색 요청은 search이며 keyword를 추출한다. 하이라이트/표시 요청은 highlight이며 keyword를 추출한다. 텍스트 치환 요청은 replace이며 originalText와 newText를 추출한다.
search/highlight/replace 작업을 직접 실행했다고 절대 말하지 않는다. 실행 가능한 작업을 준비했다고 설명하고 반드시 사용자 승인 버튼을 눌러야 실행된다고 안내한다.
응답은 JSON 객체만 출력한다. 형식은 {"answer":"...","intent":"search|highlight|replace|unsupported","action":null}이다.
search action은 {"type":"search","keyword":"..."}, highlight action은 {"type":"highlight","keyword":"..."}, replace action은 {"type":"replace","originalText":"...","newText":"..."} 형식이다.
JSON 외 설명이나 Markdown 코드 블록을 출력하지 않는다.`;

// The selectable batch-review modal is mandatory before a text change.
const BATCH_REPLACE_INSTRUCTION = `
텍스트 변경 요청 처리 규칙:
- 사용자가 "ㅁㅁㅁ에서 ㅇㅇㅇ로 바꿔줘", "ㅁㅁㅁ을 ㅇㅇㅇ으로 변경해줘", "ㅁㅁㅁ를 ㅇㅇㅇ로 교체해줘"처럼 찾을 문구와 바꿀 문구를 함께 요청하면 intent와 action.type을 반드시 "batch-replace"로 반환한다.
- action 형식은 {"type":"batch-replace","originalText":"ㅁㅁㅁ","newText":"ㅇㅇㅇ"}이다.
- 실제 변경을 완료했다고 말하지 말고, 사용자가 결과 목록에서 항목을 선택한 뒤 적용할 수 있도록 "텍스트 일괄 변경"을 열었다고 안내한다.
`;

const HIGHLIGHT_TARGET_INSTRUCTION = `
Highlight requests require result-level targeting. First inspect the supplied document text and map each requested word to the search result list.
For a request naming a page and line, return action.targets with one entry per requested result: {"page":2,"line":22,"color":"green"}. For a page ordinal request use occurrence instead, such as {"page":2,"occurrence":1,"color":"yellow"}.
Line is the displayed PDF/DOCX line number. Occurrence is 1-based among matches of the keyword on that page, in document/list order. Supported colors are yellow, green, blue, pink.
If the user explicitly says "전체" (all), return action.all=true and apply the same requested color to all matches. If the user does not say all, never select every match implicitly; return only the requested targets and preserve each target's color.
The highlight action format is {"type":"highlight","keyword":"...","all":false,"targets":[{"page":2,"line":22,"color":"green"}]}.
`;

const BATCH_SCOPE_INSTRUCTION = `
Text replacement requests use the same result targeting rules as highlighting.
If the user specifies a page and line, return action.targets with {"page":2,"line":22} entries. For a page ordinal request use {"page":2,"occurrence":1}.
If the user explicitly says "전체" (all), return action.all=true. If neither page/ordinal nor all is stated, return action.all=false and an empty targets array so the app can show the complete selectable result list before applying.
The batch-replace action format is {"type":"batch-replace","originalText":"...","newText":"...","all":false,"targets":[{"page":2,"occurrence":1}]}.
`;

const NO_APPROVAL_INSTRUCTION = `
Do not tell the user to press an approval button and do not claim that an approval button is required. The app handles searching and applying after the action is received.
`;

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
    ? '\n\n[알림: 문서가 길어 앞부분과 뒷부분만 제공되었습니다. 전체 문서를 본 것처럼 단정하지 마세요.]'
    : '';
  return context.trim();
}

function parseChatResult(rawText) {
  const raw = String(rawText || '').trim();
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    const intent = ALLOWED_ACTION_TYPES.has(parsed.intent) ? parsed.intent : 'unsupported';
    let action = null;
    if (['search', 'highlight'].includes(intent) && parsed.action?.type === intent && typeof parsed.action.keyword === 'string' && parsed.action.keyword.trim()) {
      action = { type: intent, keyword: parsed.action.keyword.trim() };
      if (intent === 'highlight') {
        action.all = parsed.action.all === true;
        action.color = ['yellow', 'green', 'blue', 'pink'].includes(parsed.action.color)
          ? parsed.action.color
          : 'yellow';
        action.targets = Array.isArray(parsed.action.targets)
          ? parsed.action.targets.map((target) => ({
            page: Number(target?.page),
            line: Number(target?.line ?? target?.lineNumber),
            occurrence: Number(target?.occurrence ?? target?.index ?? target?.wordIndex),
            color: ['yellow', 'green', 'blue', 'pink'].includes(target?.color) ? target.color : 'yellow'
          })).filter((target) => Number.isInteger(target.page) && target.page > 0 && ((Number.isInteger(target.line) && target.line > 0) || (Number.isInteger(target.occurrence) && target.occurrence > 0)))
          : [];
      }
    } else if (['replace', 'batch-replace'].includes(intent) && ['replace', 'batch-replace'].includes(parsed.action?.type) && typeof parsed.action.originalText === 'string' && parsed.action.originalText.trim() && typeof parsed.action.newText === 'string' && parsed.action.newText.length > 0) {
      // Replacement requests always use the selectable batch-review modal.
      action = {
        type: 'batch-replace',
        originalText: parsed.action.originalText.trim(),
        newText: parsed.action.newText,
        all: parsed.action.all === true,
        targets: Array.isArray(parsed.action.targets)
          ? parsed.action.targets.map((target) => ({
            page: Number(target?.page),
            line: Number(target?.line ?? target?.lineNumber),
            occurrence: Number(target?.occurrence ?? target?.index ?? target?.wordIndex)
          })).filter((target) => Number.isInteger(target.page) && target.page > 0 && ((Number.isInteger(target.line) && target.line > 0) || (Number.isInteger(target.occurrence) && target.occurrence > 0)))
          : []
      };
    }
    if (!action) return { answer: RESTRICTED_CHAT_MESSAGE, intent: 'unsupported', action: null };
    return { answer: String(parsed.answer || '').trim() || '문서 작업을 준비했습니다. 아래 버튼으로 실행해주세요.', intent, action };
  } catch {
    return { answer: RESTRICTED_CHAT_MESSAGE, intent: 'unsupported', action: null };
  }
}

function extractOutputText(response) {
  return (response?.candidates || []).flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => typeof part?.text === 'string' ? part.text.trim() : '')
    .filter(Boolean).join('\n').trim();
}

export function missingApiKeyResult() {
  return { answer: 'Gemini API Key가 설정되어 있지 않습니다. Gemini 설정에서 API Key를 입력해주세요.', intent: 'unsupported', action: null };
}

export async function chatWithGemini(request = {}, settings = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY || settings.geminiApiKey || '').trim();
  if (!apiKey) return missingApiKeyResult();
  const model = String(process.env.GEMINI_MODEL || settings.geminiModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const limitedDocument = limitDocumentText(String(request.documentText || ''));
  const contents = [];
  const history = Array.isArray(request.history) ? request.history.slice(-MAX_HISTORY) : [];
  for (const item of history) {
    if (!item?.content?.trim()) continue;
    contents.push({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content.trim() }] });
  }
  if (!contents.some((item) => item.role === 'user')) {
    contents.push({ role: 'user', parts: [{ text: String(request.message || '').trim() }] });
  }

  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${DOCUMENT_ASSISTANT_INSTRUCTIONS}\n${BATCH_REPLACE_INSTRUCTION}\n${HIGHLIGHT_TARGET_INSTRUCTION}\n${BATCH_SCOPE_INSTRUCTION}\n${NO_APPROVAL_INSTRUCTION}\n${buildDocumentContext(request, limitedDocument)}` }] },
        contents,
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 400 }
      })
    });
  } catch {
    throw new Error('Gemini 서버와 통신하지 못했습니다. 네트워크 또는 Gemini 서버 상태를 확인해주세요.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error?.status || body?.error?.code;
    const suffix = code ? ` (${code})` : '';
    throw new Error(`Gemini 요청에 실패했습니다${suffix}. Gemini 설정과 무료 등급 사용량을 확인해주세요.`);
  }
  const answer = extractOutputText(body);
  if (!answer) throw new Error('Gemini 응답에서 텍스트를 찾지 못했습니다.');
  return parseChatResult(answer);
}

export { DEFAULT_MODEL, RESTRICTED_CHAT_MESSAGE, buildDocumentContext, limitDocumentText, parseChatResult };
