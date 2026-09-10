import mammoth from 'mammoth';
import JSZip from 'jszip';
import { isWordFile } from '../utils/fileUtils';

const DOCX_EXTENSION = '.docx';
const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL'
]);
const ALLOWED_CLASSES = new Set(['docx-page-break']);
const DOCX_STYLE_MAP = [
  "br[type='page'] => hr.docx-page-break:fresh"
];
const EMPTY_PARAGRAPHS_FOR_PAGE_SPLIT = 8;
const WORDPROCESSINGML_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const TWIPS_TO_PIXELS = 96 / 1440;

function isDocxFile(file) {
  return file?.name?.toLowerCase().endsWith(DOCX_EXTENSION);
}

function isSafeLink(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('#') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('mailto:');
}

function sanitizeMammothHtml(html) {
  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = document.body.firstElementChild;

  if (!root) {
    return '';
  }

  root.querySelectorAll('*').forEach((element) => {
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      return;
    }

    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      const isAllowed =
        (name === 'class' && String(value).split(/\s+/).every((className) => ALLOWED_CLASSES.has(className))) ||
        (element.tagName === 'A' && ['href', 'title'].includes(name)) ||
        (element.tagName === 'IMG' && ['src', 'alt', 'title'].includes(name)) ||
        (['TD', 'TH'].includes(element.tagName) && ['colspan', 'rowspan'].includes(name));

      if (!isAllowed) {
        element.removeAttribute(attribute.name);
      } else if (element.tagName === 'A' && name === 'href' && !isSafeLink(value)) {
        element.removeAttribute(attribute.name);
      } else if (element.tagName === 'IMG' && name === 'src' && !String(value).startsWith('data:image/')) {
        element.removeAttribute(attribute.name);
      }
    });

    if (element.tagName === 'A') {
      element.setAttribute('rel', 'noreferrer noopener');
    }
  });

  return root.innerHTML;
}

function createSearchText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.length > 0 ? [{ page: 1, lines }] : [];
}

function isEmptyParagraph(element) {
  if (element.tagName !== 'w:p') {
    return false;
  }

  return !String(element.textContent || '').trim();
}

function getEstimatedTableHeight(table, pageLayout) {
  const rowCount = Array.from(table?.children || []).filter(
    (child) => child.tagName === 'w:tr' || child.localName === 'tr'
  ).length;
  return Math.max(rowCount, 1) * (pageLayout?.lineHeight || 24);
}

function findTablePageSplits(documentXml, pageLayout) {
  const parser = new DOMParser();
  const document = parser.parseFromString(documentXml, 'application/xml');
  const body = document.getElementsByTagName('w:body')[0];

  if (!body) {
    return [];
  }

  const splits = [];
  let tableIndex = 0;
  let emptyParagraphsAfterTable = 0;
  let hasPreviousTable = false;
  let contentOffset = 0;
  let previousTablePage = 0;
  const contentHeight = Math.max(
    1,
    (pageLayout?.height || 1123) - (pageLayout?.top || 72) - (pageLayout?.bottom || 72)
  );
  const emptyParagraphHeight = pageLayout?.emptyParagraphHeight || 67.2;

  Array.from(body.children).forEach((element) => {
    if (element.tagName === 'w:tbl') {
      const tableHeight = getEstimatedTableHeight(element, pageLayout);
      if (hasPreviousTable && emptyParagraphsAfterTable >= EMPTY_PARAGRAPHS_FOR_PAGE_SPLIT) {
        let tablePage = Math.floor(contentOffset / contentHeight);
        let leadingSpace = contentOffset % contentHeight;

        if (leadingSpace + tableHeight > contentHeight) {
          tablePage += 1;
          leadingSpace = 0;
        }

        // The blank paragraph run continues after the inserted blank page.
        // Keep its remaining vertical position instead of pinning the next
        // table to the page top when the estimated flow crosses a boundary.
        if (tablePage > previousTablePage + 1) {
          leadingSpace = Math.max(leadingSpace, contentHeight * 0.82);
        }

        splits.push({
          tableIndex,
          leadingSpace: Math.max(0, leadingSpace),
          // A long run of blank paragraphs in this lightweight renderer
          // represents the single intentional blank page between contents.
          // Do not turn accumulated grid-estimation error into extra pages.
          emptyPageCount: Math.min(1, Math.max(0, tablePage - previousTablePage - 1))
        });
        contentOffset = (tablePage * contentHeight) + leadingSpace;
        previousTablePage = tablePage;
      }

      contentOffset += tableHeight;
      tableIndex += 1;
      hasPreviousTable = true;
      emptyParagraphsAfterTable = 0;
      return;
    }

    if (hasPreviousTable && isEmptyParagraph(element)) {
      emptyParagraphsAfterTable += 1;
      contentOffset += emptyParagraphHeight;
      return;
    }

    emptyParagraphsAfterTable = 0;
  });

  return splits;
}

