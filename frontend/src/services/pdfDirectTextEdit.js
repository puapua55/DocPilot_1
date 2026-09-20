import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFRef,
  PDFStream, PDFString, decodePDFRawStream, degrees, rgb
} from 'pdf-lib';
import { analyzePdfFont } from './pdfFontAnalysis.js';

// Match complete horizontal text runs by decoded text AND geometry. Native
// moves reuse the original encoded bytes and font resources without reshaping.
const WHITE = /[\x00\t\n\f\r ]/;
const DELIMITER = /[\x00\t\n\f\r ()<>\[\]{}/%]/;
const IDENTITY = [1, 0, 0, 1, 0, 0];
// Temporary test switch. Set to false to restore the previous conservative
// duplicate/geometry/conflict checks without reverting the rest of the code.
export const EXPERIMENTAL_UNSAFE_DIRECT_EDIT = true;
const name = (value) => PDFName.of(value);
const fail = (message) => { throw new Error(message); };
const close = (a, b) => Math.abs(a - b) <= 0.02;
const binaryString = (bytes) => {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return result;
};
const normalizeForDeleteMatch = (value) => String(value || '').replace(/\s+/g, '').trim();
function glyphPathToSvg(path) {
  const number = (value) => Number(value.toFixed(3));
  return path.commands.map(({ command, args }) => {
    if (command === 'moveTo') return `M ${number(args[0])} ${number(-args[1])}`;
    if (command === 'lineTo') return `L ${number(args[0])} ${number(-args[1])}`;
    if (command === 'quadraticCurveTo') return `Q ${number(args[0])} ${number(-args[1])} ${number(args[2])} ${number(-args[3])}`;
    if (command === 'bezierCurveTo') return `C ${number(args[0])} ${number(-args[1])} ${number(args[2])} ${number(-args[3])} ${number(args[4])} ${number(-args[5])}`;
    return command === 'closePath' ? 'Z' : '';
  }).join(' ');
}

function drawBoldGlyphOutlines(page, font, text, x, y, size, color, bold) {
  if (!bold || !font?.layout || !font.unitsPerEm) return;
  const scale = size / font.unitsPerEm;
  const layout = font.layout(text);
  let cursorX = x;
  let cursorY = y;
  const borderWidth = Math.max(0.35, size * 0.025);
  layout.glyphs.forEach((glyph, index) => {
    const position = layout.positions[index];
    const path = glyphPathToSvg(glyph.path);
    if (path) page.drawSvgPath(path, {
      x: cursorX + position.xOffset * scale,
      y: cursorY + position.yOffset * scale,
      scale,
      color,
      borderColor: color,
      borderWidth
    });
    cursorX += position.xAdvance * scale;
    cursorY += position.yAdvance * scale;
  });
}
function sourceFillColor(fill, fallback) {
  const parts = String(fill || '').match(/[+-]?(?:\d+\.?\d*|\.\d+)/g)?.map(Number) || [];
  if (parts.length >= 3 && /\brg$/.test(String(fill))) return rgb(parts[0], parts[1], parts[2]);
  if (parts.length >= 1 && /\bg$/.test(String(fill))) return rgb(parts[0], parts[0], parts[0]);
  if (parts.length >= 4 && /\bk$/.test(String(fill))) {
    const [c, m, y, k] = parts;
    return rgb(1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k));
  }
  return fallback;
}

function sourceFillChannels(fill) {
  const parts = String(fill || '').match(/[+-]?(?:\d+\.?\d*|\.\d+)/g)?.map(Number) || [];
  const toChannel = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  if (parts.length >= 3 && /\brg$/.test(String(fill))) return parts.slice(0, 3).map(toChannel);
  if (parts.length >= 1 && /\bg$/.test(String(fill))) {
    const channel = toChannel(parts[0]);
    return [channel, channel, channel];
  }
  if (parts.length >= 4 && /\bk$/.test(String(fill))) {
    const [c, m, y, k] = parts;
    return [toChannel(1 - Math.min(1, c + k)), toChannel(1 - Math.min(1, m + k)), toChannel(1 - Math.min(1, y + k))];
  }
  return null;
}

