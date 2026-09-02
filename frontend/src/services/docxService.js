import mammoth from 'mammoth';
import { isWordFile } from '../utils/fileUtils';

const DOCX_EXTENSION = '.docx';
const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL'
]);

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

export function isWordDocument(documentFile) {
  return isWordFile(documentFile?.file);
}

export function getWordPreviewModel(documentFile, docxPreview = {}) {
  return {
    type: 'docx',
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
      mammoth.convertToHtml({ arrayBuffer }),
      mammoth.extractRawText({ arrayBuffer })
    ]);

    return {
      html: sanitizeMammothHtml(htmlResult.value),
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

export async function getWordDocumentInfo(file) {
  if (!file || !isWordFile(file)) {
    return {
      type: 'docx',
      pageCount: 0,
      widthMm: 210,
      heightMm: 297,
      widthPt: 595.28,
      heightPt: 841.89,
      widthPx: 794,
      heightPx: 1123,
      orientation: 'portrait'
    };
  }

  return {
    type: 'docx',
    pageCount: 1,
    widthMm: 210,
    heightMm: 297,
    widthPt: 595.28,
    heightPt: 841.89,
    widthPx: 794,
    heightPx: 1123,
    orientation: 'portrait',
    note: '기본 DOCX 문서 크기는 A4 기준(210x297 mm)으로 계산됩니다.'
  };
}
