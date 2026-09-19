import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFRef,
  PDFStream, PDFString, decodePDFRawStream
} from 'pdf-lib';
import { analyzePdfFont } from './pdfFontAnalysis.js';

// Match complete horizontal text runs by decoded text AND geometry. Native
// moves reuse the original encoded bytes and font resources without reshaping.
const WHITE = /[\x00\t\n\f\r ]/;
const DELIMITER = /[\x00\t\n\f\r ()<>\[\]{}/%]/;
const IDENTITY = [1, 0, 0, 1, 0, 0];
const name = (value) => PDFName.of(value);
const fail = (message) => { throw new Error(message); };
const close = (a, b) => Math.abs(a - b) <= 0.02;
const binaryString = (bytes) => {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return result;
};

// Tokenize strings/arrays/comments instead of regex-replacing stream text.
// In particular, operator-like text inside a string must remain data.
function tokenize(source) {
  const tokens = [];
  let i = 0;
  const read = (depth = 0) => {
    if (depth > 8) fail('중첩된 PDF 배열은 지원하지 않습니다.');
    while (i < source.length) {
      if (WHITE.test(source[i])) { i++; continue; }
      if (source[i] === '%') {
        while (i < source.length && !/[\r\n]/.test(source[i])) i++;
        continue;
      }
      break;
    }
    if (i >= source.length) return null;
    const start = i;
    const char = source[i++];
    if (char === '(') {
      let nesting = 1;
      while (i < source.length && nesting) {
        const next = source[i++];
        if (next === '\\') { i++; continue; }
        if (next === '(') nesting++;
        if (next === ')') nesting--;
      }
      if (nesting) fail('닫히지 않은 PDF 문자열입니다.');
      return { type: 'string', value: binaryString(PDFString.of(source.slice(start + 1, i - 1)).asBytes()), start, end: i };
    }
    if (char === '<') {
      const end = source.indexOf('>', i);
      if (end < 0 || source[i] === '<') fail('PDF 사전/특수 콘텐츠는 지원하지 않습니다.');
      const hex = source.slice(i, end).replace(/[\x00\t\n\f\r ]/g, '');
      if (!/^[\da-f]*$/i.test(hex)) fail('잘못된 PDF 문자열입니다.');
      i = end + 1;
      return { type: 'string', value: binaryString(PDFHexString.of(hex).asBytes()), start, end: i };
    }
    if (char === '[') {
      const value = [];
      while (true) {
        const token = read(depth + 1);
        if (!token) fail('닫히지 않은 PDF 배열입니다.');
        if (token.type === 'endArray') break;
        value.push(token);
      }
      return { type: 'array', value, start, end: i };
    }
    if (char === ']') return { type: 'endArray', start, end: i };
    if (char === '/') {
      while (i < source.length && !DELIMITER.test(source[i])) i++;
      return { type: 'name', value: source.slice(start + 1, i).replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), start, end: i };
    }
    if (DELIMITER.test(char)) fail('지원하지 않는 PDF 구문입니다.');
    while (i < source.length && !DELIMITER.test(source[i])) i++;
    const value = source.slice(start, i);
    return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)
      ? { type: 'number', value: Number(value), start, end: i }
      : { type: 'operator', value, start, end: i };
  };
  let token;
  while ((token = read())) {
    tokens.push(token);
    // Inline image bytes are not PDF tokens; stop before interpreting them.
    if (token.type === 'operator' && token.value === 'BI') fail('인라인 이미지는 overlay로 저장합니다.');
  }
  return tokens;
}

