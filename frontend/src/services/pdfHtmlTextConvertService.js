import { jsPDF } from 'jspdf';
import {
  extractPdfToHtmlStructure,
  isPageEdgeArtifactLine
} from './pdfHtmlStructureService';

const TEXT_BASELINE_RATIO = 0.85;
const FONT_DEFINITIONS = [
  {
    pdfFontName: 'MalgunGothic',
    fileName: 'MalgunGothic-Regular.ttf',
    candidates: [
      '/fonts/MalgunGothic-Regular.base64.txt',
      '/fonts/MalgunGothic-Regular.base64',
      '/fonts/malgun.base64.txt',
      '/fonts/malgun.ttf.base64'
    ]
  },
  {
    pdfFontName: 'NotoSansKR',
    fileName: 'NotoSansKR-Regular.ttf',
    candidates: [
      '/fonts/NotoSansKR-Regular.base64.txt',
      '/fonts/NotoSansKR-Regular.base64',
      '/fonts/NotoSansKR-Regular.ttf.base64'
    ]
  }
];

function parsePx(value) {
  return Number(String(value || '').replace('px', '').trim()) || 0;
}

function getStylePx(element, propertyName) {
  return parsePx(element?.style?.[propertyName]);
}

function normalizeHtmlFontToPdfFont(fontFamily) {
  const value = String(fontFamily || '').toLowerCase();

  if (value.includes('malgun') || value.includes('gothic') || value.includes('맑은')) {
    return 'MalgunGothic';
  }

  if (value.includes('noto')) {
    return 'NotoSansKR';
  }

  return null;
}

function downloadBlob(blob, outputFileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = outputFileName;
  link.click();
  URL.revokeObjectURL(url);
}

function makeHtmlStructureFileName(fileName = 'document.pdf') {
  const baseName = fileName.replace(/\.pdf$/i, '');

  return `${baseName}_html_structure.txt`;
}

export function wrapHtmlTextDocument(pageHtml) {
  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">',
    '<title>DocPilot HTML Text Structure</title>',
    '</head>',
    '<body>',
    String(pageHtml ?? ''),
    '</body>',
    '</html>'
  ].join('');
}

export async function convertPdfViaHtmlText(file, originalText, newText) {
  const htmlText = await extractPdfToHtmlText(file);

  console.log('[HtmlTextConvert] originalHtmlText:', htmlText);

  const replaceResult = replaceTextInHtmlText(htmlText, originalText, newText);
  const replacedHtmlText = replaceResult.htmlText;
  const replaceCount = replaceResult.replaceCount;

  console.log('[HtmlTextConvert] replacedHtmlText:', replacedHtmlText);

  const outputFileName = makeHtmlConvertedFileName(file?.name);

  // The structure file must contain the post-replacement HTML and must be
  // readable as UTF-8 in Windows editors as well as browsers.
  downloadHtmlTextFile(replacedHtmlText, file?.name);

  await renderPdfFromHtmlText(replacedHtmlText, outputFileName);

  return {
    htmlText,
    replacedHtmlText,
    replaceCount,
    outputFileName,
    parsed: parseHtmlTextStructure(replacedHtmlText)
  };
}

export async function extractPdfToHtmlText(file) {
  const htmlStructure = await extractPdfToHtmlStructure(file);
  const pageHtml = String(htmlStructure?.html ?? '');

  if (!pageHtml.includes('pdf-page') || !pageHtml.includes('pdf-text')) {
    throw new Error('PDF에서 HTML 텍스트 구조를 생성하지 못했습니다.');
  }

  const htmlText = wrapHtmlTextDocument(pageHtml);

  console.log('[HtmlTextConvert] htmlText includes charset:', htmlText.includes('charset="UTF-8"'));
  console.log('[HtmlTextConvert] htmlText includes Malgun:', htmlText.includes('Malgun'));
  console.log('[HtmlTextConvert] htmlText includes right edge line:', htmlText.includes('left:595'));

  return htmlText;
}

export function replaceTextInHtmlText(htmlText, originalText, newText) {
  const target = String(originalText ?? '');

  if (!target) {
    return {
      htmlText: String(htmlText ?? ''),
      replaceCount: 0
    };
  }

  const replacement = String(newText ?? '');
  const parser = new DOMParser();
  const docHtml = parser.parseFromString(String(htmlText ?? ''), 'text/html');
  const textElements = Array.from(docHtml.querySelectorAll('.pdf-text'));
  let replaceCount = 0;

  textElements.forEach((textElement) => {
    const before = textElement.textContent ?? '';
    const after = before.split(target).join(replacement);

    if (before !== after) {
      replaceCount += 1;
      console.log('[HtmlTextConvert] replace text:', { before, after });
    }

    textElement.textContent = after;
  });

  const replacedHtmlText = wrapHtmlTextDocument(docHtml.body.innerHTML);

  return {
    htmlText: replacedHtmlText,
    replaceCount
  };
}

