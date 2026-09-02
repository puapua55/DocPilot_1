import { jsPDF } from 'jspdf';
import {
  extractPdfToHtmlStructure,
  isPageEdgeArtifactLine
} from './pdfHtmlStructureService';
import {
  registerAvailablePdfFonts,
  resolvePdfFontName,
  setPdfFontSafe
} from './pdfFontRegistry';

const TEXT_BASELINE_RATIO = 0.85;

function parsePx(value) {
  return Number(String(value || '').replace('px', '').trim()) || 0;
}

function getStylePx(element, propertyName) {
  return parsePx(element?.style?.[propertyName]);
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

  const registeredFonts = await registerAvailablePdfFonts(doc);
  const selectedFontName = resolvePdfFontName(firstPage.texts?.[0]?.fontFamily || 'MalgunGothic', registeredFonts);

  console.log('[PdfFont] selectedFontName:', selectedFontName);
  console.log('[PdfFont] available:', Array.from(registeredFonts));
  console.log('[PdfFont] fontList:', doc.getFontList?.());

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
      const requestedFont = textItem.fontFamily || 'MalgunGothic';
      const resolvedFont = resolvePdfFontName(requestedFont, registeredFonts);

      console.log('[PdfText] draw:', {
        textValue,
        requestedFont,
        resolvedFont,
        registeredFonts: Array.from(registeredFonts),
        drawX,
        drawY,
        fontSize,
        selectedFontName,
        index: textIndex
      });

      doc.setTextColor(0, 0, 0);
      doc.setFontSize(fontSize);

      if (resolvedFont) {
        setPdfFontSafe(doc, resolvedFont, registeredFonts);
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