function makeOriginalFontCommand(candidate, encodedText) {
  const values = candidate.matrix.map((value) => Number(value.toFixed(8))).join(' ');
  const hex = [...encodedText].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return [
    'q', `${candidate.ctm.join(' ')} cm`, candidate.fill, 'BT',
    '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr',
    `${name(candidate.fontInfo.resourceName)} ${candidate.fontSize} Tf`,
    `${values} Tm`, `<${hex}> Tj`, 'ET', 'Q'
  ].join('\n');
}

// The source string is a deletion key, whereas displayText is what is drawn
// at the new position. They may differ only by layout spaces.
function deleteMatchTexts(item) {
  return [...new Set([
    item.sourceText, item.originalText, item.sourceSelection?.selectedText,
    item.sourceSelection?.wholeItem === true ? item.sourceSelection.text : null,
    item.originalUnicodeText, item.text, item.displayText
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function matchesDeleteText(candidateText, expectedTexts) {
  const normalizedCandidate = normalizeForDeleteMatch(candidateText);
  return expectedTexts.some((expected) => candidateText === expected
    || normalizedCandidate === normalizeForDeleteMatch(expected));
}

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

function analyzePage(page, unsafe = false) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  if (!unsafe && (page.getRotation().angle !== 0 || media.x !== 0 || media.y !== 0
    || ['x', 'y', 'width', 'height'].some((key) => crop[key] !== media[key])
    || page.node.has(name('UserUnit')))) fail('회전/크롭된 페이지는 overlay로 저장합니다.');
  const context = page.doc.context;
  const original = page.node.get(name('Contents'));
  const contents = context.lookup(original);
  const entries = contents instanceof PDFArray ? contents.asArray() : [original];
  const retired = [original, ...entries].filter((entry) => entry instanceof PDFRef);
  const source = entries.map((entry) => {
    const stream = context.lookup(entry);
    if (!(stream instanceof PDFRawStream)) fail('원본 PDF 스트림을 해석할 수 없습니다.');
    const bytes = decodePDFRawStream(stream).decode();
    if (!unsafe && bytes.length > 4 * 1024 * 1024) fail('큰 콘텐츠 스트림은 overlay로 저장합니다.');
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
    W: 0, 'W*': 0, G: 1, g: 1, RG: 3, rg: 3, K: 4, k: 4 }));
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
      block = { start: token.start, matrix: [...IDENTITY], line: [...IDENTITY], shows: [] };
    } else if (op === 'ET') {
      numbers(0); if (!block) fail('잘못된 텍스트 객체입니다.');
      if (block.shows.length > 1) fail('여러 출력 명령이 연결된 텍스트 객체는 overlay로 저장합니다.');
      if (block.shows.length === 1 && block.shows[0]) {
        candidates.push({ ...block.shows[0], objectStart: block.start, objectEnd: token.end,
          fullText: block.shows[0].text });
      }
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
        && Math.abs(transform[0]) > 0 && Math.abs(transform[3]) > 0
        && close(transform[1], 0) && close(transform[2], 0);
      if (!supported) fail('해석 가능한 단순 가로 텍스트만 직접 이동할 수 있습니다.');
      const { decode, ...fontInfo } = font;
      block.shows.push({ text: decoded, transform, matrix: [...block.matrix], ctm: [...state.ctm],
        fontInfo, fontSize: state.size, fill: state.fill, start: operands[0].start, end: token.end });
      // A second show in this BT/ET invalidates the entire candidate: deleting
      // the first could otherwise change the text advance of later glyphs.
    } else if (op === 'Do') {
      // Image/form XObjects often provide a page background. They do not alter
      // text state, so preserve the command while continuing to inspect later
      // text runs on the same page.
      if (block || operands.length !== 1 || operands[0].type !== 'name') {
        fail('지원하지 않는 XObject 명령입니다.');
      }
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

function findPartialGlyphRun(analysis, item, page, unsafe = false) {
  const targets = deleteMatchTexts(item);
  // PDF.js can merge individual stream glyph commands into one text item.
  // For a UI Unicode move, use its exact selection rectangle to match that
  // contiguous glyph run even when the selection covers the whole item.
  if (!targets.length || (!item.sourceSelection?.partialSelection && !item.forceUnicodeFallback)) return null;
  const scaleX = item.sourcePageWidth / page.getWidth();
  const scaleY = item.sourcePageHeight / page.getHeight();
  // PDF.js DOM ranges and decoded PDF glyph transforms can differ by a few
  // pixels at the first/last glyph. A selection that starts exactly at the
  // first visible character must not require the user to include the space
  // before it just to widen this search window.
  const tolerance = Math.max(8, Number(item.fontSize || 0) * 0.35, Number(item.coverHeight || 0) * 0.5);
  const left = item.coverX - tolerance;
  const right = item.coverX + item.coverWidth + tolerance;
  const top = item.coverY - tolerance;
  // PDF.js may synthesize word spaces from glyph positions while the content
  // stream contains only the visible glyphs. Geometry still identifies the
  // selection, so compare runs with layout-only whitespace removed.
  const matches = [];
  for (const target of targets) {
    const normalizedTarget = normalizeForDeleteMatch(target);
    for (let start = 0; start < analysis.candidates.length; start++) {
      const first = analysis.candidates[start];
      const firstX = first.transform[4] * scaleX;
      const firstTop = (page.getHeight() - first.transform[5] - first.transform[3]) * scaleY;
      if (firstX < left || firstX > right || Math.abs(firstTop - item.coverY) > tolerance) continue;
      let text = '';
      const run = [];
      for (let index = start; index < analysis.candidates.length; index++) {
        const candidate = analysis.candidates[index];
        const candidateX = candidate.transform[4] * scaleX;
        const candidateTop = (page.getHeight() - candidate.transform[5] - candidate.transform[3]) * scaleY;
        if (Math.abs(candidateTop - item.coverY) > tolerance || candidateX > right) break;
        const next = text + candidate.text;
        const normalizedNext = normalizeForDeleteMatch(next);
        if (!normalizedTarget.startsWith(normalizedNext)) break;
        text = next;
        run.push(candidate);
        if (normalizedNext === normalizedTarget) {
          matches.push(run);
          break;
        }
      }
    }
  }
  const unique = [...new Map(matches.map((run) => [run.map((candidate) => candidate.start).join(','), run])).values()];
  return unique.length === 1 || (unsafe && unique.length > 0) ? unique[0] : null;
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

// Replace a selected PDF text item without painting a cover rectangle. The
// original command is removed from the page content stream and the new text is
// inserted as a normal PDF text command at the original baseline. We only
// accept a unique, simple horizontal text item; every other case is reported
// to the caller so the existing cover-overlay path can take over.
export function replacePdfTextInContentStream(pdfDocument, replacements, replacementFont, replacementOutlineFont) {
  const outcomes = new Map();
  const retired = [];
  for (const [pageIndex, page] of pdfDocument.getPages().entries()) {
    const items = replacements.filter((item) => item.type === 'pdf' && item.pageNumber === pageIndex + 1);
    if (!items.length) continue;
    try {
      const analysis = analyzePage(page, EXPERIMENTAL_UNSAFE_DIRECT_EDIT);
      const used = new Set();
      const edits = [];
      items.forEach((item) => {
        const target = String(item.sourceText || item.keyword || item.originalText || '').trim();
        const fullHint = String(item.sourceFullText || '').trim();
        const normalizedTarget = normalizeForDeleteMatch(target);
        const candidates = analysis.candidates.filter((candidate) => {
          if (used.has(candidate)) return false;
        // Text-layer searches can return the same string many times. When the
        // UI supplied a rectangle, use it as a second identity key so only
        // the selected occurrence is eligible for direct editing.
        if (Number.isFinite(Number(item.coverX)) && Number.isFinite(Number(item.coverY))
          && Number(item.sourcePageWidth) > 0 && Number(item.sourcePageHeight) > 0) {
          const expectedX = Number(item.coverX) * page.getWidth() / Number(item.sourcePageWidth);
          const expectedY = page.getHeight() - (Number(item.coverY) + Number(item.coverHeight || 0))
            * page.getHeight() / Number(item.sourcePageHeight);
          if (Math.abs(candidate.transform[4] - expectedX) > 8
            || Math.abs(candidate.transform[5] - expectedY) > 12) return false;
        }
        if (candidate.text === target || normalizeForDeleteMatch(candidate.text) === normalizedTarget) return true;
          return normalizedTarget && normalizeForDeleteMatch(candidate.text).includes(normalizedTarget);
        });
        let matched = candidates.length === 1 ? [candidates[0]] : null;
        // Some PDFs emit one glyph per BT/ET object. Join only adjacent,
        // horizontal candidates on the selected line and use the source
        // rectangle as the identity key. This handles NEW.pdf without
        // changing unrelated repeated text elsewhere on the page.
        if (!matched && normalizedTarget) {
          const ordered = analysis.candidates.filter((candidate) => !used.has(candidate));
          for (let start = 0; start < ordered.length && !matched; start += 1) {
            let value = '';
            const run = [];
            for (let index = start; index < ordered.length; index += 1) {
              const candidate = ordered[index];
              if (run.length && (Math.abs(candidate.transform[5] - run[0].transform[5]) > 8
                || candidate.transform[4] < run[run.length - 1].transform[4] - 2)) break;
              const next = value + candidate.text;
              const normalizedNext = normalizeForDeleteMatch(next);
              if (!normalizedTarget.startsWith(normalizedNext)) break;
              value = next;
              run.push(candidate);
              if (normalizedNext === normalizedTarget) {
                const expectedX = Number.isFinite(Number(item.coverX))
                  ? Number(item.coverX) * page.getWidth() / Number(item.sourcePageWidth) : null;
                if (expectedX == null || Math.abs(run[0].transform[4] - expectedX) <= 12) matched = run;
                break;
              }
            }
          }
        }
        // A complete source hint can identify a text run, but a partial
        // replacement must never cause the other characters in that run to
        // be redrawn with the fallback font.
        if (fullHint && normalizedTarget) {
          if (normalizeForDeleteMatch(fullHint) !== normalizedTarget) matched = null;
          const ordered = analysis.candidates.filter((candidate) => !used.has(candidate));
          for (let start = 0; start < ordered.length && !matched; start += 1) {
            let value = '';
            const run = [];
            for (let index = start; index < ordered.length; index += 1) {
              const candidate = ordered[index];
              if (run.length && (Math.abs(candidate.transform[5] - run[0].transform[5]) > 8
                || candidate.transform[4] < run[run.length - 1].transform[4] - 2)) break;
              value += candidate.text;
              run.push(candidate);
              if (normalizeForDeleteMatch(value) === normalizeForDeleteMatch(fullHint)) {
                const expectedX = Number.isFinite(Number(item.coverX))
                  ? Number(item.coverX) * page.getWidth() / Number(item.sourcePageWidth) : null;
                if (expectedX == null || Math.abs(run[0].transform[4] - expectedX) <= 12) matched = run;
                break;
              }
            }
          }
        }
        if (!matched) {
          outcomes.set(item, { direct: false, reason: candidates.length
            ? '동일한 원본 text object를 유일하게 식별할 수 없어 overlay로 저장했습니다.'
            : '원본 text object를 content stream에서 찾지 못해 overlay로 저장했습니다.' });
          return;
        }
        const candidate = matched[0];
        matched.forEach((entry) => used.add(entry));
        const sourceFullText = matched.map((entry) => entry.text).join('');
        const isFullObject = normalizeForDeleteMatch(sourceFullText) === normalizedTarget;
        if (!isFullObject) {
          outcomes.set(item, {
            direct: false,
            reason: '선택 범위 밖 텍스트를 변경하지 않기 위해 부분 text object는 선택 영역 fallback으로 저장했습니다.',
            textColor: sourceFillChannels(candidate.fill)
          });
          return;
        }
        const nextText = String(item.replacementText || item.newText || '');
        if (!nextText) {
          outcomes.set(item, { direct: false, reason: '교체 텍스트 글꼴을 준비하지 못해 overlay로 저장했습니다.' });
          return;
        }
        let originalEncodedText = null;
        let originalFontReusable = false;
        try {
          if (item.forceUnicodeFallback !== true && matched.length === 1 && typeof candidate.fontInfo.encode === 'function') {
            originalEncodedText = candidate.fontInfo.encode(nextText);
            originalFontReusable = true;
          }
        } catch {
          originalEncodedText = null;
        }
        if (!originalFontReusable && !replacementFont) {
          outcomes.set(item, { direct: false, reason: '원본 글꼴에 새 문자의 glyph mapping이 없고 fallback 글꼴도 준비하지 못해 overlay로 저장했습니다.' });
          return;
        }
        edits.push({ item, candidate, candidates: matched, nextText,
          mode: 'direct-replace', originalEncodedText, originalFontReusable });
      });
      if (!edits.length) continue;
      let rewritten = analysis.source;
      edits.sort((a, b) => b.candidate.objectStart - a.candidate.objectStart).forEach(({ candidates: matchedCandidates }) => {
        matchedCandidates.slice().sort((a, b) => b.objectStart - a.objectStart).forEach((candidate) => {
          rewritten = rewritten.slice(0, candidate.objectStart) + rewritten.slice(candidate.objectEnd);
        });
      });
      const stream = pdfDocument.context.flateStream(Uint8Array.from(rewritten, (char) => char.charCodeAt(0)));
      page.node.set(name('Contents'), pdfDocument.context.register(stream));
      retired.push(...analysis.retired);
      edits.forEach(({ item, candidate, candidates: matchedCandidates, nextText, mode, originalEncodedText, originalFontReusable }) => {
        const commandRange = {
          start: Math.min(...matchedCandidates.map((entry) => entry.objectStart)),
          end: Math.max(...matchedCandidates.map((entry) => entry.objectEnd))
        };
        if (originalFontReusable) {
          outcomes.set(item, { direct: true, directReplacement: true, replaceMode: mode,
            sourceFullText: matchedCandidates.map((entry) => entry.text).join(''), newFullText: nextText,
            commandRange, deletedCommandCount: matchedCandidates.length,
            fontPreserved: true, canReuseOriginalFont: true,
            drawingCommands: makeOriginalFontCommand(candidate, originalEncodedText), reason: null });
          return;
        }
        // DOM font metrics can be reduced by PDF.js's text-layer width
        // correction. The content-stream transform is the authoritative
        // rendered size for a rewritten object.
        const pageScaleX = Number(item.sourcePageWidth) > 0 ? page.getWidth() / Number(item.sourcePageWidth) : 1;
        const pageScaleY = Number(item.sourcePageHeight) > 0 ? page.getHeight() / Number(item.sourcePageHeight) : 1;
        const fontSize = (Number(item.fontSize) || Math.abs(candidate.transform[3]) || candidate.fontSize) * pageScaleY;
        const x = Number.isFinite(Number(item.textX)) ? Number(item.textX) * pageScaleX : candidate.transform[4];
        const baseline = Number.isFinite(Number(item.baseline))
          ? Number(item.baseline) * pageScaleY
          : Number.isFinite(Number(item.textY)) ? (Number(item.textY) + Number(item.fontSize) * 0.84) * pageScaleY : null;
        const pageHeight = page.getHeight();
        const y = baseline != null
          ? pageHeight - baseline
          : candidate.transform[5] - candidate.transform[3];
        const sampledColor = Array.isArray(item.textColor) && item.textColor.length >= 3
          ? rgb(item.textColor[0] / 255, item.textColor[1] / 255, item.textColor[2] / 255)
          : undefined;
        const textColor = sourceFillColor(candidate.fill, sampledColor);
        const italic = item.fontStyle === 'italic';
        page.drawText(nextText, {
          x, y, size: fontSize, font: replacementFont, color: textColor,
          xSkew: italic ? degrees(-12) : degrees(0)
        });
        drawBoldGlyphOutlines(page, replacementOutlineFont, nextText, x, y, fontSize, textColor,
          item.fontWeight === 'bold' || /bold|black|heavy/i.test(String(candidate.fontInfo?.baseFont || '')));
        if (item.textDecoration === 'underline' || item.textDecoration === 'line-through') {
          const measuredWidth = replacementFont.widthOfTextAtSize(nextText, fontSize);
          const lineY = item.textDecoration === 'underline'
            ? y - fontSize * 0.1
            : y + fontSize * 0.35;
          page.drawLine({
            start: { x, y: lineY },
            end: { x: x + measuredWidth, y: lineY },
            thickness: Math.max(1, fontSize * 0.06),
            color: textColor
          });
        }
        outcomes.set(item, { direct: true, directReplacement: true, replaceMode: mode,
          sourceFullText: matchedCandidates.map((entry) => entry.text).join(''), newFullText: nextText,
          commandRange, deletedCommandCount: matchedCandidates.length,
          fontPreserved: false, canReuseOriginalFont: false, reason: null });
      });
    } catch (error) {
      items.forEach((item) => outcomes.set(item, { direct: false,
        reason: error.message || '원본 content stream 분석 실패로 overlay를 사용했습니다.' }));
    }
  }
  if (retired.length) discardRetiredStreams(pdfDocument.context, retired);
  return outcomes;
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
        const matchTexts = deleteMatchTexts(item);
        let reason = '한 텍스트 덩어리 전체를 선택해야 직접 제거할 수 있습니다.';
        if (preserveFont && item.forceUnicodeFallback === true) {
          outcomes.set(item, {
            direct: false,
            fontPreserved: false,
            canReuseOriginalFont: false,
            sourceFont: null,
            reason: '선택 텍스트의 Unicode 정확성을 위해 NotoSansKR overlay를 사용합니다.'
          });
          continue;
        }
        if (evidence?.wholeItem === true && matchTexts.length && Array.isArray(evidence.transform)
          && evidence.transform.length === 6 && evidence.transform.every(Number.isFinite)) {
          const found = analysis.candidates.filter((candidate) => matchesDeleteText(candidate.text, matchTexts)
            && candidate.transform.every((value, index) => close(value, evidence.transform[index])));
          reason = '원본 문자열과 위치를 유일하게 확인할 수 없어 overlay로 저장했습니다.';
          if (found.length === 1 || (EXPERIMENTAL_UNSAFE_DIRECT_EDIT && found.length > 0)) {
            const selectedCandidate = found[0];
            // PdfTextLayer keeps a rendered glyph preview for the browser.
            // That preview is not a safe source for replaying PDF bytes: a
            // PDF.js glyph mapping can look correct on screen while the
            // original encoded stream drops selected glyphs after saving.
            // Movable objects carrying that preview must use their Unicode
            // displayText in the fallback overlay instead.
            if (!EXPERIMENTAL_UNSAFE_DIRECT_EDIT && preserveFont && (item.originalGlyphText || item.sourceFont?.glyphText)) {
              outcomes.set(item, {
                direct: false,
                fontPreserved: false,
                canReuseOriginalFont: false,
                sourceFont: found[0].fontInfo,
                reason: 'PDF.js glyph mapping이 안전하지 않아 displayText Unicode overlay를 사용합니다.'
              });
              continue;
            }
            // Subset fonts can render correctly in PDF.js while their raw
            // encoded glyph stream is not portable when replayed after a
            // move. Prefer the Unicode overlay for these resources so the
            // downloaded PDF cannot silently lose individual glyphs.
            if (!EXPERIMENTAL_UNSAFE_DIRECT_EDIT && preserveFont && found[0].fontInfo.subset) {
              reason = 'subset 글꼴의 glyph 재사용이 안전하지 않아 Unicode overlay를 사용합니다.';
              outcomes.set(item, {
                direct: false,
                fontPreserved: false,
                canReuseOriginalFont: false,
                sourceFont: found[0].fontInfo,
                reason
              });
              continue;
            }
            // Adjacent PDF text selection rectangles commonly overlap because
            // DOM line boxes include ascent/descent padding. Movable objects
            // are safe to plan together; the command ownership check below
            // rejects only an actual shared content-stream command.
            const conflict = !EXPERIMENTAL_UNSAFE_DIRECT_EDIT && replacements.some((other) => other !== item && other.pageNumber === item.pageNumber
              && other.type !== 'movable-text' && intersects(item, other));
            if (!conflict) { matches.set(item, [found[0]]); continue; }
            reason = '겹치는 이동/교체 영역은 overlay로 저장했습니다.';
          }
        }
        const partialRun = findPartialGlyphRun(analysis, item, page, EXPERIMENTAL_UNSAFE_DIRECT_EDIT);
        if (partialRun) {
          const conflict = !EXPERIMENTAL_UNSAFE_DIRECT_EDIT && replacements.some((other) => other !== item && other.pageNumber === item.pageNumber
            && other.type !== 'movable-text' && intersects(item, other));
          if (!conflict) { matches.set(item, partialRun); continue; }
          reason = '겹치는 이동/교체 영역은 overlay로 저장했습니다.';
        }
        outcomes.set(item, {
          direct: false,
          fontPreserved: false,
          canReuseOriginalFont: false,
          sourceFont: null,
          reason: `${reason} (삭제 키: ${matchTexts[0] ? '원본 텍스트' : '없음'})`
        });
      }
      const counts = new Map();
      matches.forEach((candidates) => candidates.forEach((candidate) => counts.set(candidate, (counts.get(candidate) || 0) + 1)));
      const edits = [];
      matches.forEach((candidates, item) => {
        if (!EXPERIMENTAL_UNSAFE_DIRECT_EDIT && candidates.some((candidate) => counts.get(candidate) !== 1)) outcomes.set(item, {
          direct: false,
          fontPreserved: false,
          canReuseOriginalFont: false,
          sourceFont: null,
          reason: '같은 원본을 여러 번 선택하여 overlay로 저장했습니다.'
        });
        else edits.push({ candidates, item });
      });
      if (!edits.length) continue;
      let rewritten = analysis.source;
      const drawingCommands = new Map();
      edits.flatMap(({ candidates, item }) => candidates.map((candidate) => ({ candidate, item, candidates })))
        .sort((a, b) => b.candidate.start - a.candidate.start).forEach(({ candidate, item, candidates }) => {
        if (preserveFont) {
          if (candidates.length !== 1) fail('여러 glyph로 분리된 텍스트는 원본 글꼴 재삽입 없이 overlay로 저장합니다.');
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
      edits.forEach(({ item, candidates }) => outcomes.set(item, {
        direct: true,
        directRemoval: true,
        deleteMode: candidates.length === 1 && !item.sourceSelection?.partialSelection
          ? 'full-object'
          : item.sourceSelection?.partialSelection ? 'partial-string' : 'range-group',
        deletedCommandCount: candidates.length,
        commandRange: { start: Math.min(...candidates.map((candidate) => candidate.start)), end: Math.max(...candidates.map((candidate) => candidate.end)) },
        reason: preserveFont ? null : '원본 텍스트를 content stream에서 제거하고 Unicode overlay를 삽입합니다.',
        fontPreserved: preserveFont,
        canReuseOriginalFont: candidates[0].fontInfo.canReuseOriginalFont === true,
        sourceFont: candidates[0].fontInfo,
        drawingCommands: drawingCommands.get(item)
      }));
    } catch (error) {
      moves.forEach((item) => outcomes.set(item, {
        direct: false,
        fontPreserved: false,
        canReuseOriginalFont: false,
        sourceFont: null,
        reason: error.message || '원본 분석 실패로 overlay를 사용했습니다.'
      }));
    }
  }
  if (retired.length) discardRetiredStreams(pdfDocument.context, retired);
  return outcomes;
}