function insertPageBreaksBeforeTables(html, tableSplits) {
  if (!tableSplits.length) {
    return html;
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = document.body.firstElementChild;

  if (!root) {
    return html;
  }

  Array.from(root.children).forEach((element) => {
    if (element.tagName !== 'TABLE') {
      return;
    }

    const tableIndex = Array.from(root.children)
      .slice(0, Array.from(root.children).indexOf(element) + 1)
      .filter((child) => child.tagName === 'TABLE').length - 1;

    const split = tableSplits.find((entry) => entry.tableIndex === tableIndex);
    if (split) {
      const addPageBreak = () => {
        const pageBreak = document.createElement('hr');
        pageBreak.className = 'docx-page-break';
        element.before(pageBreak);
      };
      addPageBreak();
      Array.from({ length: split.emptyPageCount || 0 }).forEach(addPageBreak);

      if (split.leadingSpace > 0) {
        const spacer = document.createElement('div');
        spacer.className = 'docx-page-leading-spacer';
        spacer.style.height = `${split.leadingSpace}px`;
        element.before(spacer);
      }
    }
  });

  return root.innerHTML;
}

function getWordAttribute(element, name) {
  if (!element) {
    return '';
  }

  return element.getAttribute(`w:${name}`)
    || element.getAttributeNS(WORDPROCESSINGML_NAMESPACE, name)
    || element.getAttribute(name)
    || '';
}

function getWordChild(element, name) {
  return Array.from(element?.children || []).find(
    (child) => child.tagName === `w:${name}` || child.localName === name
  ) || null;
}

function getWordDescendants(element, name) {
  return Array.from(element?.getElementsByTagName(`w:${name}`) || []);
}

function getDocxWidth(value, type) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return '';
  }

  if (type === 'pct') {
    return `${numericValue / 50}%`;
  }

  if (type === 'dxa' || !type) {
    return `${numericValue * TWIPS_TO_PIXELS}px`;
  }

  return '';
}

function getTwipsInPixels(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? numericValue * TWIPS_TO_PIXELS
    : fallback;
}

function getDocxPageLayout(documentXml) {
  const document = new DOMParser().parseFromString(documentXml, 'application/xml');
  if (document.querySelector('parsererror')) {
    return null;
  }

  const sectionProperties = getWordDescendants(document, 'sectPr').at(-1);
  const pageSize = getWordChild(sectionProperties, 'pgSz');
  const pageMargins = getWordChild(sectionProperties, 'pgMar');
  const documentGrid = getWordChild(sectionProperties, 'docGrid');
  if (!pageSize && !pageMargins) {
    return null;
  }

  const lineHeight = getTwipsInPixels(getWordAttribute(documentGrid, 'linePitch'), 24);
  return {
    width: getTwipsInPixels(getWordAttribute(pageSize, 'w'), 794),
    height: getTwipsInPixels(getWordAttribute(pageSize, 'h'), 1123),
    top: getTwipsInPixels(getWordAttribute(pageMargins, 'top'), 72),
    right: getTwipsInPixels(getWordAttribute(pageMargins, 'right'), 68),
    bottom: getTwipsInPixels(getWordAttribute(pageMargins, 'bottom'), 72),
    left: getTwipsInPixels(getWordAttribute(pageMargins, 'left'), 68),
    lineHeight,
    // Mammoth omits empty paragraphs. In this DOCX layout an empty paragraph
    // advances the Word line grid, paragraph mark, and paragraph-after gap.
    // Preserve all three so following content stays at its original height.
    emptyParagraphHeight: lineHeight * 2.8
  };
}

