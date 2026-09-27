import { PDFArray, PDFDict, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';

const name = PDFName.of;
const STANDARD = new Set(Object.values(StandardFonts).filter((font) => !['Symbol', 'ZapfDingbats'].includes(font)));
const utf16 = new TextDecoder('utf-16be', { fatal: true });
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g) || [], (pair) => parseInt(pair, 16));
const unicode = (hex) => {
  if (!hex || hex.length % 4) throw new Error('잘못된 ToUnicode 문자열입니다.');
  return utf16.decode(hexBytes(hex));
};

// A bounded ToUnicode reader. CMap inheritance and variable-length character
// codes are intentionally rejected, never guessed from glyph IDs.
export function readToUnicode(stream, codeBytes) {
  if (!(stream instanceof PDFRawStream)) throw new Error('ToUnicode 매핑이 없습니다.');
  const bytes = decodePDFRawStream(stream).decode();
  if (bytes.length > 4 * 1024 * 1024) throw new Error('ToUnicode 매핑이 너무 큽니다.');
  const text = new TextDecoder('latin1').decode(bytes).replace(/%[^\r\n]*/g, '');
  if (/\busecmap\b/.test(text)) throw new Error('상속된 CMap은 아직 지원하지 않습니다.');
  const map = new Map();
  const sourceCode = (hex) => {
    if (hex.length !== codeBytes * 2) throw new Error('가변 길이 문자 코드는 아직 지원하지 않습니다.');
    return parseInt(hex, 16);
  };
  const put = (code, value) => {
    if (map.has(code) && map.get(code) !== value) throw new Error('중복된 문자 매핑입니다.');
    if (map.size >= 65536 && !map.has(code)) throw new Error('문자 매핑이 너무 큽니다.');
    map.set(code, value);
  };
  let sections = 0;
  for (const block of text.matchAll(/(\d+)\s+begin(bfchar|bfrange|codespacerange)\b([\s\S]*?)\bend\2\b/g)) {
    const [, countText, type, content] = block;
    const tokens = content.match(/<[\da-fA-F\s]+>|\[|\]/g) || [];
    if (content.replace(/<[\da-fA-F\s]+>|\[|\]/g, '').trim()) throw new Error('지원하지 않는 CMap 구문입니다.');
    let pos = 0;
    const nextHex = () => {
      const token = tokens[pos++];
      if (!token?.startsWith('<')) throw new Error('잘못된 CMap 항목입니다.');
      return token.slice(1, -1).replace(/\s/g, '').toUpperCase();
    };
    const count = Number(countText);
    if (count > 65536) throw new Error('CMap 항목이 너무 많습니다.');
    for (let row = 0; row < count; row++) {
      const first = sourceCode(nextHex());
      if (type === 'bfchar') { put(first, unicode(nextHex())); continue; }
      const last = sourceCode(nextHex());
      if (last < first || last - first > 65535) throw new Error('잘못된 CMap 범위입니다.');
      if (type === 'codespacerange') continue;
      if (tokens[pos] === '[') {
        pos++;
        for (let code = first; code <= last; code++) put(code, unicode(nextHex()));
        if (tokens[pos++] !== ']') throw new Error('잘못된 CMap 배열입니다.');
      } else {
        const start = nextHex();
        const base = BigInt(`0x${start}`);
        for (let code = first; code <= last; code++) {
          const hex = (base + BigInt(code - first)).toString(16).padStart(start.length, '0');
          if (hex.length !== start.length) throw new Error('CMap 범위를 벗어났습니다.');
          put(code, unicode(hex));
        }
      }
    }
    if (pos !== tokens.length) throw new Error('CMap 항목 수가 일치하지 않습니다.');
    if (type !== 'codespacerange') sections++;
  }
  if (!sections || !map.size) throw new Error('해석 가능한 ToUnicode 항목이 없습니다.');
  const decode = (binary) => {
    if (binary.length % codeBytes) throw new Error('문자 코드 길이가 일치하지 않습니다.');
    let value = '';
    for (let offset = 0; offset < binary.length; offset += codeBytes) {
      let code = 0;
      for (let i = 0; i < codeBytes; i++) code = code * 256 + binary.charCodeAt(offset + i);
      if (!map.has(code)) throw new Error('ToUnicode에서 원본 문자를 확인할 수 없습니다.');
      value += map.get(code);
    }
    return value;
  };
  const reverse = new Map();
  let ambiguous = new Set();
  map.forEach((value, code) => {
    if (reverse.has(value) && reverse.get(value) !== code) ambiguous.add(value);
    else reverse.set(value, code);
  });
  decode.encode = (value) => {
    let binary = '';
    for (const character of String(value || '')) {
      if (ambiguous.has(character) || !reverse.has(character)) {
        throw new Error(`원본 글꼴에 '${character}' glyph mapping이 없습니다.`);
      }
      const code = reverse.get(character);
      binary += String.fromCharCode(...Array.from({ length: codeBytes }, (_, index) => (
        code >> (8 * (codeBytes - index - 1)) & 0xff
      )));
    }
    return binary;
  };
  return decode;
}

