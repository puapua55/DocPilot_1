import {
  normalizeDocumentFile,
  validateDocumentFile
} from './fileService';
import { extractWordContentForDev, getWordPreviewModel, isWordDocument } from './docxService';
import { getPdfPreviewModel, isPdfDocument } from './pdfService';
import { saveDocumentForDev } from './storageService';

function createDocumentInfo(type, documentText = []) {
  return {
    type,
    // PDF page dimensions are available only after PDF.js opens the file in
    // the viewer. Keep metadata creation synchronous so a file selection can
    // never fail before that viewer initialization starts.
    pageCount: type === 'docx' ? Math.max(1, documentText.length) : null,
    widthMm: null,
    heightMm: null,
    widthPt: null,
    heightPt: null,
    widthPx: null,
    heightPx: null,
    orientation: null,
    note: type === 'pdf' ? 'PDF 뷰어에서 페이지 정보를 읽는 중입니다.' : ''
  };
}

export async function openDocument(file) {
  const validation = validateDocumentFile(file);
  if (!validation.valid) {
    return {
      ok: false,
      errorMessage: validation.message,
      documentFile: null,
      preview: null
    };
  }

  const documentFile = normalizeDocumentFile(file);

  if (isPdfDocument(documentFile)) {
    // Let the viewer load the PDF and extract text in the background so that
    // preview activation and error reporting do not wait for text extraction.
    const documentText = [];
    const documentInfo = createDocumentInfo('pdf', documentText);

    return {
      ok: true,
      errorMessage: '',
      documentFile: {
        ...documentFile,
        documentText,
        documentInfo
      },
      preview: {
        ...getPdfPreviewModel(documentFile),
        documentText,
        documentInfo
      },
      documentText,
      documentInfo
    };
  }

  if (isWordDocument(documentFile)) {
    const docxPreview = await extractWordContentForDev(file);
    const documentText = docxPreview.documentText || [];
    const documentInfo = createDocumentInfo('docx', documentText);

    console.log('[DOCX] text pages:', documentText.length);
    console.log('[DOCX] conversion messages:', docxPreview.messages);

    return {
      ok: true,
      errorMessage: '',
      documentFile: {
        ...documentFile,
        documentText,
        documentInfo
      },
      preview: {
        ...getWordPreviewModel(documentFile, docxPreview),
        documentText
      },
      documentText,
      documentInfo
    };
  }

  return {
    ok: false,
    errorMessage: '지원하지 않는 문서 형식입니다.',
    documentFile: null,
    preview: null
  };
}

export async function saveCurrentDocument(documentFile) {
  return saveDocumentForDev(documentFile);
}