export function parseHtmlTextStructure(htmlText) {
  const parser = new DOMParser();
  const docHtml = parser.parseFromString(String(htmlText ?? ''), 'text/html');
  const pageElements = Array.from(docHtml.querySelectorAll('.pdf-page'));

  console.log('[HtmlTextConvert] parsed pages:', pageElements.length);

  return {
    pages: pageElements.map((pageElement, pageIndex) => {
      const lines = Array.from(pageElement.querySelectorAll('.pdf-line'));
      const texts = Array.from(pageElement.querySelectorAll('.pdf-text'));

      console.log('[HtmlTextConvert] page:', pageIndex + 1);
      console.log('[HtmlTextConvert] parsed lines:', lines.length);
      console.log('[HtmlTextConvert] parsed texts:', texts.length);

      const parsedTexts = texts.map((textElement, index) => {
        const text = textElement.textContent ?? '';
        const parsedText = {
          text,
          left: getStylePx(textElement, 'left'),
          top: getStylePx(textElement, 'top'),
          fontSize: getStylePx(textElement, 'fontSize'),
          fontFamily: textElement.getAttribute('data-font-family') ||
            textElement.style.fontFamily ||
            ''
        };

        console.log('[HtmlTextConvert] parsed text:', index, {
          text,
          left: textElement.style.left,
          top: textElement.style.top,
          fontSize: textElement.style.fontSize,
          fontFamily: parsedText.fontFamily
        });

        return parsedText;
      });

      return {
        pageNumber: Number(pageElement.dataset.page || pageIndex + 1),
        width: getStylePx(pageElement, 'width'),
        height: getStylePx(pageElement, 'height'),
        lines: lines
          .map((lineElement) => ({
            type: lineElement.classList.contains('v-line') ? 'v' : 'h',
            left: getStylePx(lineElement, 'left'),
            top: getStylePx(lineElement, 'top'),
            width: getStylePx(lineElement, 'width'),
            height: getStylePx(lineElement, 'height')
          }))
          .filter((line) => !isPageEdgeArtifactLine(
            line,
            getStylePx(pageElement, 'width'),
            getStylePx(pageElement, 'height')
          )),
        texts: parsedTexts
      };
    })
  };
}

export async function renderPdfFromHtmlText(htmlText, outputFileName) {
  const normalizedHtmlText = String(htmlText ?? '');

  console.log(
    '[HtmlTextConvert] render input includes charset:',
    normalizedHtmlText.includes('charset="UTF-8"') || normalizedHtmlText.includes('charset=UTF-8')
  );
  console.log('[HtmlTextConvert] render input includes 시험:', normalizedHtmlText.includes('시험'));
  console.log('[HtmlTextConvert] render input sample:', normalizedHtmlText.slice(0, 500));

  const parsedStructure = parseHtmlTextStructure(normalizedHtmlText);
  const pages = parsedStructure.pages;
  const firstPage = pages[0];

  if (!firstPage) {
    throw new Error('PDF로 생성할 HTML 페이지 구조가 없습니다.');
  }

  const doc = new jsPDF({
    unit: 'pt',
    format: [firstPage.width, firstPage.height],
    compress: true
  });

  const fontRegistration = await registerPreferredKoreanFont(doc);
  const selectedFontName = fontRegistration.selectedFontName;
  const registeredFonts = fontRegistration.registeredFonts;

  console.log('[PdfFont] selected font:', selectedFontName);
  console.log('[PdfFont] registered fonts:', Array.from(registeredFonts));

  if (!selectedFontName) {
    console.warn('[PdfFont] No Korean font registered. jsPDF default font will be used and text drawing will continue.');
  }

  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) {
      doc.addPage([page.width, page.height]);
    }

    const cleanLines = page.lines.filter((line) => !isPageEdgeArtifactLine(line, page.width, page.height));

    console.log('[HtmlTextConvert] clean lines count:', cleanLines.length);

    cleanLines.forEach((line) => {
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(Math.max(line.type === 'h' ? line.height : line.width, 0.2));

      if (line.type === 'v') {
        doc.line(line.left, line.top, line.left, line.top + line.height);
        return;
      }

      doc.line(line.left, line.top, line.left + line.width, line.top);
    });

    page.texts.forEach((textItem, textIndex) => {
      const textValue = String(textItem.text ?? '');
      const fontSize = textItem.fontSize || 10;
      const drawX = Number.isFinite(textItem.left) ? textItem.left : 0;
      const drawY = (Number.isFinite(textItem.top) ? textItem.top : 0) + fontSize * TEXT_BASELINE_RATIO;
      const requestedFontName = normalizeHtmlFontToPdfFont(textItem.fontFamily);
      const drawFontName = requestedFontName && registeredFonts.has(requestedFontName)
        ? requestedFontName
        : selectedFontName;

      console.log('[PdfText] draw:', {
        textValue,
        drawX,
        drawY,
        fontSize,
        requestedFontName,
        selectedFontName,
        drawFontName,
        index: textIndex
      });

      doc.setTextColor(0, 0, 0);
      doc.setFontSize(fontSize);

      if (drawFontName && registeredFonts.has(drawFontName)) {
        doc.setFont(drawFontName, 'normal');
      } else {
        console.warn('[PdfFont] no registered Korean font selected. text draw continues with jsPDF default font.');
      }

      // Font registration failure must never suppress text drawing.
      doc.text(textValue, drawX, drawY);
    });
  });

  downloadBlob(doc.output('blob'), outputFileName);
}

