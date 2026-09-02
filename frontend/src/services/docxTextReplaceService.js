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

  // 브라우저가 다운로드를 시작하기 전에 object URL이 해제되는 것을 피합니다.
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

function parseDocxXml(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
  const parserError = xmlDoc.getElementsByTagName('parsererror')[0];

  if (parserError) {
    return null;
  }

  return xmlDoc;
}

function serializeDocxXml(xmlDoc) {
  return new XMLSerializer().serializeToString(xmlDoc);
}

function replaceTextInDocxXmlByTextNode(xmlText, originalText, newText) {
  const xmlDoc = parseDocxXml(xmlText);

  if (!xmlDoc) {
    console.warn('[DocxConvert] XML parse error. Fallback to original XML.');
    return {
      xmlText,
      replaceCount: 0
    };
  }

  const textNodes = Array.from(xmlDoc.getElementsByTagName('w:t'));
  let replaceCount = 0;

  textNodes.forEach((node) => {
    const before = node.textContent || '';
    if (!before.includes(originalText)) {
      return;
    }

    const occurrences = before.split(originalText).length - 1;
    node.textContent = before.split(originalText).join(newText);
    replaceCount += occurrences;
  });

  return {
    xmlText: serializeDocxXml(xmlDoc),
    replaceCount
  };
}

function replaceTextInDocxXmlByParagraph(xmlText, originalText, newText) {
  const xmlDoc = parseDocxXml(xmlText);

  if (!xmlDoc) {
    console.warn('[DocxConvert] paragraph fallback XML parse error.');
    return {
      xmlText,
      replaceCount: 0
    };
  }

  const paragraphs = Array.from(xmlDoc.getElementsByTagName('w:p'));
  let replaceCount = 0;

  paragraphs.forEach((paragraph) => {
    const textNodes = Array.from(paragraph.getElementsByTagName('w:t'));
    if (textNodes.length === 0) {
      return;
    }

    const combinedText = textNodes.map((node) => node.textContent || '').join('');
    if (!combinedText.includes(originalText)) {
      return;
    }

    const occurrences = combinedText.split(originalText).length - 1;
    const replacedText = combinedText.split(originalText).join(newText);

    // split run fallback입니다. 문단 내 run별 서식 보존이 완벽하지 않을 수 있으므로
    // direct w:t 치환이 전혀 성공하지 않은 경우에만 이 경로를 사용합니다.
    textNodes.forEach((node, index) => {
      node.textContent = index === 0 ? replacedText : '';
    });

    replaceCount += occurrences;
  });

  return {
    xmlText: serializeDocxXml(xmlDoc),
    replaceCount
  };
}

export function replaceTextInDocxXml(xmlText, originalText, newText) {
  const target = String(originalText || '');
  const replacement = String(newText ?? '');

  if (!target) {
    return {
      xmlText,
      replaceCount: 0
    };
  }

  const directResult = replaceTextInDocxXmlByTextNode(xmlText, target, replacement);
  if (directResult.replaceCount > 0) {
    return directResult;
  }

  return replaceTextInDocxXmlByParagraph(xmlText, target, replacement);
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

    const result = replaceTextInDocxXml(xmlFile.asText(), target, replacement);

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