function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function analyzePage(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  if (page.getRotation().angle !== 0 || media.x !== 0 || media.y !== 0
    || ['x', 'y', 'width', 'height'].some((key) => crop[key] !== media[key])
    || page.node.has(name('UserUnit'))) fail('회전/크롭된 페이지는 overlay로 저장합니다.');
  const context = page.doc.context;
  const original = page.node.get(name('Contents'));
  const contents = context.lookup(original);
  const entries = contents instanceof PDFArray ? contents.asArray() : [original];
  const retired = [original, ...entries].filter((entry) => entry instanceof PDFRef);
  const source = entries.map((entry) => {
    const stream = context.lookup(entry);
    if (!(stream instanceof PDFRawStream)) fail('원본 PDF 스트림을 해석할 수 없습니다.');
    const bytes = decodePDFRawStream(stream).decode();
    if (bytes.length > 4 * 1024 * 1024) fail('큰 콘텐츠 스트림은 overlay로 저장합니다.');
    return binaryString(bytes);
  }).join('\n');
  const candidates = [];
  const fontCache = new Map();
  let state = { ctm: IDENTITY, font: '', size: 0, spacing: 0, wordSpacing: 0, hscale: 100, rise: 0, render: 0, leading: 0, fill: '0 g' };
  const stack = [];
  let block = null;
  let operands = [];
  const numbers = (count) => {
    if (operands.length !== count || operands.some((token) => token.type !== 'number' || !Number.isFinite(token.value))) fail('잘못된 PDF 피연산자입니다.');
    return operands.map((token) => token.value);
  };
  const graphics = new Map(Object.entries({ w: 1, J: 1, j: 1, M: 1, m: 2, l: 2, c: 6, v: 4, y: 4,
    h: 0, re: 4, S: 0, s: 0, f: 0, F: 0, 'f*': 0, B: 0, 'B*': 0, b: 0, 'b*': 0, n: 0,
    G: 1, g: 1, RG: 3, rg: 3, K: 4, k: 4 }));
  for (const token of tokenize(source)) {
    if (token.type !== 'operator') { operands.push(token); continue; }
    const op = token.value;
    if (op === 'q') {
      numbers(0); if (block) fail('복잡한 텍스트 상태입니다.');
      stack.push({ ...state });
    } else if (op === 'Q') {
      numbers(0); if (block || !stack.length) fail('잘못된 그래픽 상태입니다.');
      state = stack.pop();
    } else if (op === 'cm') {
      if (block) fail('복잡한 텍스트 변환입니다.');
      state.ctm = multiply(state.ctm, numbers(6));
    } else if (op === 'BT') {
      numbers(0); if (block) fail('중첩 텍스트 객체입니다.');
      block = { matrix: [...IDENTITY], line: [...IDENTITY], shows: [] };
    } else if (op === 'ET') {
      numbers(0); if (!block) fail('잘못된 텍스트 객체입니다.');
      if (block.shows.length > 1) fail('여러 출력 명령이 연결된 텍스트 객체는 overlay로 저장합니다.');
      if (block.shows.length === 1 && block.shows[0]) candidates.push(block.shows[0]);
      block = null;
    } else if (op === 'Tf') {
      if (operands.length !== 2 || operands[0].type !== 'name' || operands[1].type !== 'number') fail('잘못된 글꼴 상태입니다.');
      state.font = operands[0].value; state.size = operands[1].value;
    } else if (['Tc', 'Tw', 'Tz', 'Ts', 'Tr', 'TL'].includes(op)) {
      state[{ Tc: 'spacing', Tw: 'wordSpacing', Tz: 'hscale', Ts: 'rise', Tr: 'render', TL: 'leading' }[op]] = numbers(1)[0];
    } else if (['Tm', 'Td', 'TD', 'T*'].includes(op)) {
      if (!block) fail('텍스트 객체 밖의 위치 명령입니다.');
      if (op === 'Tm') block.line = numbers(6);
      else {
        const [x, y] = op === 'T*' ? (numbers(0), [0, -state.leading]) : numbers(2);
        if (op === 'TD') state.leading = -y;
        block.line = multiply(block.line, [1, 0, 0, 1, x, y]);
      }
      block.matrix = [...block.line];
    } else if (op === 'Tj' || op === 'TJ') {
      if (!block || operands.length !== 1) fail('잘못된 텍스트 출력 명령입니다.');
      let value = null;
      if (op === 'Tj' && operands[0].type === 'string') value = operands[0].value;
      if (op === 'TJ' && operands[0].type === 'array') {
        const parts = operands[0].value;
        if (parts.every((part) => part.type === 'string' || (part.type === 'number' && part.value === 0))) {
          value = parts.filter((part) => part.type === 'string').map((part) => part.value).join('');
        }
      }
      const transform = multiply(state.ctm, multiply(block.matrix, [state.size, 0, 0, state.size, 0, 0]));
      if (!fontCache.has(state.font)) fontCache.set(state.font, analyzePdfFont(page, state.font));
      const font = fontCache.get(state.font);
      const decoded = value === null ? null : font.decode(value);
      const supported = decoded
        && state.spacing === 0 && state.wordSpacing === 0 && state.hscale === 100 && state.rise === 0 && state.render === 0
        && transform[0] > 0 && transform[3] > 0 && close(transform[1], 0) && close(transform[2], 0);
      if (!supported) fail('해석 가능한 단순 가로 텍스트만 직접 이동할 수 있습니다.');
      const { decode, ...fontInfo } = font;
      block.shows.push({ text: decoded, transform, matrix: [...block.matrix], ctm: [...state.ctm],
        fontInfo, fontSize: state.size, fill: state.fill, start: operands[0].start, end: token.end });
      // A second show in this BT/ET invalidates the entire candidate: deleting
      // the first could otherwise change the text advance of later glyphs.
    } else if (graphics.has(op)) {
      if (block && !['G', 'g', 'RG', 'rg', 'K', 'k'].includes(op)) fail('텍스트 객체 내부 그래픽은 overlay로 저장합니다.');
      numbers(graphics.get(op));
      if (['g', 'rg', 'k'].includes(op)) state.fill = `${operands.map((part) => part.value).join(' ')} ${op}`;
    } else if (op === 'd') {
      if (block || operands.length !== 2 || operands[0].type !== 'array' || operands[1].type !== 'number'
        || operands[0].value.some((part) => part.type !== 'number')) fail('잘못된 선 스타일입니다.');
    } else fail(`지원하지 않는 PDF 명령(${op})은 overlay로 저장합니다.`);
    operands = [];
  }
  if (operands.length || block || stack.length) fail('완성되지 않은 콘텐츠 스트림입니다.');
  return { source, candidates, retired };
}