export function downloadHtmlTextFile(htmlText, fileName = 'document.pdf') {
  const utf8Bom = '\uFEFF';
  const blob = new Blob([utf8Bom, String(htmlText ?? '')], {
    type: 'text/html;charset=utf-8'
  });

  downloadBlob(blob, makeHtmlStructureFileName(fileName));
}

export function makeHtmlConvertedFileName(fileName = 'document.pdf') {
  const baseName = fileName.replace(/\.pdf$/i, '');

  return `${baseName}_html_converted.pdf`;
}

async function registerPreferredKoreanFont(doc) {
  // Font registrations in jsPDF belong to each document instance. Never carry
  // a successful registration flag from a previous jsPDF instance into a new one.
  const registeredFonts = new Set();

  for (const fontDefinition of FONT_DEFINITIONS) {
    const registered = await tryRegisterFont(doc, fontDefinition, registeredFonts);

    if (registered) {
      if (fontDefinition.pdfFontName === 'MalgunGothic') {
        console.log('[PdfFont] MalgunGothic registered');
      } else {
        console.log('[PdfFont] fallback NotoSansKR registered');
      }

      return {
        selectedFontName: fontDefinition.pdfFontName,
        registeredFonts
      };
    }
  }

  console.warn('[PdfFont] No Korean font registered. Use jsPDF default font.');

  return {
    selectedFontName: null,
    registeredFonts
  };
}

async function tryRegisterFont(doc, fontDefinition, registeredFonts) {
  try {
    const fontBase64 = await loadFontBase64(fontDefinition.candidates);

    if (!fontBase64) {
      console.warn('[PdfFont] font base64 missing:', fontDefinition.pdfFontName);
      return false;
    }

    doc.addFileToVFS(fontDefinition.fileName, fontBase64);
    doc.addFont(fontDefinition.fileName, fontDefinition.pdfFontName, 'normal');
    registeredFonts.add(fontDefinition.pdfFontName);
    return true;
  } catch (error) {
    console.warn(`[PdfFont] failed to register ${fontDefinition.pdfFontName}:`, error);
    return false;
  }
}

async function loadFontBase64(candidates) {
  if (
    candidates?.some((candidate) => candidate.includes('Malgun')) &&
    typeof window !== 'undefined' &&
    typeof window.__DOC_PILOT_MALGUN_GOTHIC_BASE64__ === 'string'
  ) {
    return window.__DOC_PILOT_MALGUN_GOTHIC_BASE64__;
  }

  if (
    candidates?.some((candidate) => candidate.includes('NotoSansKR')) &&
    typeof window !== 'undefined' &&
    typeof window.__DOC_PILOT_KOREAN_FONT_BASE64__ === 'string'
  ) {
    return window.__DOC_PILOT_KOREAN_FONT_BASE64__;
  }

  if (typeof fetch !== 'function') {
    return null;
  }

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);

      if (!response.ok) {
        continue;
      }

      const base64 = (await response.text()).trim();

      if (base64) {
        return base64;
      }
    } catch (error) {
      console.warn('[HtmlTextConvert] failed to load font candidate:', candidate, error);
    }
  }

  return null;
}