export function analyzePdfFont(page, resourceName) {
  const font = page.node.Resources()?.lookupMaybe(name('Font'), PDFDict)?.lookupMaybe(name(resourceName), PDFDict);
  if (!font) throw new Error('원본 글꼴 리소스를 찾을 수 없습니다.');
  const subtype = font.lookupMaybe(name('Subtype'), PDFName)?.decodeText();
  const baseFont = font.lookupMaybe(name('BaseFont'), PDFName)?.decodeText() || resourceName;
  const encodingObject = font.lookup(name('Encoding'));
  const encoding = encodingObject instanceof PDFName ? encodingObject.decodeText() : 'custom';
  let descendant = font;
  if (subtype === 'Type0') {
    if (encoding !== 'Identity-H') throw new Error('Identity-H 이외의 CID 인코딩은 아직 지원하지 않습니다.');
    const descendants = font.lookupMaybe(name('DescendantFonts'), PDFArray);
    if (!descendants || descendants.size() !== 1) throw new Error('CID 글꼴 구조를 확인할 수 없습니다.');
    descendant = descendants.lookup(0, PDFDict);
    const cidType = descendant.lookupMaybe(name('Subtype'), PDFName)?.decodeText();
    if (!['CIDFontType0', 'CIDFontType2'].includes(cidType)) throw new Error('지원하지 않는 CID 글꼴입니다.');
  } else if (!['Type1', 'TrueType'].includes(subtype)) throw new Error('지원하지 않는 원본 글꼴 형식입니다.');
  const descriptor = descendant.lookupMaybe(name('FontDescriptor'), PDFDict);
  const embedded = !!descriptor && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor.has(name(key)));
  const cmap = font.lookup(name('ToUnicode'));
  const info = {
    resourceName,
    baseFont,
    subtype,
    encoding,
    embedded,
    subset: /^[A-Z]{6}\+/.test(baseFont),
    toUnicodeMapped: Boolean(cmap),
    canReuseOriginalFont: false
  };
  if (cmap) {
    const decode = readToUnicode(cmap, subtype === 'Type0' ? 2 : 1);
    return {
      ...info,
      toUnicodeMapped: true,
      canReuseOriginalFont: true,
      decode,
      encode: decode.encode
    };
  }
  if (subtype === 'Type1' && STANDARD.has(baseFont) && !font.has(name('Widths')) && !descriptor
    && (!encodingObject || encoding === 'WinAnsiEncoding')) {
    return { ...info, canReuseOriginalFont: true, decode: (binary) => {
      if (!/^[\x20-\x7e]*$/.test(binary)) throw new Error('원본 문자 매핑을 확인할 수 없습니다.');
      return binary;
    }, encode: (value) => {
      const text = String(value || '');
      if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('원본 글꼴에 새 문자의 glyph mapping이 없습니다.');
      return text;
    } };
  }
  throw new Error('원본 글꼴에 해석 가능한 ToUnicode 매핑이 없습니다.');
}