function isWordBooleanEnabled(element) {
  const value = String(getWordAttribute(element, 'val')).toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

function getForcedPageBreakInfo(documentXml, stylesXml = '') {
  const document = new DOMParser().parseFromString(documentXml, 'application/xml');
  if (document.querySelector('parsererror')) {
    return { hasForcedPageBreak: false, count: 0 };
  }

  const manualBreakCount = getWordDescendants(document, 'br').filter((breakElement) => (
    getWordAttribute(breakElement, 'type') === 'page'
  )).length;
  const paragraphPageBreakCount = getWordDescendants(document, 'pageBreakBefore')
    .filter(isWordBooleanEnabled).length;

  let styledPageBreakCount = 0;
  if (stylesXml) {
    const stylesDocument = new DOMParser().parseFromString(stylesXml, 'application/xml');
    if (!stylesDocument.querySelector('parsererror')) {
      const styleById = new Map(getWordDescendants(stylesDocument, 'style')
        .filter((style) => getWordAttribute(style, 'type') === 'paragraph')
        .map((style) => [getWordAttribute(style, 'styleId'), style]));
      const hasPageBreakBefore = (styleId, visited = new Set()) => {
        if (!styleId || visited.has(styleId)) return false;
        visited.add(styleId);
        const style = styleById.get(styleId);
        if (!style) return false;
        const properties = getWordChild(style, 'pPr');
        const pageBreakBefore = getWordChild(properties, 'pageBreakBefore');
        if (pageBreakBefore && isWordBooleanEnabled(pageBreakBefore)) return true;
        return hasPageBreakBefore(getWordAttribute(getWordChild(properties, 'basedOn'), 'val'), visited);
      };

      const usedParagraphStyles = new Set(getWordDescendants(document, 'p')
        .map((paragraph) => getWordAttribute(getWordChild(getWordChild(paragraph, 'pPr'), 'pStyle'), 'val'))
        .filter(Boolean));
      styledPageBreakCount = [...usedParagraphStyles].filter((styleId) => hasPageBreakBefore(styleId)).length;
    }
  }

  const count = manualBreakCount + paragraphPageBreakCount + styledPageBreakCount;

  return { hasForcedPageBreak: count > 0, count };
}

function getParagraphAlignment(paragraph) {
  const alignment = getWordAttribute(getWordChild(getWordChild(paragraph, 'pPr'), 'jc'), 'val');
  return {
    center: 'center',
    right: 'right',
    both: 'justify',
    distribute: 'justify',
    left: 'left'
  }[alignment] || '';
}

function getParagraphText(paragraph) {
  return getWordDescendants(paragraph, 't')
    .map((text) => text.textContent || '')
    .join('')
    .trim();
}

function getTableStyleProperties(tableXml, stylesDocument) {
  const tableProperties = getWordChild(tableXml, 'tblPr');
  const styleId = getWordAttribute(getWordChild(tableProperties, 'tblStyle'), 'val');
  if (!styleId || !stylesDocument) {
    return null;
  }

  const tableStyle = getWordDescendants(stylesDocument, 'style').find((style) => (
    getWordAttribute(style, 'type') === 'table'
      && getWordAttribute(style, 'styleId') === styleId
  ));
  return getWordChild(tableStyle, 'tblPr');
}

function getTableBorderCss(tableProperties, styleProperties) {
  const borders = getWordChild(tableProperties, 'tblBorders')
    || getWordChild(styleProperties, 'tblBorders');
  const border = getWordChild(borders, 'insideH')
    || getWordChild(borders, 'insideV')
    || getWordChild(borders, 'top');
  const borderType = getWordAttribute(border, 'val');

  if (!border || borderType === 'nil' || borderType === 'none') {
    return '';
  }

  const rawColor = getWordAttribute(border, 'color');
  const color = /^[0-9a-f]{6}$/i.test(rawColor) ? `#${rawColor}` : '#000000';
  const width = Math.max(1, (Number(getWordAttribute(border, 'sz')) || 4) / 6);
  const style = {
    dashed: 'dashed',
    dotted: 'dotted',
    double: 'double'
  }[borderType] || 'solid';

  return `${width}px ${style} ${color}`;
}

function getTableCellPadding(tableProperties, styleProperties) {
  const cellMargins = getWordChild(tableProperties, 'tblCellMar')
    || getWordChild(styleProperties, 'tblCellMar');
  if (!cellMargins) {
    return '';
  }

  const getSide = (side, fallback) => (
    getDocxWidth(getWordAttribute(getWordChild(cellMargins, side), 'w'), 'dxa') || fallback
  );
  return [
    getSide('top', '0px'),
    getSide('right', '7.2px'),
    getSide('bottom', '0px'),
    getSide('left', '7.2px')
  ].join(' ');
}

function applyTableLayout(table, tableXml, stylesDocument) {
  const tableProperties = getWordChild(tableXml, 'tblPr');
  const styleProperties = getTableStyleProperties(tableXml, stylesDocument);
  const tableWidth = getWordChild(tableProperties, 'tblW');
  const gridColumns = Array.from(getWordChild(tableXml, 'tblGrid')?.children || [])
    .filter((column) => column.tagName === 'w:gridCol' || column.localName === 'gridCol')
    .map((column) => getDocxWidth(getWordAttribute(column, 'w'), 'dxa'))
    .filter(Boolean);
  const width = getDocxWidth(
    getWordAttribute(tableWidth, 'w'),
    getWordAttribute(tableWidth, 'type')
  ) || (gridColumns.length > 0
    ? `${gridColumns.reduce((total, column) => total + Number.parseFloat(column), 0)}px`
    : '');

  if (width) {
    table.style.width = width;
    table.dataset.docxTableWidth = 'true';
  }

  const border = getTableBorderCss(tableProperties, styleProperties);
  if (border) {
    table.style.setProperty('--docx-table-border', border);
  }

  const cellPadding = getTableCellPadding(tableProperties, styleProperties);
  if (cellPadding) {
    table.style.setProperty('--docx-table-cell-padding', cellPadding);
  }

  if (gridColumns.length > 0) {
    const colgroup = document.createElement('colgroup');
    gridColumns.forEach((columnWidth) => {
      const column = document.createElement('col');
      column.style.width = columnWidth;
      colgroup.appendChild(column);
    });
    table.prepend(colgroup);
  }
}

function applyDocxLayout(html, documentXml, stylesXml = '') {
  const htmlDocument = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const htmlRoot = htmlDocument.body.firstElementChild;
  const xmlDocument = new DOMParser().parseFromString(documentXml, 'application/xml');
  const parsedStylesDocument = stylesXml
    ? new DOMParser().parseFromString(stylesXml, 'application/xml')
    : null;
  const stylesDocument = parsedStylesDocument?.querySelector('parsererror')
    ? null
    : parsedStylesDocument;

  if (!htmlRoot || xmlDocument.querySelector('parsererror')) {
    return html;
  }

  // Mammoth omits empty Word paragraphs. Match only visible text blocks so a
  // run of blank paragraphs (for example before a later-page table) cannot
  // shift the alignment onto the wrong HTML element.
  const htmlBlocks = Array.from(
    htmlRoot.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre')
  ).filter((block) => block.textContent?.trim());
  const xmlParagraphs = getWordDescendants(xmlDocument, 'p').filter(getParagraphText);

  xmlParagraphs.forEach((paragraph, index) => {
    const alignment = getParagraphAlignment(paragraph);
    if (alignment && htmlBlocks[index]) {
      htmlBlocks[index].style.textAlign = alignment;
      htmlBlocks[index].dataset.docxTextAlign = alignment;
    }
  });

  const htmlTables = Array.from(htmlRoot.querySelectorAll('table'));
  getWordDescendants(xmlDocument, 'tbl').forEach((tableXml, index) => {
    if (htmlTables[index]) {
      applyTableLayout(htmlTables[index], tableXml, stylesDocument);
    }
  });

  return htmlRoot.innerHTML;
}

async function createLayoutAdjustedHtml(arrayBuffer, html) {
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      return { html, pageLayout: null, hasForcedPageBreak: false, forcedPageBreakCount: 0 };
    }

    let stylesXml = '';
    try {
      stylesXml = await zip.file('word/styles.xml')?.async('string') || '';
    } catch (error) {
      console.warn('[DOCX] table style extraction failed:', error);
    }

    const pageLayout = getDocxPageLayout(documentXml);
    const forcedPageBreak = getForcedPageBreakInfo(documentXml, stylesXml);
    const layoutHtml = applyDocxLayout(html, documentXml, stylesXml);
    return {
      html: insertPageBreaksBeforeTables(layoutHtml, findTablePageSplits(documentXml, pageLayout)),
      pageLayout,
      hasForcedPageBreak: forcedPageBreak.hasForcedPageBreak,
      forcedPageBreakCount: forcedPageBreak.count
    };
  } catch (error) {
    console.warn('[DOCX] layout page split detection failed:', error);
    return { html, pageLayout: null, hasForcedPageBreak: false, forcedPageBreakCount: 0 };
  }
}

