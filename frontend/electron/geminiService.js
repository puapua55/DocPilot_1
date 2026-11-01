import { secureApiFetch } from './secureApiFetch.js';
import { inferDocumentCommand } from './documentCommandParser.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MAX_HISTORY = 10;
const MAX_DOCUMENT_TEXT = 20_000;
const DOCUMENT_EDGE_LENGTH = MAX_DOCUMENT_TEXT / 2;
const ALLOWED_ACTION_TYPES = new Set(['search', 'highlight', 'replace', 'batch-replace', 'undo', 'redo', 'reset', 'viewer-command']);
const RESTRICTED_CHAT_MESSAGE = '채팅은 정확한 문서 검색, 위치 하이라이트, 즉시 텍스트 교체 요청에만 사용할 수 있습니다.';

const DOCUMENT_ASSISTANT_INSTRUCTIONS = `너는 DocPilot의 문서 작업 보조 AI다. 지원하는 요청은 정확한 문서 검색(search), 위치 하이라이트(highlight), 즉시 텍스트 교체(replace), 실행 취소(undo), 다시 실행(redo), 전체 초기화(reset), 문서 보기 제어(viewer-command)다.
요약, 문서 질의응답, 일반 대화, 사용법 안내, 그 밖의 모든 요청은 지원하지 않는다.
지원하지 않는 요청에는 intent를 unsupported로, answer를 '${RESTRICTED_CHAT_MESSAGE}'로, action을 null로 설정한다.
검색 요청은 search이며 keyword를 추출한다. 하이라이트/표시 요청은 highlight이며 keyword를 추출한다. 텍스트 치환 요청은 replace이며 originalText와 newText를 추출한다.
search/highlight/replace 작업을 직접 실행했다고 절대 말하지 않는다. 실행 가능한 작업을 준비했다고 설명하고 반드시 사용자 승인 버튼을 눌러야 실행된다고 안내한다.
응답은 JSON 객체만 출력한다. 형식은 {"answer":"...","intent":"search|highlight|replace|unsupported","action":null}이다.
search action은 {"type":"search","keyword":"..."}, highlight action은 {"type":"highlight","keyword":"..."}, replace action은 {"type":"replace","originalText":"...","newText":"..."} 형식이다.
문서 상태를 이전으로 되돌리는 요청은 {"type":"undo"}, 되돌린 변경을 다시 적용하는 요청은 {"type":"redo"}, 모든 편집을 초기화하는 요청은 {"type":"reset"}으로 반환한다.
보기 제어는 {"type":"viewer-command","operations":[...]} 형식이다. operations에는 set-view-mode(mode:scroll|page), go-to-page(page:number|first|last|middle 또는 relative:number), zoom(value|delta|multiplier), fit(mode:width|page), download(format:pdf|docx)만 허용한다. 여러 작업 요청은 사용자가 말한 순서대로 operations에 넣는다. 대상이 불명확하거나 연결되지 않은 편집 기능은 실행했다고 말하지 말고 unsupported로 안내한다.
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

const NATURAL_TEXT_INSTRUCTION = `
사용자가 찾거나 바꿀 문구를 작은따옴표나 큰따옴표로 감싸지 않아도 반드시 문장 의미와 한국어 명령 구조로 작업 대상을 추출한다. 따옴표는 선택 사항이며 필수 구문이 아니다.
- "테그스 찾아줘", "문서에서 테그스 검색해줘" -> search, keyword는 "테그스"
- "프로젝트를 찾아줘" -> search, keyword는 "프로젝트"이며 조사 "를"과 명령어 "찾아줘"는 keyword에 포함하지 않는다.
- "2페이지 프로젝트를 노란색으로 하이라이트해줘" -> highlight, keyword는 "프로젝트", 2페이지 첫 일치 결과를 yellow 대상으로 지정한다.
- "PDF를 TXT로 바꿔줘", "PDF에서 TXT로 변경해줘", "PDF -> TXT 교체해줘" -> batch-replace, originalText는 "PDF", newText는 "TXT"
- "문서 검색 및 편집 지원 프로그램을 DocPilot로 바꿔줘" -> 여러 단어로 된 원문 전체를 originalText로 유지한다.
문서에서/문서 안에서 같은 범위 표현, 을/를/으로/로/에서 같은 경계 조사, 찾아줘/검색해줘/바꿔줘/변경해줘 같은 명령 표현을 결과 문자열에서 제외한다. 사용자가 실제로 입력한 문구의 띄어쓰기와 대소문자는 유지한다.
검색 개수를 지정하면 search action에 양의 정수 limit를 넣는다. "첫 페이지 기준"은 order="first", "끝 페이지 기준"은 order="last"다. 개수만 있고 기준이 없으면 order=null로 반환한다. 예: "문서를 2개만 찾아줘" -> {"type":"search","keyword":"문서","limit":2,"order":null}.
따옴표로 감싼 범위는 검색어 자체로 우선한다. 예: "'문서 를' 2개만 찾아줘"의 keyword는 공백과 조사를 포함한 "문서 를"이다. 따옴표가 없으면 검색어 뒤에 떨어져 있거나 붙어 있는 을/를은 명령 문법의 조사로 보고 keyword에 포함하지 않는다.
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
      if (intent === 'search') {
        const limit = Number(parsed.action.limit ?? parsed.action.count);
        if (Number.isInteger(limit) && limit > 0) {
          action.limit = limit;
          action.order = ['first', 'last'].includes(parsed.action.order) ? parsed.action.order : null;
        }
      }
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
    } else if (['undo', 'redo', 'reset'].includes(intent) && parsed.action?.type === intent) {
      action = { type: intent };
    } else if (intent === 'viewer-command' && parsed.action?.type === intent && Array.isArray(parsed.action.operations)) {
      const commands = new Set(['set-view-mode', 'go-to-page', 'zoom', 'fit', 'download']);
      const operations = parsed.action.operations.filter((operation) => commands.has(operation?.command));
      if (operations.length) action = { type: intent, operations };
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
    response = await secureApiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${DOCUMENT_ASSISTANT_INSTRUCTIONS}\n${NATURAL_TEXT_INSTRUCTION}\n${BATCH_REPLACE_INSTRUCTION}\n${HIGHLIGHT_TARGET_INSTRUCTION}\n${BATCH_SCOPE_INSTRUCTION}\n${NO_APPROVAL_INSTRUCTION}\n${buildDocumentContext(request, limitedDocument)}` }] },
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
  const parsed = parseChatResult(answer);
  const inferred = inferDocumentCommand(request.message);
  if (inferred?.action?.type === 'search' && (!parsed.action || parsed.action.type === 'search')) return inferred;
  return parsed.action ? parsed : (inferred || parsed);
}

export { DEFAULT_MODEL, RESTRICTED_CHAT_MESSAGE, buildDocumentContext, limitDocumentText, parseChatResult };