function intersects(a, b) {
  const left = (item) => item.coverX / item.sourcePageWidth;
  const top = (item) => item.coverY / item.sourcePageHeight;
  return left(a) < left(b) + b.coverWidth / b.sourcePageWidth && left(b) < left(a) + a.coverWidth / a.sourcePageWidth
    && top(a) < top(b) + b.coverHeight / b.sourcePageHeight && top(b) < top(a) + a.coverHeight / a.sourcePageHeight;
}

// Remove only retired Contents objects that are no longer reachable. Streams
// shared by another page or a resource must remain intact for that consumer.
function discardRetiredStreams(context, retired) {
  const reachable = new Set();
  const visited = new Set();
  const pending = Object.values(context.trailerInfo);
  while (pending.length) {
    const object = pending.pop();
    if (!object || visited.has(object)) continue;
    visited.add(object);
    if (object instanceof PDFRef) { reachable.add(object); pending.push(context.lookup(object)); }
    else if (object instanceof PDFArray) pending.push(...object.asArray());
    else if (object instanceof PDFDict) pending.push(...object.values());
    else if (object instanceof PDFStream) pending.push(object.dict);
  }
  retired.forEach((ref) => { if (!reachable.has(ref)) context.delete(ref); });
}

export function removeSimpleMovedText(pdfDocument, replacements) {
  return editMovedText(pdfDocument, replacements, false);
}

export function moveTextWithOriginalFont(pdfDocument, replacements) {
  return editMovedText(pdfDocument, replacements, true);
}

