import {
  normalizeDocumentFile,
  uploadDocumentForDev,
  validateDocumentFile
} from './fileService';
import { extractWordContentForDev, getWordPreviewModel, isWordDocument } from './docxService';
import { extractPdfTextByPages, getPdfPreviewModel, isPdfDocument } from './pdfService';
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

  await uploadDocumentForDev(file);

  if (isPdfDocument(documentFile)) {
    const documentText = await extractPdfTextByPages(file);

    console.log('[documentText]', documentText);
    console.log('[documentText pages]', documentText.length);

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
    const documentText = (await extractWordContentForDev(file)) || [];

    return {
      ok: true,
      errorMessage: '',
      documentFile: {
        ...documentFile,
        documentText
      },
      preview: {
        ...getWordPreviewModel(documentFile),
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
