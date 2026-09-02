import JSZip from 'jszip';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const WORD_TEXT_XML_PATHS = new Set([
  'word/document.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'word/comments.xml'
]);
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

export function makeDocxConvertedFileName(fileName = 'document.docx') {
  const baseName = String(fileName || 'document.docx').replace(/\.docx$/i, '');
  return `${baseName}_docx_converted.docx`;
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function getDocxTextXmlPaths(zip) {
  return Object.keys(zip.files).filter((path) => (
    WORD_TEXT_XML_PATHS.has(path) ||
    /^word\/header\d+\.xml$/i.test(path) ||
    /^word\/footer\d+\.xml$/i.test(path)
  ));
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function unescapeXmlText(value) {
  return String(value ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function getXmlPrefixSummary(xmlText) {
  const source = String(xmlText || '');
  return {
    hasWDocument: source.includes('<w:document'),
    hasNs0Document: source.includes('<ns0:document'),
    wTextCount: (source.match(/<w:t\b/g) || []).length,
    ns0TextCount: (source.match(/<ns0:t\b/g) || []).length,
    sectPrCount: (source.match(/:sectPr\b/g) || []).length,
    tblCount: (source.match(/<w:tbl\b/g) || []).length,
    trCount: (source.match(/<w:tr\b/g) || []).length,
    tcCount: (source.match(/<w:tc\b/g) || []).length
  };
}

export function replaceTextInDocxXml(xmlText, originalText, newText) {
  const source = String(xmlText ?? '');
  const target = String(originalText || '');
  const replacement = String(newText ?? '');
  if (!target) return { xmlText: source, replaceCount: 0 };

  let replaceCount = 0;
  const replacedXmlText = source.replace(
    /(<([A-Za-z_][A-Za-z0-9_.-]*):t\b[^>]*>)([\s\S]*?)(<\/\2:t>)/g,
    (match, openTag, _prefix, encodedText, closeTag) => {
      const text = unescapeXmlText(encodedText);
      if (!text.includes(target)) return match;
      const occurrences = text.split(target).length - 1;
      replaceCount += occurrences;
      return `${openTag}${escapeXmlText(text.split(target).join(replacement))}${closeTag}`;
    }
  );

  if (replaceCount === 0) {
    console.warn('[DocxConvert] no direct w:t replacements. split-run replacement is not enabled yet.');
  }
  return { xmlText: replacedXmlText, replaceCount };
}

async function readZipText(zip, path) {
  const entry = zip.file(path);
  return entry ? entry.async('string') : '';
}

function findEocd(bytes) {
  const minOffset = Math.max(0, bytes.length - 0xffff - 22);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('DOCX ZIP central directory를 찾지 못했습니다.');
}

function parseZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocd(bytes);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_FILE_HEADER) {
      throw new Error('DOCX ZIP central directory 엔트리가 올바르지 않습니다.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const centralLength = 46 + nameLength + extraLength + commentLength;
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    entries.push({
      name,
      flags,
      compression,
      crc,
      compressedSize,
      uncompressedSize,
      centralBytes: bytes.slice(cursor, cursor + centralLength),
      localOffset: view.getUint32(cursor + 42, true)
    });
    cursor += centralLength;
  }

  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  sorted.forEach((entry, index) => {
    entry.localEnd = index + 1 < sorted.length ? sorted[index + 1].localOffset : centralOffset;
  });
  return { entries, eocdOffset, centralOffset };
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function makeStoredLocalEntry(originalBytes, entry, contentBytes) {
  const view = new DataView(originalBytes.buffer, originalBytes.byteOffset, originalBytes.byteLength);
  if (view.getUint32(entry.localOffset, true) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`DOCX ZIP local header를 읽지 못했습니다: ${entry.name}`);
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const nameBytes = originalBytes.slice(entry.localOffset + 30, entry.localOffset + 30 + nameLength);
  const extraBytes = originalBytes.slice(
    entry.localOffset + 30 + nameLength,
    entry.localOffset + 30 + nameLength + extraLength
  );
  const header = new Uint8Array(30);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, ZIP_LOCAL_FILE_HEADER, true);
  headerView.setUint16(4, view.getUint16(entry.localOffset + 4, true), true);
  headerView.setUint16(6, entry.flags & ~0x0008, true);
  headerView.setUint16(8, 0, true);
  headerView.setUint16(10, view.getUint16(entry.localOffset + 10, true), true);
  headerView.setUint16(12, view.getUint16(entry.localOffset + 12, true), true);
  headerView.setUint32(14, crc32(contentBytes), true);
  headerView.setUint32(18, contentBytes.length, true);
  headerView.setUint32(22, contentBytes.length, true);
  headerView.setUint16(26, nameBytes.length, true);
  headerView.setUint16(28, extraBytes.length, true);
  return concatBytes([header, nameBytes, extraBytes, contentBytes]);
}

function patchCentralEntry(entry, localOffset, contentBytes) {
  const central = entry.centralBytes.slice();
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
  view.setUint16(8, entry.flags & ~0x0008, true);
  if (contentBytes) {
    view.setUint16(10, 0, true);
    view.setUint32(16, crc32(contentBytes), true);
    view.setUint32(20, contentBytes.length, true);
    view.setUint32(24, contentBytes.length, true);
  }
  view.setUint32(42, localOffset, true);
  return central;
}

function rebuildDocxZip(originalBytes, replacements) {
  const { entries, eocdOffset } = parseZipEntries(originalBytes);
  const localParts = [];
  const centralParts = [];
  const newOffsets = new Map();
  let outputOffset = 0;

  for (const entry of [...entries].sort((a, b) => a.localOffset - b.localOffset)) {
    newOffsets.set(entry.name, outputOffset);
    const replacement = replacements.get(entry.name);
    const part = replacement
      ? makeStoredLocalEntry(originalBytes, entry, replacement)
      : originalBytes.slice(entry.localOffset, entry.localEnd);
    localParts.push(part);
    outputOffset += part.length;
  }

  const newCentralOffset = outputOffset;
  for (const entry of entries) {
    const central = patchCentralEntry(entry, newOffsets.get(entry.name), replacements.get(entry.name));
    centralParts.push(central);
    outputOffset += central.length;
  }

  const originalView = new DataView(originalBytes.buffer, originalBytes.byteOffset, originalBytes.byteLength);
  const commentLength = originalView.getUint16(eocdOffset + 20, true);
  const eocd = originalBytes.slice(eocdOffset, eocdOffset + 22 + commentLength);
  const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  eocdView.setUint32(12, outputOffset - newCentralOffset, true);
  eocdView.setUint32(16, newCentralOffset, true);
  return concatBytes([...localParts, ...centralParts, eocd]);
}

function getStoredEntryContent(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.localOffset, true) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`DOCX ZIP local header를 읽지 못했습니다: ${entry.name}`);
  }
  if (entry.compression !== 0) {
    throw new Error(`검증 대상 XML이 STORE 방식이 아닙니다: ${entry.name}`);
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  return bytes.slice(dataOffset, dataOffset + entry.compressedSize);
}

function equalBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function validateConvertedDocxBlob(blob, originalBytes, replacements, originalText, newText) {
  try {
    const convertedBytes = new Uint8Array(await blob.arrayBuffer());
    const originalParsed = parseZipEntries(originalBytes);
    const convertedParsed = parseZipEntries(convertedBytes);
    const originalByName = new Map(originalParsed.entries.map((entry) => [entry.name, entry]));
    const convertedByName = new Map(convertedParsed.entries.map((entry) => [entry.name, entry]));

    if (convertedParsed.entries.length !== originalParsed.entries.length) {
      throw new Error('ZIP 엔트리 개수가 원본과 다릅니다.');
    }

    for (const entry of originalParsed.entries) {
      if (!convertedByName.has(entry.name)) throw new Error(`ZIP 엔트리가 누락되었습니다: ${entry.name}`);
    }

    for (const [path, expectedContent] of replacements) {
      const entry = convertedByName.get(path);
      if (!entry) throw new Error(`변경 XML 엔트리를 찾지 못했습니다: ${path}`);
      const actualContent = getStoredEntryContent(convertedBytes, entry);
      if (!equalBytes(actualContent, expectedContent)) throw new Error(`변경 XML 내용 검증에 실패했습니다: ${path}`);
      if (entry.crc !== crc32(expectedContent) || entry.uncompressedSize !== expectedContent.length) {
        throw new Error(`변경 XML CRC/크기 검증에 실패했습니다: ${path}`);
      }
    }

    const documentEntry = convertedByName.get('word/document.xml');
    const documentBytes = replacements.get('word/document.xml');
    if (!documentEntry || !documentBytes) throw new Error('word/document.xml 변경 결과를 확인할 수 없습니다.');
    const documentXml = new TextDecoder('utf-8').decode(getStoredEntryContent(convertedBytes, documentEntry));

    const originalStyles = originalByName.get('word/styles.xml');
    const convertedStyles = convertedByName.get('word/styles.xml');
    const stylesPreserved = !originalStyles || (
      convertedStyles &&
      originalStyles.crc === convertedStyles.crc &&
      originalStyles.compressedSize === convertedStyles.compressedSize &&
      originalStyles.uncompressedSize === convertedStyles.uncompressedSize &&
      equalBytes(
        originalBytes.slice(originalStyles.localOffset, originalStyles.localEnd),
        convertedBytes.slice(convertedStyles.localOffset, convertedStyles.localEnd)
      )
    );
    if (!stylesPreserved) throw new Error('word/styles.xml 원본 ZIP record 보존 검증에 실패했습니다.');

    const validation = {
      zipEntryCount: convertedParsed.entries.length,
      documentHasNewText: documentXml.includes(String(newText ?? '')),
      documentHasOldText: documentXml.includes(String(originalText ?? '')),
      stylesPreserved,
      ...getXmlPrefixSummary(documentXml)
    };
    console.log('[DocxConvert] validation:', validation);
    return validation;
  } catch (error) {
    console.error('[DocxConvert] converted DOCX validation failed:', error);
    throw new Error('변환된 DOCX 내부 ZIP 무결성 검증에 실패했습니다.');
  }
}

export async function convertDocxFileWithTextReplace(file, originalText, newText) {
  if (!file) throw new Error('DOCX 파일이 선택되지 않았습니다.');
  if (!String(file.name || '').toLowerCase().endsWith('.docx')) {
    throw new Error('DOC 형식은 현재 변환 저장을 지원하지 않습니다. DOCX 파일을 사용해주세요.');
  }

  const target = String(originalText || '').trim();
  const replacement = String(newText ?? '');
  if (!target) throw new Error('기존 단어를 입력하세요.');

  console.log('[DocxConvert] start:', { fileName: file.name, originalText: target, newText: replacement });
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  let zip;
  try {
    zip = await JSZip.loadAsync(originalBytes);
  } catch (error) {
    console.error('[DocxConvert] failed to open DOCX zip:', error);
    throw new Error('DOCX 파일 구조를 읽지 못했습니다. 파일이 손상되지 않았는지 확인해주세요.');
  }

  const xmlPaths = getDocxTextXmlPaths(zip);
  console.log('[DocxConvert] text XML paths only:', xmlPaths);
  if (!xmlPaths.includes('word/document.xml')) throw new Error('DOCX 본문 XML(word/document.xml)을 찾지 못했습니다.');

  const replacements = new Map();
  let totalReplaceCount = 0;
  const encoder = new TextEncoder();

  for (const path of xmlPaths) {
    const xmlText = await readZipText(zip, path);
    if (!xmlText) continue;
    const beforeSummary = getXmlPrefixSummary(xmlText);
    const result = replaceTextInDocxXml(xmlText, target, replacement);
    const afterSummary = getXmlPrefixSummary(result.xmlText);

    if (path === 'word/document.xml') {
      const structureChanged =
        (beforeSummary.hasWDocument && !afterSummary.hasWDocument) ||
        (!beforeSummary.hasNs0Document && afterSummary.hasNs0Document) ||
        beforeSummary.wTextCount !== afterSummary.wTextCount ||
        beforeSummary.tblCount !== afterSummary.tblCount ||
        beforeSummary.trCount !== afterSummary.trCount ||
        beforeSummary.tcCount !== afterSummary.tcCount ||
        beforeSummary.sectPrCount !== afterSummary.sectPrCount;
      if (structureChanged) throw new Error('DOCX 본문 XML 구조 보존 검증에 실패했습니다. 변환을 중단합니다.');
    }

    if (result.replaceCount > 0) replacements.set(path, encoder.encode(result.xmlText));
    totalReplaceCount += result.replaceCount;
    console.log('[DocxConvert] xml replace:', { path, replaceCount: result.replaceCount });
  }

  const convertedBytes = rebuildDocxZip(originalBytes, replacements);
  const blob = new Blob([convertedBytes], { type: DOCX_MIME_TYPE });
  await validateConvertedDocxBlob(blob, originalBytes, replacements, target, replacement);

  const outputFileName = makeDocxConvertedFileName(file.name);
  downloadBlob(blob, outputFileName);
  console.log('[DocxConvert] done:', {
    outputFileName,
    replaceCount: totalReplaceCount,
    integrityCheck: 'raw ZIP structure + changed XML CRC + styles raw record preservation passed'
  });
  return { outputFileName, replaceCount: totalReplaceCount };
}
