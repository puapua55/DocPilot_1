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
const registeredFonts = new Set();
let preferredFontRegistrationAttempted = false;
let selectedKoreanFontName = null;

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

  return 'MalgunGothic';
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

export async function convertPdfViaHtmlText(file, originalText, newText) {
  const htmlText = await extractPdfToHtmlText(file);

  console.log('[HtmlTextConvert] originalHtmlText:', htmlText);

  const replaceResult = replaceTextInHtmlText(htmlText, originalText, newText);
  const replacedHtmlText = replaceResult.htmlText;

  console.log('[HtmlTextConvert] replacedHtmlText:', replacedHtmlText);

  const outputFileName = makeHtmlConvertedFileName(file?.name);
  await renderPdfFromHtmlText(replacedHtmlText, outputFileName);

  return {
    htmlText,
    replacedHtmlText,
    replaceCount: replaceResult.replaceCount,
    outputFileName,
    parsed: parseHtmlTextStructure(replacedHtmlText)
  };
}

export async function extractPdfToHtmlText(file) {
  const htmlStructure = await extractPdfToHtmlStructure(file);
  const htmlText = String(htmlStructure?.html ?? '');

  if (!htmlText.includes('pdf-page') || !htmlText.includes('pdf-text')) {
    throw new Error('PDF에서 HTML 텍스트 구조를 생성하지 못했습니다.');
  }

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

  const pageElements = Array.from(docHtml.querySelectorAll('.pdf-page'));
  const replacedHtmlText = pageElements.map((pageElement) => pageElement.outerHTML).join('');

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
            'MalgunGothic'
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
          .filter((line) => !isPageEdgeArtifactLine(line, getStylePx(pageElement, 'width'), getStylePx(pageElement, 'height'))),
        texts: parsedTexts
      };
    })
  };
}

export async function renderPdfFromHtmlText(htmlText, outputFileName) {
  console.log('[HtmlTextConvert] renderPdfFromHtmlText input:', htmlText);

  const parsedStructure = parseHtmlTextStructure(htmlText);
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

  const selectedFontName = await registerPreferredKoreanFont(doc);

  console.log('[PdfFont] selected font:', selectedFontName);

  if (!selectedFontName) {
    console.warn('[HtmlTextConvert] Korean font not registered. doc.text will still run with fallback font.');
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
      const drawX = textItem.left || 0;
      const drawY = (textItem.top || 0) + fontSize * TEXT_BASELINE_RATIO;
      const requestedFontName = normalizeHtmlFontToPdfFont(textItem.fontFamily);
      const drawFontName = registeredFonts.has(requestedFontName)
        ? requestedFontName
        : selectedFontName;

      console.log('[PdfText] draw:', {
        text: textValue,
        x: drawX,
        y: drawY,
        fontSize,
        font: drawFontName,
        index: textIndex
      });

      if (drawFontName) {
        doc.setFont(drawFontName, 'normal');
      } else {
        doc.setFont('helvetica', 'normal');
      }

      doc.setTextColor(0, 0, 0);
      doc.setFontSize(fontSize);
      doc.text(textValue, drawX, drawY);
    });
  });

  downloadBlob(doc.output('blob'), outputFileName);
}

export function downloadHtmlTextFile(htmlText, fileName = 'document.pdf') {
  downloadBlob(
    new Blob([String(htmlText ?? '')], { type: 'text/plain;charset=utf-8' }),
    makeHtmlStructureFileName(fileName)
  );
}

export function makeHtmlConvertedFileName(fileName = 'document.pdf') {
  const baseName = fileName.replace(/\.pdf$/i, '');

  return `${baseName}_html_converted.pdf`;
}

async function registerPreferredKoreanFont(doc) {
  if (selectedKoreanFontName) {
    doc.setFont(selectedKoreanFontName, 'normal');
    return selectedKoreanFontName;
  }

  if (preferredFontRegistrationAttempted) {
    return null;
  }

  preferredFontRegistrationAttempted = true;

  for (const fontDefinition of FONT_DEFINITIONS) {
    try {
      const fontBase64 = await loadFontBase64(fontDefinition.candidates);

      if (!fontBase64) {
        console.warn('[PdfFont] font base64 missing:', fontDefinition.pdfFontName);
        continue;
      }

      doc.addFileToVFS(fontDefinition.fileName, fontBase64);
      doc.addFont(fontDefinition.fileName, fontDefinition.pdfFontName, 'normal');
      doc.setFont(fontDefinition.pdfFontName, 'normal');
      registeredFonts.add(fontDefinition.pdfFontName);
      selectedKoreanFontName = fontDefinition.pdfFontName;

      if (fontDefinition.pdfFontName === 'MalgunGothic') {
        console.log('[PdfFont] MalgunGothic registered and selected');
      } else {
        console.log('[PdfFont] fallback NotoSansKR registered and selected');
      }

      return selectedKoreanFontName;
    } catch (error) {
      console.warn(`[PdfFont] failed to register ${fontDefinition.pdfFontName}:`, error);
    }
  }

  console.warn('[PdfFont] no Korean font registered. Use default font.');
  return null;
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
