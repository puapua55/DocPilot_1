const TRAILING_PUNCTUATION = /[.!?。！？]+$/u;
const WRAPPING_QUOTES = [
  ["'", "'"],
  ['"', '"'],
  ['‘', '’'],
  ['“', '”'],
  ['`', '`']
];

function normalizeCommand(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_PUNCTUATION, '')
    .trim();
}

function cleanOperand(value) {
  let operand = normalizeCommand(value);
  let changed = true;
  while (changed && operand.length >= 2) {
    changed = false;
    for (const [open, close] of WRAPPING_QUOTES) {
      if (operand.startsWith(open) && operand.endsWith(close)) {
        operand = operand.slice(open.length, -close.length).trim();
        changed = true;
        break;
      }
    }
  }
  return operand;
}

function replacementResult(originalText, newText) {
  return {
    answer: `텍스트 변경 대상을 찾습니다.\n변경 전: ${originalText}\n변경 후: ${newText}`,
    intent: 'batch-replace',
    action: { type: 'batch-replace', originalText, newText, all: false, targets: [] }
  };
}

function parseHistoryCommand(text) {
  const compact = text.replace(/\s+/g, '');
  const countMatch = text.match(/(?:([2-9])|두|세)\s*(?:번|개|단계|작업)/u);
  const count = countMatch ? Number(countMatch[1] || (countMatch[0].startsWith('두') ? 2 : 3)) : 1;
  const reset = /(?:전체|전부|모두|모든|완전히|처음|초기|원본|원래\s*상태|처음\s*열었을)/u.test(text)
    && /(?:초기화|취소|되돌|돌려|복원|없애|지워|새로\s*시작)/u.test(text)
    && /(?:문서|편집|수정|변경|작업|내용|상태|이력|하이라이트|텍스트|파일)/u.test(text);
  if (reset || /^(?:전체|모두)초기화/u.test(compact)) {
    return { answer: '문서의 편집 내용을 전체 초기화합니다.', intent: 'reset', action: { type: 'reset' } };
  }
  const redo = /(?:다시\s*실행|재실행|다시\s*적용|다시\s*반영|다시\s*해|다시\s*복원|다시\s*살려|redo)/iu.test(text)
    || /(?:취소|되돌린|되돌렸|없앤).{0,18}(?:복원|복구|살려|되돌려|원래\s*변경\s*상태)/u.test(text)
    || /(?:실행\s*취소|취소(?:한|했던|하기)?|되돌린|되돌렸).{0,24}다시/u.test(text);
  if (redo) {
    return {
      answer: '되돌린 문서 변경을 다시 적용합니다.', intent: 'redo',
      action: { type: 'redo', ...(count > 1 ? { count } : {}) }
    };
  }
  const undo = /(?:실행\s*취소|되돌려|되돌리|원상복구|이전\s*(?:(?:편집\s*)?상태|단계|작업|으로|로)|수정하기\s*전|없던\s*일)/u.test(text)
    || /(?:방금|마지막|최근|조금\s*전|아까|지금).{0,25}(?:취소|없애|돌려|복구)/u.test(text);
  if (undo) {
    return {
      answer: '문서의 마지막 변경을 이전 상태로 되돌립니다.', intent: 'undo',
      action: { type: 'undo', ...(count > 1 ? { count } : {}) }
    };
  }
  return null;
}

function parsePageScope(text) {
  let match = text.match(/(\d+)\s*페이지\s*(?:부터|에서)\s*(\d+)\s*페이지\s*(?:까지|사이)/u);
  if (match) return { kind: 'range', startPage: Number(match[1]), endPage: Number(match[2]) };
  match = text.match(/(\d+)\s*페이지\s*와\s*(\d+)\s*페이지/u);
  if (match) return { kind: 'pages', pages: [Number(match[1]), Number(match[2])] };
  match = text.match(/(?:첫|앞의|앞부분)\s*(\d+)\s*페이지/u);
  if (match) return { kind: 'first-n', count: Number(match[1]) };
  match = text.match(/마지막\s*(\d+)\s*페이지/u);
  if (match) return { kind: 'last-n', count: Number(match[1]) };
  match = text.match(/(\d+)\s*페이지\s*(?:이후|부터\s*마지막\s*페이지|부터\s*(?:문서\s*)?끝)/u);
  if (match) return { kind: 'from', startPage: Number(match[1]) };
  if (/(?:현재|지금)\s*페이지\s*부터\s*(?:문서\s*)?끝/u.test(text)) return { kind: 'from-current' };
  match = text.match(/(\d+)\s*페이지/u);
  if (match) return { kind: 'page', page: Number(match[1]) };
  if (/(?:현재|지금(?:\s*보고\s*있는)?)\s*페이지/u.test(text)) return { kind: 'current' };
  if (/(?:첫|첫\s*번째)\s*페이지/u.test(text)) return { kind: 'first' };
  if (/(?:마지막|끝)\s*페이지/u.test(text)) return { kind: 'last' };
  return null;
}

