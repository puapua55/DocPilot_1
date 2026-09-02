import JSZip from 'jszip';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const WORD_TEXT_XML_PATHS = new Set([
  'word/document.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'word/comments.xml'
]);

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
  anchor.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getDocxTextXmlPaths(zip) {
  return Object.keys(zip.files).filter((path) => {
    return (
      WORD_TEXT_XML_PATHS.has(path) ||
      /^word\/header\d+\.xml$/i.test(path) ||
      /^word\/footer\d+\.xml$/i.test(path)
    );
  });
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

  if (!target) {
    return {
      xmlText: source,
      replaceCount: 0
    };
  }

  let replaceCount = 0;

  const replacedXmlText = source.replace(
    /(<([A-Za-z_][A-Za-z0-9_.-]*):t\b[^>]*>)([\s\S]*?)(<\/\2:t>)/g,
    (match, openTag, _prefix, encodedText, closeTag) => {
      const text = unescapeXmlText(encodedText);

      if (!text.includes(target)) {
        return match;
      }

      const occurrences = text.split(target).length - 1;
      const replacedText = text.split(target).join(replacement);
      replaceCount += occurrences;

      return `${openTag}${escapeXmlText(replacedText)}${closeTag}`;
    }
  );

  if (replaceCount === 0) {
    console.warn(
      '[DocxConvert] no direct w:t replacements. split-run replacement is not enabled yet.'
    );
  }

  return {
    xmlText: replacedXmlText,
    replaceCount
  };
}

async function readZipText(zip, path) {
  const entry = zip.file(path);
  return entry ? entry.async('string') : '';
}

async function validateConvertedDocxBlob(blob, originalText, newText) {
  try {
    const buffer = await blob.arrayBuffer();
    const checkZip = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const documentXml = await readZipText(checkZip, 'word/document.xml');
    const stylesFile = checkZip.file('word/styles.xml');
    const stylesXml = stylesFile ? await stylesFile.async('string') : '';

    if (!documentXml) {
      throw new Error('word/document.xml을 읽을 수 없습니다.');
    }

    if (stylesFile && !stylesXml) {
      throw new Error('word/styles.xml을 읽을 수 없습니다.');
    }

    const validation = {
      canReadDocumentXml: Boolean(documentXml),
      canReadStylesXml: stylesFile ? Boolean(stylesXml) : null,
      documentHasNewText: documentXml.includes(String(newText ?? '')),
      documentHasOldText: documentXml.includes(String(originalText ?? '')),
      stylesHasTableGrid: stylesXml
        ? stylesXml.includes('TableGrid') ||
          stylesXml.includes('Table Grid') ||
          stylesXml.includes('w:tblBorders')
        : null,
      stylesLength: stylesXml.length,
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
  if (!file) {
    throw new Error('DOCX 파일이 선택되지 않았습니다.');
  }

  if (!String(file.name || '').toLowerCase().endsWith('.docx')) {
    throw new Error('DOC 형식은 현재 변환 저장을 지원하지 않습니다. DOCX 파일을 사용해주세요.');
  }

  const target = String(originalText || '').trim();
  const replacement = String(newText ?? '');

  if (!target) {
    throw new Error('기존 단어를 입력하세요.');
  }

  console.log('[DocxConvert] start:', {
    fileName: file.name,
    originalText: target,
    newText: replacement
  });

  let zip;
  try {
    // 일부 정상 DOCX는 ZIP 메타데이터와 압축 해제 크기 표기가 JSZip의 강제 CRC 검사와 충돌할 수 있다.
    // 입력 문서는 우선 호환성 있게 열고, 생성 결과물에는 아래 validateConvertedDocxBlob에서 CRC 검사를 강제한다.
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch (error) {
    console.error('[DocxConvert] failed to open DOCX zip:', error);
    throw new Error('DOCX 파일 구조를 읽지 못했습니다. 파일이 손상되지 않았는지 확인해주세요.');
  }

  const xmlPaths = getDocxTextXmlPaths(zip);
  console.log('[DocxConvert] text XML paths only:', xmlPaths);

  if (!xmlPaths.includes('word/document.xml')) {
    throw new Error('DOCX 본문 XML(word/document.xml)을 찾지 못했습니다.');
  }

  let totalReplaceCount = 0;

  for (const path of xmlPaths) {
    const xmlFile = zip.file(path);
    if (!xmlFile) {
      continue;
    }

    const xmlText = await xmlFile.async('string');
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

      if (structureChanged) {
        throw new Error('DOCX 본문 XML 구조 보존 검증에 실패했습니다. 변환을 중단합니다.');
      }
    }

    if (result.replaceCount > 0) {
      zip.file(path, result.xmlText);
    }

    totalReplaceCount += result.replaceCount;

    console.log('[DocxConvert] xml replace:', {
      path,
      replaceCount: result.replaceCount
    });
  }

  const outputFileName = makeDocxConvertedFileName(file.name);
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: DOCX_MIME_TYPE,
    compression: 'STORE'
  });

  await validateConvertedDocxBlob(blob, target, replacement);
  downloadBlob(blob, outputFileName);

  console.log('[DocxConvert] done:', {
    outputFileName,
    replaceCount: totalReplaceCount,
    integrityCheck: 'JSZip CRC/document.xml/styles.xml read passed',
    terminalCheck: `unzip -t "${outputFileName}"`
  });

  return {
    outputFileName,
    replaceCount: totalReplaceCount
  };
}