function editMovedText(pdfDocument, replacements, preserveFont) {
  const outcomes = new Map();
  const retired = [];
  for (const [pageIndex, page] of pdfDocument.getPages().entries()) {
    const moves = replacements.filter((item) => item.type === 'movable-text' && item.pageNumber === pageIndex + 1);
    if (!moves.length) continue;
    try {
      const analysis = analyzePage(page);
      const matches = new Map();
      for (const item of moves) {
        const evidence = item.sourceSelection;
        let reason = '한 텍스트 덩어리 전체를 선택해야 직접 제거할 수 있습니다.';
        if (evidence?.wholeItem === true && evidence.text === item.text && Array.isArray(evidence.transform)
          && evidence.transform.length === 6 && evidence.transform.every(Number.isFinite)) {
          const found = analysis.candidates.filter((candidate) => candidate.text === evidence.text
            && candidate.transform.every((value, index) => close(value, evidence.transform[index])));
          reason = '원본 문자열과 위치를 유일하게 확인할 수 없어 overlay로 저장했습니다.';
          if (found.length === 1) {
            const conflict = replacements.some((other) => other !== item && other.pageNumber === item.pageNumber && intersects(item, other));
            if (!conflict) { matches.set(item, found[0]); continue; }
            reason = '겹치는 이동/교체 영역은 overlay로 저장했습니다.';
          }
        }
        outcomes.set(item, { direct: false, reason });
      }
      const counts = new Map();
      matches.forEach((candidate) => counts.set(candidate, (counts.get(candidate) || 0) + 1));
      const edits = [];
      matches.forEach((candidate, item) => {
        if (counts.get(candidate) !== 1) outcomes.set(item, { direct: false, reason: '같은 원본을 여러 번 선택하여 overlay로 저장했습니다.' });
        else edits.push({ candidate, item });
      });
      if (!edits.length) continue;
      let rewritten = analysis.source;
      const drawingCommands = new Map();
      edits.sort((a, b) => b.candidate.start - a.candidate.start).forEach(({ candidate, item }) => {
        if (preserveFont) {
          // The pointer delta is in displayed page coordinates (top-left).
          // Convert it to PDF coordinates, then through the inverse CTM.
          const dx = (item.textX - item.coverX) * page.getWidth() / item.sourcePageWidth;
          const dy = -(item.textY - item.coverY) * page.getHeight() / item.sourcePageHeight;
          const [a, b, c, d] = candidate.ctm;
          const determinant = a * d - b * c;
          if (![dx, dy, determinant].every(Number.isFinite) || Math.abs(determinant) < 1e-10) fail('이동 좌표를 확인할 수 없습니다.');
          const matrix = [...candidate.matrix];
          matrix[4] += (d * dx - c * dy) / determinant;
          matrix[5] += (-b * dx + a * dy) / determinant;
          const values = matrix.map((value) => Number(value.toFixed(8)).toString()).join(' ');
          drawingCommands.set(item, [
            'q', `${candidate.ctm.join(' ')} cm`, candidate.fill, 'BT',
            '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr',
            `${name(candidate.fontInfo.resourceName)} ${candidate.fontSize} Tf`,
            `${values} Tm`, analysis.source.slice(candidate.start, candidate.end), 'ET', 'Q'
          ].join('\n'));
        }
        rewritten = rewritten.slice(0, candidate.start) + rewritten.slice(candidate.end);
      });
      const stream = pdfDocument.context.flateStream(Uint8Array.from(rewritten, (char) => char.charCodeAt(0)));
      page.node.set(name('Contents'), pdfDocument.context.register(stream));
      retired.push(...analysis.retired);
      edits.forEach(({ item, candidate }) => outcomes.set(item, {
        direct: true, reason: null, fontPreserved: preserveFont, sourceFont: candidate.fontInfo
        , drawingCommands: drawingCommands.get(item)
      }));
    } catch (error) {
      moves.forEach((item) => outcomes.set(item, { direct: false, reason: error.message || '원본 분석 실패로 overlay를 사용했습니다.' }));
    }
  }
  if (retired.length) discardRetiredStreams(pdfDocument.context, retired);
  return outcomes;
}