function stripLeadingScope(text) {
  return text
    .replace(/^(?:혹시|먼저|일단)\s*/u, '')
    .replace(/^(?:현재|지금)\s*페이지\s*부터\s*(?:문서\s*)?끝\s*까지\s*/u, '')
    .replace(/^(?:(?:현재|지금)\s*(?:보고\s*있는\s*)?페이지|(?:문서의\s*)?앞부분\s*\d+\s*페이지)\s*(?:에서|의|에)?\s*/u, '')
    .replace(/^(?:앞의|첫|마지막)\s*\d+\s*페이지\s*(?:에서|의|에)?\s*/u, '')
    .replace(/^\d+\s*페이지\s*부터\s*(?:마지막\s*페이지|문서\s*끝)\s*까지\s*/u, '')
    .replace(/^\d+\s*페이지\s*부터\s*끝\s*까지\s*/u, '')
    .replace(/^\d+\s*페이지\s*이후(?:에)?\s*(?:나오는|있는)?\s*/u, '')
    .replace(/^(?:문서|파일)\s*전체에서\s*/u, '')
    .replace(/^(?:정확한\s*검색으로|정확히\s*일치하는|정확히)\s*/u, '')
    .replace(/^(?:(?:지금\s*열린|현재|이)\s*)?(?:문서|파일|PDF|DOCX|본문|여기)(?:\s*전체|\s*내용)?\s*(?:안에서|안에|내에서|에서|에\s*있는|에|내|속에서)\s*/iu, '')
    .replace(/^(?:\d+\s*페이지\s*(?:부터|에서)\s*\d+\s*페이지\s*(?:까지|사이)|\d+\s*페이지\s*와\s*\d+\s*페이지|(?:첫|마지막|끝|현재|지금\s*보고\s*있는)\s*페이지|\d+\s*페이지)(?:의|에서|에\s*있는|에|부터)?\s*/u, '')
    .replace(/^(?:두\s*번째로|첫\s*번째로|마지막으로)\s*나오는\s*/u, '')
    .replace(/^(?:중요한\s*내용\s*중|정확한\s*검색으로)\s*/u, '');
}

