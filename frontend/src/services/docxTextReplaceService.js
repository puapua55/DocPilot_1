import PizZip from 'pizzip';

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
    tblCount: (source.match(/:tbl\b/g) || []).length
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

  // WordprocessingML 전체를 DOMParser/XMLSerializer로 다시 만들지 않습니다.
  // 원본 태그, namespace prefix, 속성, 문단/표/section 구조를 그대로 유지하고
  // <prefix:t>...</prefix:t> 내부 문자열만 최소 변경합니다.
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

async function debugValidateConvertedDocxBlob(blob, originalText, newText) {
  try {
    const buffer = await blob.arrayBuffer();
    const zip = new PizZip(buffer);
    const documentXml = zip.file('word/document.xml')?.asText() || '';

    console.log('[DocxConvert] converted document.xml summary:', {
      ...getXmlPrefixSummary(documentXml),
      includesNewText: documentXml.includes(String(newText ?? '')),
      includesOldText: documentXml.includes(String(originalText ?? ''))
    });
  } catch (error) {
    console.warn('[DocxConvert] converted blob validation failed:', error);
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
    zip = new PizZip(await file.arrayBuffer());
  } catch (error) {
    console.error('[DocxConvert] failed to open DOCX zip:', error);
    throw new Error('DOCX 파일 구조를 읽지 못했습니다. 파일이 손상되지 않았는지 확인해주세요.');
  }

  const xmlPaths = getDocxTextXmlPaths(zip);
  console.log('[DocxConvert] xml paths:', xmlPaths);

  if (!xmlPaths.includes('word/document.xml')) {
    throw new Error('DOCX 본문 XML(word/document.xml)을 찾지 못했습니다.');
  }

  let totalReplaceCount = 0;

  xmlPaths.forEach((path) => {
    const xmlFile = zip.file(path);
    if (!xmlFile) {
      return;
    }

    const xmlText = xmlFile.asText();
    const beforeSummary = getXmlPrefixSummary(xmlText);

    console.log('[DocxConvert] before XML summary:', {
      path,
      ...beforeSummary
    });

    const result = replaceTextInDocxXml(xmlText, target, replacement);
    const afterSummary = getXmlPrefixSummary(result.xmlText);

    console.log('[DocxConvert] after XML summary:', {
      path,
      ...afterSummary,
      replaceCount: result.replaceCount
    });

    if (path === 'word/document.xml') {
      const prefixChanged = beforeSummary.hasWDocument && !afterSummary.hasWDocument;
      const introducedNs0 = !beforeSummary.hasNs0Document && afterSummary.hasNs0Document;
      const textNodeCountChanged = beforeSummary.wTextCount !== afterSummary.wTextCount;
      const tableCountChanged = beforeSummary.tblCount !== afterSummary.tblCount;
      const sectionCountChanged = beforeSummary.sectPrCount !== afterSummary.sectPrCount;

      if (
        prefixChanged ||
        introducedNs0 ||
        textNodeCountChanged ||
        tableCountChanged ||
        sectionCountChanged
      ) {
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
  });

  const outputFileName = makeDocxConvertedFileName(file.name);
  const blob = zip.generate({
    type: 'blob',
    mimeType: DOCX_MIME_TYPE,
    compression: 'DEFLATE'
  });

  await debugValidateConvertedDocxBlob(blob, target, replacement);
  downloadBlob(blob, outputFileName);

  console.log('[DocxConvert] done:', {
    outputFileName,
    replaceCount: totalReplaceCount
  });

  return {
    outputFileName,
    replaceCount: totalReplaceCount
  };
}
