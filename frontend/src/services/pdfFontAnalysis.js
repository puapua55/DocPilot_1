import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { Encodings, Font } from '@pdf-lib/standard-fonts';

const name = PDFName.of;
const STANDARD = new Set(Object.values(StandardFonts).filter((font) => !['Symbol', 'ZapfDingbats'].includes(font)));
const utf16 = new TextDecoder('utf-16be', { fatal: true });
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g) || [], (pair) => parseInt(pair, 16));
const unicode = (hex) => {
  if (!hex || hex.length % 4) throw new Error('잘못된 ToUnicode 문자열입니다.');
  return utf16.decode(hexBytes(hex));
};

function readFontWidthLookup(font, descendant, subtype, descriptor) {
  if (subtype === 'Type0') {
    const defaultWidth = descendant.lookupMaybe(name('DW'), PDFNumber)?.asNumber() ?? 1000;
    const widths = new Map();
    const wArray = descendant.lookupMaybe(name('W'), PDFArray);
    if (wArray) {
      for (let i = 0; i < wArray.size();) {
        const first = wArray.lookupMaybe(i++, PDFNumber)?.asNumber();
        const next = wArray.lookup(i++);
        if (!Number.isFinite(first) || !next) break;
        if (next instanceof PDFArray) {
          for (let j = 0; j < next.size(); j++) {
            const width = next.lookupMaybe(j, PDFNumber)?.asNumber();
            if (Number.isFinite(width)) widths.set(first + j, width);
          }
        } else if (next instanceof PDFNumber) {
          const last = next.asNumber();
          const width = wArray.lookupMaybe(i++, PDFNumber)?.asNumber();
          if (Number.isFinite(last) && Number.isFinite(width) && last >= first && last - first <= 65535) {
            for (let code = first; code <= last; code++) widths.set(code, width);
          }
        }
      }
    }
    return (code) => widths.get(code) ?? defaultWidth;
  }
  const defaultWidth = descriptor?.lookupMaybe(name('MissingWidth'), PDFNumber)?.asNumber() ?? 500;
  const firstChar = font.lookupMaybe(name('FirstChar'), PDFNumber)?.asNumber() ?? 0;
  const wArray = font.lookupMaybe(name('Widths'), PDFArray);
  const widths = new Map();
  if (wArray) {
    for (let i = 0; i < wArray.size(); i++) {
      const width = wArray.lookupMaybe(i, PDFNumber)?.asNumber();
      if (Number.isFinite(width)) widths.set(firstChar + i, width);
    }
  }
  return (code) => widths.get(code) ?? defaultWidth;
}

// A bounded ToUnicode reader. When a ToUnicode stream inherits from an external
// CMap via usecmap, inline mappings are still parsed and unmapped character
// codes decode to U+FFFD placeholders so glyph counts and positions remain
// available for content-stream deletion while disabling raw-font glyph replay.
export function readToUnicode(stream, codeBytes) {
  if (!(stream instanceof PDFRawStream)) throw new Error('ToUnicode 매핑이 없습니다.');
  const bytes = decodePDFRawStream(stream).decode();
  if (bytes.length > 4 * 1024 * 1024) throw new Error('ToUnicode 매핑이 너무 큽니다.');
  const text = new TextDecoder('latin1').decode(bytes).replace(/%[^\r\n]*/g, '');
  const usesExternalCMap = /\busecmap\b/.test(text);
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
  if ((!sections || !map.size) && !usesExternalCMap) throw new Error('해석 가능한 ToUnicode 항목이 없습니다.');
  const decode = (binary) => {
    if (binary.length % codeBytes) throw new Error('문자 코드 길이가 일치하지 않습니다.');
    let value = '';
    for (let offset = 0; offset < binary.length; offset += codeBytes) {
      let code = 0;
      for (let i = 0; i < codeBytes; i++) code = code * 256 + binary.charCodeAt(offset + i);
      if (!map.has(code)) {
        if (usesExternalCMap) {
          value += '\uFFFD';
          continue;
        }
        throw new Error('ToUnicode에서 원본 문자를 확인할 수 없습니다.');
      }
      value += map.get(code);
    }
    return value;
  };
  decode.partial = usesExternalCMap;
  const reverse = new Map();
  const ambiguous = new Set();
  map.forEach((value, code) => {
    if (reverse.has(value) && reverse.get(value) !== code) ambiguous.add(value);
    else reverse.set(value, code);
  });
  decode.encode = (value) => {
    if (usesExternalCMap) {
      throw new Error('상속된 CMap 글꼴은 원본 glyph 재인코딩을 지원하지 않습니다.');
    }
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
  const codeBytes = subtype === 'Type0' ? 2 : 1;
  const glyphWidth = readFontWidthLookup(font, descendant, subtype, descriptor);
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
    const decode = readToUnicode(cmap, codeBytes);
    return {
      ...info,
      codeBytes,
      glyphWidth,
      toUnicodeMapped: true,
      partialToUnicode: decode.partial === true,
      canReuseOriginalFont: decode.partial !== true,
      decode,
      encode: decode.partial === true ? undefined : decode.encode
    };
  }
  if (subtype === 'Type1' && STANDARD.has(baseFont) && !font.has(name('Widths')) && !descriptor
    && (!encodingObject || encoding === 'WinAnsiEncoding')) {
    const metrics = Font.load(baseFont);
    const measureText = (value, size) => {
      const glyphs = Array.from(String(value || ''), (character) => (
        Encodings.WinAnsi.encodeUnicodeCodePoint(character.codePointAt(0))
      ));
      let width = 0;
      glyphs.forEach((glyph, index) => {
        width += metrics.getWidthOfGlyph(glyph.name) || 250;
        width += metrics.getXAxisKerningForPair(glyph.name, glyphs[index + 1]?.name) || 0;
      });
      return width * Number(size) / 1000;
    };
    return { ...info, codeBytes, glyphWidth, canReuseOriginalFont: true, decode: (binary) => {
      if (!/^[\x20-\x7e]*$/.test(binary)) throw new Error('원본 문자 매핑을 확인할 수 없습니다.');
      return binary;
    }, encode: (value) => {
      const text = String(value || '');
      if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('원본 글꼴에 새 문자의 glyph mapping이 없습니다.');
      return text;
    }, measureText };
  }
  if (['Type1', 'TrueType'].includes(subtype)
    && (!encodingObject || ['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding'].includes(encoding))) {
    return {
      ...info,
      codeBytes,
      glyphWidth,
      partialToUnicode: true,
      canReuseOriginalFont: false,
      decode: (binary) => Array.from(binary, (ch) => {
        const code = ch.charCodeAt(0);
        return code >= 0x20 && code <= 0x7e ? ch : '\uFFFD';
      }).join('')
    };
  }
  throw new Error('원본 글꼴에 해석 가능한 ToUnicode 매핑이 없습니다.');
}
