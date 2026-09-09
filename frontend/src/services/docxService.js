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

function findTablePageSplitIndexes(documentXml) {
  const parser = new DOMParser();
  const document = parser.parseFromString(documentXml, 'application/xml');
  const body = document.getElementsByTagName('w:body')[0];

  if (!body) {
    return [];
  }

  const splitIndexes = [];
  let tableIndex = 0;
  let emptyParagraphsAfterTable = 0;
  let hasPreviousTable = false;

  Array.from(body.children).forEach((element) => {
    if (element.tagName === 'w:tbl') {
      if (hasPreviousTable && emptyParagraphsAfterTable >= EMPTY_PARAGRAPHS_FOR_PAGE_SPLIT) {
        splitIndexes.push(tableIndex);
      }

      tableIndex += 1;
      hasPreviousTable = true;
      emptyParagraphsAfterTable = 0;
      return;
    }

    if (hasPreviousTable && isEmptyParagraph(element)) {
      emptyParagraphsAfterTable += 1;
      return;
    }

    emptyParagraphsAfterTable = 0;
  });

  return splitIndexes;
}

function insertPageBreaksBeforeTables(html, tableIndexes) {
  if (!tableIndexes.length) {
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

    if (tableIndexes.includes(tableIndex)) {
      element.before(document.createElement('hr'));
      element.previousElementSibling.className = 'docx-page-break';
    }
  });

  return root.innerHTML;
}

async function createLayoutAdjustedHtml(arrayBuffer, html) {
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      return html;
    }

    return insertPageBreaksBeforeTables(html, findTablePageSplitIndexes(documentXml));
  } catch (error) {
    console.warn('[DOCX] layout page split detection failed:', error);
    return html;
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

    return {
      html: await createLayoutAdjustedHtml(arrayBuffer, sanitizedHtml),
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
      renderError: 'DOCX 문서를 표시하지 못했습니다. 파일이 손상되지 않았는지 확인해주세요.'
    };
  }
}
