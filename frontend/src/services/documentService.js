import {
  normalizeDocumentFile,
  validateDocumentFile
} from './fileService';
import { extractWordContentForDev, getWordPreviewModel, isWordDocument } from './docxService';
import { getPdfPreviewModel, isPdfDocument } from './pdfService';
import { saveDocumentForDev } from './storageService';

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

    return {
      ok: true,
      errorMessage: '',
      documentFile: {
        ...documentFile,
        documentText
      },
      preview: {
        ...getPdfPreviewModel(documentFile),
        documentText
      },
      documentText
    };
  }

  if (isWordDocument(documentFile)) {
    const docxPreview = await extractWordContentForDev(file);
    const documentText = docxPreview.documentText || [];

    console.log('[DOCX] text pages:', documentText.length);
    console.log('[DOCX] conversion messages:', docxPreview.messages);

    return {
      ok: true,
      errorMessage: '',
      documentFile: {
        ...documentFile,
        documentText
      },
      preview: {
        ...getWordPreviewModel(documentFile, docxPreview),
        documentText
      },
      documentText
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