function parseSearchCommand(text) {
  if (!/(?:찾|검색|어디|있는지|있을까|나오는지|몇\s*번|위치|결과|보여|알려|확인)/u.test(text)) return null;
  if (/(?:하이라이트|강조|형광펜|색칠|칠해|교체|바꿔|변경할|수정할)/u.test(text)) return null;
  const quoted = text.match(/['"‘“`]([^'"’”`]+)['"’”`]/u);
  let keyword = quoted?.[1] || stripLeadingScope(text);
  if (!quoted) {
    keyword = keyword
      .replace(/^있는\s+/u, '')
      .replace(/^(?:두\s*번째로|첫\s*번째로|마지막으로)\s*나오는\s*/u, '');
    const label = keyword.match(/^(.+?)(?:이라는|라는|이라고|라고)\s*(?:단어|문구|글자|말|문장|내용|숫자|표현|부분)?/u);
    if (label) keyword = label[1];
    else keyword = keyword
      .replace(/\s*(?:가|이)?\s*(?:있는지|나오는지|몇\s*번|어디에|어디|위치|결과|처음(?:으로)?\s*나오는|마지막으로\s*나오는|있는\s*(?:모든\s*)?(?:부분|곳|문단|줄|페이지)|나오는\s*(?:부분|곳|페이지|위치)|들어간\s*(?:부분|곳)|포함된\s*(?:부분|곳)).*$/u, '')
      .replace(/\s*(?:을|를|가|이|부터)?\s*(?:찾아|찾아봐|찾아줄|검색|확인|보여|알려).*$/u, '')
      .replace(/\s*(?:단어|문구|글자|문장|내용|말|부분)(?:를|을)?$/u, '');
  }
  keyword = quoted?.[1] || cleanOperand(keyword)
    .replace(/\s*(?:(?:첫|끝)\s*페이지\s*기준(?:으로)?\s*)?\d+\s*개(?:만)?$/u, '')
    .replace(/(?:을|를|가|이|부터)$/u, '').trim();
  if (!keyword) return null;
  const pageScope = /(?:첫|끝)\s*페이지\s*기준/u.test(text) ? null : parsePageScope(text);
  const limitMatch = text.match(/(\d+)\s*개(?:만)?/u);
  const limit = Number(limitMatch?.[1]);
  const order = /(?:끝\s*페이지|마지막으로)/u.test(text) ? 'last'
    : /첫\s*페이지/u.test(text) ? 'first' : null;
  const occurrence = /(?:두\s*번째|2\s*번째)/u.test(text) ? 2
    : /(?:첫\s*번째|1\s*번째|처음(?:으로)?\s*나오는)/u.test(text) ? 1
      : /마지막으로\s*나오는/u.test(text) ? 'last' : null;
  return {
    answer: `'${keyword}' 문구를 정확한 문서 검색으로 찾습니다.`, intent: 'search',
    action: {
      type: 'search', keyword,
      ...(limit > 0 ? { limit, order } : {}),
      ...(pageScope ? { pageScope } : {}),
      ...(occurrence ? { occurrence } : {}),
      ...(/(?:정확히|정확한|띄어쓰기까지\s*동일)/u.test(text) ? { matchMode: 'exact' } : {})
    }
  };
}

function parseHighlightCommand(text) {
  const pageScope = parsePageScope(text);
  const colorMatch = text.match(/노란색|노랑|노란|초록색|초록|파란색|파랑|분홍색|분홍/u);
  if (!/(?:하이라이트|강조|표시|칠해|형광펜|색칠|배경색|눈에\s*띄게)/u.test(text)
    && !(pageScope && colorMatch)) return null;
  const unsupportedColor = text.match(/(?:빨간색|빨강|연두색|주황색|보라색|검정색|하얀색|회색)/u);
  if (unsupportedColor) {
    return {
      answer: `${unsupportedColor[0]} 하이라이트는 현재 지원하지 않습니다. 노란색, 초록색, 파란색, 분홍색 중에서 선택해주세요.`,
      intent: 'unsupported', action: null
    };
  }
  const colorMap = { 노란색: 'yellow', 노랑: 'yellow', 노란: 'yellow', 초록색: 'green', 초록: 'green', 파란색: 'blue', 파랑: 'blue', 분홍색: 'pink', 분홍: 'pink' };
  const color = colorMap[colorMatch?.[0]] || 'yellow';
  const quoted = text.match(/['"‘“`]([^'"’”`]+)['"’”`]/u);
  let keyword = quoted?.[1] || stripLeadingScope(text);
  if (!quoted) {
    keyword = keyword
      .replace(/^(?:검색\s*결과(?:\s*중)?|첫\s*번째로\s*나오는|두\s*번째로\s*나오는|마지막으로\s*나오는)\s*/u, '')
      .replace(/\s*(?:노란색|노랑|노란|초록색|초록|파란색|파랑|분홍색|분홍)(?:으로|로)?\s*/u, ' ');
    const labeled = keyword.match(/^(.+?)(?:이라는|라는|이라고|라고)\s*(?:단어|문구|글자|부분|내용|표현)?/u);
    if (labeled) keyword = labeled[1];
    else keyword = keyword
      .replace(/\s*(?:검색\s*결과\s*중|부분|글자|문구|단어|내용|곳)(?:에|을|를|은|는)?\s*(?:첫|두|세|마지막|전부|모두|전체|빠짐없이)?.*$/u, '')
      .replace(/\s*(?:을|를|에|가|이)?\s*(?:전부|모두|전체|빠짐없이)?\s*(?:검색해서|찾아서|찾아|하이라이트|강조|표시|칠해|형광펜|색칠|눈에\s*띄게).*$/u, '');
    keyword = keyword
      .replace(/\s*(?:첫|두|세|마지막)\s*번째(?:만|로)?\s*$/u, '')
      .replace(/\s*(?:전부|모두|전체|빠짐없이)\s*$/u, '')
      .replace(/(?:을|를|가|이|에)$/u, '').trim();
  }
  keyword = cleanOperand(keyword);
  if (!keyword || /^(?:하이라이트|강조|표시|형광펜|문서\s*전체)$/u.test(keyword)) {
    return { answer: '하이라이트할 문구를 알려주세요. 예: 프로젝트를 하이라이트해줘', intent: 'needs-target', action: null };
  }
  const occurrence = /(?:세\s*번째|3\s*번째)/u.test(text) ? 3
    : /(?:두\s*번째|2\s*번째)/u.test(text) ? 2
      : /(?:마지막(?:으로|\s*것)?|끝에서)/u.test(text) && !pageScope?.kind?.startsWith('last') ? 'last' : 1;
  const singlePageScope = ['page', 'first', 'last', 'current'].includes(pageScope?.kind);
  const all = /(?:전부|모두|전체|빠짐없이|모든)/u.test(text) || !singlePageScope;
  const action = {
    type: 'highlight', keyword, all, color,
    targets: all || pageScope.kind !== 'page' ? [] : [{ page: pageScope.page, occurrence, color }],
    ...(pageScope ? { pageScope } : {})
  };
  return {
    answer: all ? `'${keyword}'와 일치하는 문구를 지정한 범위에서 하이라이트합니다.`
      : `'${keyword}' 하이라이트 대상을 확인합니다.`,
    intent: 'highlight', action
  };
}

function parseReplacementCommand(text) {
  if (/(?:찾아서|검색해서).*(?:변경|수정|교체)할\s*수\s*있게/u.test(text)) {
    return { answer: '변경할 새 문구를 알려주세요. 예: 기존 계획을 수정 계획으로 변경해줘', intent: 'needs-target', action: null };
  }
  if (/(?:찾|검색|알려|보여|확인|어디|위치|있는지|하이라이트|강조|표시|칠해|형광펜)/u.test(text)
    && !/(?:바꿔|바꾸|바꿀|변경(?:할|한|해|하)|일괄\s*변경|수정(?:해|할|하)|고쳐|교체|대체)/u.test(text)) return null;
  const hasReplacementCue = /(?:바꿔|바꾸|바꿀|변경|수정|고쳐|교체|대체)/u.test(text);
  if (!hasReplacementCue && (!/^(?:.+?)\s*(?:일괄|전부|모두)\s+.+(?:으로|로)?\.?$/u.test(text)
    || /(?:찾|검색|하이라이트|강조|표시|칠해|형광펜)/u.test(text))) return null;
  const pageScope = parsePageScope(text);
  const quoted = [...text.matchAll(/['"‘“`]([^'"’”`]+)['"’”`]/gu)].map((match) => match[1]);
  let originalText = quoted.length >= 2 ? quoted[0] : '';
  let newText = quoted.length >= 2 ? quoted[1] : '';
  if (!originalText) {
    let source = stripLeadingScope(text)
      .replace(/^(?:문서\s*전체의|검색\s*결과\s*전체의|모든\s*페이지의)\s*/u, '')
      .replace(/^(?:검색된|찾아진|현재\s*찾은|검색\s*결과에\s*있는|일괄\s*변경\s*목록에\s*있는|변경\s*대상으로\s*나온|여러\s*페이지에\s*있는)\s*/u, '')
      .replace(/^(?:기존\s*문구인|찾을\s*문구인)\s*/u, '');
    source = source.replace(/^있는\s+/u, '');
    const describedPair = source.match(/^(.+?)라고\s*되어\s*있는\s*곳을\s*(?:전부|모두)?\s*(.+?)라고\s*고쳐/u)
      || source.match(/^(.+?)라고\s*적힌\s*곳은\s*(?:전부|모두)?\s*(.+?)(?:으로|로)\s*수정/u);
    const pair = describedPair || source.match(/^(.+?)(?:이라는|라는|이라고|라고)?\s*(?:단어|문구|글자|말|표현|부분)?\s*(?:을|를|에서)\s+(.+?)(?:으로|로)\s*(?:전부|모두|전체|한\s*번에|일괄)?\s*(?:바꿔|바꾸|바꿀|변경|수정|고쳐|교체|대체|할|하면|하기|할\s*수|될)/u);
    if (pair) {
      originalText = pair[1];
      newText = pair[2];
    } else {
      const shortPair = source.match(/^(.+?)\s*(?:전체|전부|모두|일괄)\s+(.+?)(?:으로|로)?\s*(?:변경|수정|교체|바꿔|바꾸|$)/u);
      if (shortPair) {
        originalText = shortPair[1];
        newText = shortPair[2];
      }
    }
  }
  originalText = cleanOperand(originalText).replace(/^(?:문서\s*전체의|검색\s*결과\s*전체의|모든\s*페이지의)\s*/u, '')
    .replace(/(?:이라는|라는|이라고|라고)\s*(?:단어|문구|글자)?$/u, '').trim();
  newText = cleanOperand(newText).replace(/^(?:전부|모두|전체|새\s*문구인|변경할\s*문구인)\s*/u, '').trim();
  if (!originalText || !newText) {
    if (/(?:변경할|교체할|바꿀|일괄\s*변경)/u.test(text)) {
      return { answer: '변경할 새 문구를 알려주세요. 예: 기존 계획을 수정 계획으로 변경해줘', intent: 'needs-target', action: null };
    }
    return null;
  }
  const result = replacementResult(originalText, newText);
  const asksForReview = /(?:전에|먼저|대상(?:부터|을)?\s*(?:확인|검토)|목록을\s*보여|건수를\s*알려|위치를\s*(?:보여|찾아)|항목을\s*(?:찾아|검색)|변경할\s*항목을\s*모두\s*찾아)/u.test(text);
  const applyThenReport = /(?:변경|수정|교체|바꾼|바꿔)\s*한?\s*뒤\s*(?:건수|결과|개수)/u.test(text);
  result.action.all = applyThenReport || !asksForReview && /(?:전부|모두|전체|모든|일괄|한\s*번에|빠짐없이)/u.test(text);
  if (pageScope) result.action.pageScope = pageScope;
  return result;
}

function parseDownloadCommand(text) {
  if (!/(?:PDF|DOCX|Word|워드|\.pdf|\.docx)/iu.test(text)
    || !/(?:다운로드|저장|내려받|내보내|변환|만들|받을|받고|받아|미리보기|파일명|이름)/u.test(text)) return null;
  if (/(?:을|를)\s+.+(?:으로|로)\s*(?:바꿔|바꾸|변경|교체|수정)/u.test(text)
    || [...text.matchAll(/['"‘“`]([^'"’”`]+)['"’”`]/gu)].length >= 2) return null;
  const extensionMatch = text.match(/([^\s'"‘“’”\\/:*?<>|]+)\.(pdf|docx)\b/iu);
  let format = extensionMatch?.[2]?.toLowerCase();
  if (!format) {
    const matches = [...text.matchAll(/PDF|DOCX|Word|워드/giu)];
    const last = matches.at(-1)?.[0]?.toLowerCase();
    format = last === 'pdf' ? 'pdf' : last ? 'docx' : null;
  }
  if (!format) return null;
  if (/저장\s*형식(?:을|은)?\s*(?:PDF|DOCX|Word|워드)(?:으로|로)?\s*지정/u.test(text)) {
    return { answer: '저장 형식을 따로 지정하는 기능은 없습니다. 원하는 형식으로 다운로드해달라고 요청해주세요.', intent: 'needs-action', action: null };
  }
  if (format === 'docx' && /(?:미리보기|다운로드하기\s*전에|먼저\s*(?:보여|확인))/u.test(text)) {
    return { answer: 'DOCX 결과는 왼쪽 문서 뷰어에서 확인한 뒤 다운로드할 수 있습니다.', intent: 'preview', action: null };
  }
  const operation = { command: 'download', format };
  if (extensionMatch) operation.filename = `${extensionMatch[1]}.${extensionMatch[2].toLowerCase()}`;
  else {
    const suffix = text.match(/(?:원본|현재\s*파일|파일)\s*(?:이름|파일명)\s*뒤에\s*([\w가-힣-]+?)(?:을|를)?\s*붙여/u);
    if (suffix) operation.nameSuffix = suffix[1];
    else {
      const named = text.match(/(?:파일명(?:을|은)?|이름(?:을|은)?)\s+([\w가-힣.-]+?)(?:으로|로|라고)/u)
        || text.match(/([\w가-힣.-]+?)(?:이)?라는\s*이름(?:으로|의)/u);
      if (named && !/^(?:원본|원래|현재)$/u.test(named[1])) operation.filename = named[1];
    }
  }
  return {
    answer: format === 'pdf' ? '현재 문서의 PDF 미리보기를 엽니다.' : '현재 문서를 DOCX로 저장합니다.',
    intent: 'download', action: { type: 'viewer-command', operations: [operation] }
  };
}

function inferViewerOperations(text) {
  const operations = [];
  const add = (index, operation) => operations.push({ index, ...operation });
  let match;

  const pageViewMatch = text.match(/(?:페이지\s*이동\s*(?:모드|방식)|페이지\s*단위로\s*보|페이지별로\s*(?:끊어서|구분해서)|한\s*페이지씩|한\s*페이지\s*보기|한\s*장씩|페이지를\s*하나씩\s*넘겨|다음\s*페이지\s*버튼으로|연속\s*보기\s*대신\s*한\s*페이지)/u);
  const scrollViewMatch = text.match(/(?:연속\s*스크롤|스크롤(?:하면서|해서|\s*모드|\s*방식)?|아래로\s*(?:쭉|계속)|연속해서\s*(?:페이지|볼)|연속\s*보기|쭉\s*내려가|세로로\s*계속\s*내려가|페이지가\s*끊어지지\s*않고\s*이어|페이지를\s*아래로\s*내리면서)/u);
  if (pageViewMatch && /(?:스크롤.{0,8}해제|연속\s*보기\s*대신)/u.test(text)) add(pageViewMatch.index, { command: 'set-view-mode', mode: 'page' });
  else if (scrollViewMatch) add(scrollViewMatch.index, { command: 'set-view-mode', mode: 'scroll' });
  else if (pageViewMatch) add(pageViewMatch.index, { command: 'set-view-mode', mode: 'page' });

  if ((match = text.match(/(\d+)\s*페이지(?:로|를)?\s*(?:바로\s*)?(?:이동|열어|보여|넘어)/u))) add(match.index, { command: 'go-to-page', page: Number(match[1]) });
  else if ((match = text.match(/(?:마지막|끝)\s*페이지(?:로|를)?\s*(?:이동|열어|보여|가)/u))) add(match.index, { command: 'go-to-page', page: 'last' });
  else if ((match = text.match(/(?:첫|첫\s*번째)\s*페이지(?:로|를|부터)?\s*(?:돌아|이동|열어|보여|가)/u))) add(match.index, { command: 'go-to-page', page: 'first' });
  else if ((match = text.match(/(?:중간|가운데)\s*페이지(?:로|를)?\s*(?:이동|열어|보여|가)/u))) add(match.index, { command: 'go-to-page', page: 'middle' });
  else if ((match = text.match(/(\d+)\s*페이지\s*(?:앞|앞으로)/u))) add(match.index, { command: 'go-to-page', relative: Number(match[1]) });
  else if ((match = text.match(/(\d+)\s*페이지\s*뒤로/u))) add(match.index, { command: 'go-to-page', relative: -Number(match[1]) });
  else if ((match = text.match(/두\s*장\s*앞으로/u))) add(match.index, { command: 'go-to-page', relative: 2 });
  else if (!/다음\s*페이지\s*버튼으로/u.test(text) && (match = text.match(/(?:다음|이후)\s*(?:페이지|장)(?:로)?\s*(?:이동|넘어|넘겨|보여)?/u))) add(match.index, { command: 'go-to-page', relative: 1 });
  else if ((match = text.match(/(?:이전|앞)\s*페이지(?:로)?\s*(?:돌아|이동|보여|열어)?|이전에\s*보던\s*페이지|한\s*페이지\s*뒤로/u))) add(match.index, { command: 'go-to-page', relative: -1 });
  else if ((match = text.match(/한\s*페이지\s*앞으로/u))) add(match.index, { command: 'go-to-page', relative: 1 });

  if ((match = text.match(/(?:지금보다|현재보다)\s*(\d{1,3})\s*%\s*더\s*(?:확대|키워|축소|줄여)/u))) add(match.index, { command: 'zoom', delta: Number(match[1]) / 100 * (/(?:축소|줄여)/u.test(match[0]) ? -1 : 1) });
  else if ((match = text.match(/(\d{2,3})\s*%\s*(?:로|크기로)?\s*(?:확대|축소|변경|맞춰|맞추|설정|되돌려)/u))) add(match.index, { command: 'zoom', value: Number(match[1]) / 100 });
  else if ((match = text.match(/(?:배율|비율).{0,12}?(\d{2,3})\s*%\s*(?:로\s*)?(?:설정|변경|맞춰)/u))) add(match.index, { command: 'zoom', value: Number(match[1]) / 100 });
  else if ((match = text.match(/(?:두\s*배|2\s*배)\s*(?:크게|확대)/u))) add(match.index, { command: 'zoom', multiplier: 2 });
  else if ((match = text.match(/절반으로\s*줄여/u))) add(match.index, { command: 'zoom', multiplier: 0.5 });
  else if ((match = text.match(/(\d{1,3})\s*%\s*(?:만)?\s*더\s*(?:키워|확대)/u))) add(match.index, { command: 'zoom', delta: Number(match[1]) / 100 });
  else if ((match = text.match(/(?:조금|좀)\s*(?:더\s*)?(?:크게|확대|키워)/u))) add(match.index, { command: 'zoom', delta: 0.1 });
  else if ((match = text.match(/(?:조금|좀)\s*(?:더\s*)?(?:작게|축소|줄여)/u))) add(match.index, { command: 'zoom', delta: -0.1 });
  else if ((match = text.match(/(?:원래\s*화면\s*크기|기본\s*배율|(?:확대\s*(?:비율|상태)|배율)\s*(?:을|를)?\s*초기화|(?:원래|기본)\s*(?:확대\s*)?비율)/u))) add(match.index, { command: 'zoom', value: 1 });
  else if ((match = text.match(/(?:화면|문서|페이지|글자|확대\s*비율).{0,15}(?:확대|크게|키워|올려)/u))) add(match.index, { command: 'zoom', delta: 0.1 });
  else if ((match = text.match(/축소\s*버튼(?:을)?\s*한\s*번\s*적용|(?:화면|문서|페이지|축소\s*버튼).{0,15}(?:축소|작게|줄여)/u))) add(match.index, { command: 'zoom', delta: -0.1 });

  if ((match = text.match(/(?:너비|가로\s*크기|가로\s*맞춤|좌우\s*폭|화면\s*폭|좌우).{0,18}(?:화면|뷰어|맞춤|맞춰|맞게|확대|조절|설정)|너비\s*맞춤|가로\s*맞춤|너비\s*기준\s*자동\s*확대/u))) add(match.index, { command: 'fit', mode: 'width' });
  else if ((match = text.match(/(?:페이지\s*전체|한\s*페이지|한\s*장|문서\s*전체\s*높이|페이지의\s*위아래|현재\s*페이지).{0,24}(?:화면|한\s*화면|맞춤).{0,18}(?:보이|들어오|맞춰|맞게|설정)|페이지\s*(?:전체\s*)?맞춤|스크롤하지\s*않아도\s*한\s*페이지|문서\s*한\s*장이\s*전부\s*보이|페이지의\s*위아래까지\s*모두\s*보이/u))) add(match.index, { command: 'fit', mode: 'page' });

  if ((match = text.match(/(?:PDF로|PDF\s*형식으로|PDF\s*파일로).{0,25}(?:다운로드|저장|내려받|내보내)/iu))) add(match.index, { command: 'download', format: 'pdf' });
  else if ((match = text.match(/(?:DOCX로|DOCX\s*형식으로|워드\s*파일로|워드\s*문서로).{0,25}(?:다운로드|저장|내려받|내보내|만들)/iu))) add(match.index, { command: 'download', format: 'docx' });

  return operations.sort((a, b) => a.index - b.index).map(({ index, ...operation }) => operation);
}

/**
 * Conservative fallback for the common Korean commands used by DocPilot.
 * Gemini remains the primary semantic parser. This function is used only
 * when the model response is missing or cannot be converted into an action.
 */
export function inferDocumentCommand(message) {
  const text = normalizeCommand(message);
  if (!text) return null;
  const downloadCommand = parseDownloadCommand(text);
  if (downloadCommand) return downloadCommand;
  const viewerOperations = inferViewerOperations(text);
  if (viewerOperations.length) {
    const fitOperation = viewerOperations.findLast((operation) => operation.command === 'fit');
    return {
      answer: fitOperation
        ? `문서를 ${fitOperation.mode === 'width' ? '너비' : '페이지'}에 맞춥니다.`
        : viewerOperations.length > 1 ? '요청한 문서 보기 작업을 순서대로 실행합니다.' : '요청한 문서 보기 작업을 실행합니다.',
      intent: 'viewer-command',
      action: { type: 'viewer-command', operations: viewerOperations }
    };
  }

  const historyCommand = parseHistoryCommand(text);
  if (historyCommand) return historyCommand;

  const scopedText = text.replace(/^현재\s*문서(?:에서|\s*내에서|\s*안에서)\s*/u, '')
    .replace(/^문서(?:에서|\s*내에서|\s*안에서)\s*/u, '');

  const parsedReplacement = parseReplacementCommand(scopedText);
  if (parsedReplacement) return parsedReplacement;

  const arrowReplacement = scopedText.match(/^(.+?)\s*(?:->|→|=>)\s*(.+?)\s*(?:으로|로)?\s*(?:바꿔\s*줘|바꿔줘|바꿔주세요|변경(?:해\s*줘|해줘|해주세요|해 주세요)?|교체(?:해\s*줘|해줘|해주세요|해 주세요)?|일괄\s*변경(?:해\s*줘|해줘|해주세요|해 주세요)?)$/u);
  if (arrowReplacement) {
    const originalText = cleanOperand(arrowReplacement[1]);
    const newText = cleanOperand(arrowReplacement[2]);
    if (originalText && newText) return replacementResult(originalText, newText);
  }

  const particleReplacement = scopedText.match(/^(.+?)(?:을|를|에서)\s*(.+?)(?:으로|로)\s*(?:바꿔\s*줘|바꿔줘|바꿔주세요|변경(?:해\s*줘|해줘|해주세요|해 주세요)?|교체(?:해\s*줘|해줘|해주세요|해 주세요)?|일괄\s*변경(?:해\s*줘|해줘|해주세요|해 주세요)?)$/u);
  if (particleReplacement) {
    const originalText = cleanOperand(particleReplacement[1]);
    const newText = cleanOperand(particleReplacement[2]);
    if (originalText && newText) return replacementResult(originalText, newText);
  }

  const parsedHighlight = parseHighlightCommand(scopedText);
  if (parsedHighlight) return parsedHighlight;

  const parsedSearch = parseSearchCommand(scopedText);
  if (parsedSearch) return parsedSearch;
  const quotedSearch = scopedText.match(/^(['"‘“`])(.+?)(?:['"’”`])\s*(?:을|를)?\s*(?:(첫\s*페이지|끝\s*페이지)\s*기준(?:으로)?\s*)?(?:(\d+)\s*개(?:만)?\s*)?(?:찾아\s*줘|찾아줘|찾아주세요|검색(?:해\s*줘|해줘|해주세요|해 주세요)?|검색해줘|검색해주세요)$/u);
  const search = quotedSearch || scopedText.match(/^(.+?)(?:\s+(?:을|를)|(?:을|를))?\s*(?:(첫\s*페이지|끝\s*페이지)\s*기준(?:으로)?\s*)?(?:(\d+)\s*개(?:만)?\s*)?(?:찾아\s*줘|찾아줘|찾아주세요|검색(?:해\s*줘|해줘|해주세요|해 주세요)?|검색해줘|검색해주세요)$/u);
  if (search) {
    const keyword = cleanOperand(quotedSearch ? search[2] : search[1]);
    const orderLabel = quotedSearch ? search[3] : search[2];
    const limitValue = Number(quotedSearch ? search[4] : search[3]);
    const order = orderLabel?.replace(/\s+/g, '').startsWith('끝') ? 'last'
      : orderLabel ? 'first' : null;
    const limit = Number.isInteger(limitValue) && limitValue > 0 ? limitValue : null;
    if (keyword) {
      return {
        answer: `'${keyword}' 문구를 정확한 문서 검색으로 찾습니다.`,
        intent: 'search',
        action: { type: 'search', keyword, ...(limit ? { limit, order } : {}) }
      };
    }
  }

  return null;
}