export function isWordDocument(documentFile) {
  return isWordFile(documentFile?.file);
}

export function getWordPreviewModel(documentFile, docxPreview = {}) {
  return {
    type: 'word',
    fileName: documentFile.name,
    fileSize: documentFile.size,
    html: docxPreview.html || '',
    pageLayout: docxPreview.pageLayout || null,
    renderMode: docxPreview.hasForcedPageBreak ? 'original-page-layout' : 'html-preview',
    forcedPageBreakCount: docxPreview.forcedPageBreakCount || 0,
    messages: docxPreview.messages || [],
    renderError: docxPreview.renderError || ''
  };
}

export async function extractWordContentForDev(file) {
  if (!isDocxFile(file)) {
    return {
      html: '',
      documentText: [],
      messages: [],
      renderError: '구형 DOC 형식은 현재 미리보기를 지원하지 않습니다. DOCX 파일로 저장한 뒤 다시 선택해주세요.'
    };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const [htmlResult, textResult] = await Promise.all([
      mammoth.convertToHtml({ arrayBuffer }, { styleMap: DOCX_STYLE_MAP }),
      mammoth.extractRawText({ arrayBuffer })
    ]);

    const sanitizedHtml = sanitizeMammothHtml(htmlResult.value);

    const layoutResult = await createLayoutAdjustedHtml(arrayBuffer, sanitizedHtml);

    return {
      html: layoutResult.html,
      pageLayout: layoutResult.pageLayout,
      hasForcedPageBreak: layoutResult.hasForcedPageBreak,
      forcedPageBreakCount: layoutResult.forcedPageBreakCount,
      documentText: createSearchText(textResult.value),
      messages: htmlResult.messages || [],
      renderError: ''
    };
  } catch (error) {
    console.error('[DOCX] preview failed:', error);
    return {
      html: '',
      documentText: [],
      messages: [],
      hasForcedPageBreak: false,
      forcedPageBreakCount: 0,
      renderError: 'DOCX 문서를 표시하지 못했습니다. 파일이 손상되지 않았는지 확인해주세요.'
    };
  }
}
