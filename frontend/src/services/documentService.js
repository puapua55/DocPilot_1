import {
  normalizeDocumentFile,
  uploadDocumentForDev,
  validateDocumentFile
} from './fileService';
import {
  extractWordContentForDev,
  getWordDocumentInfo,
  getWordPreviewModel,
  isWordDocument
} from './docxService';
import {
  extractPdfTextByPages,
  getPdfDocumentInfo,
  getPdfPreviewModel,
  isPdfDocument
} from './pdfService';
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
    const documentInfo = await getPdfDocumentInfo(file);

    console.log('[documentText]', documentText);
    console.log('[documentText pages]', documentText.length);

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
    const documentText = (await extractWordContentForDev(file)) || [];
    const documentInfo = await getWordDocumentInfo(file);

    return {
      ok: true,
      errorMessage: '',
      documentFile: {
        ...documentFile,
        documentText,
        documentInfo
      },
      preview: {
        ...getWordPreviewModel(documentFile),
        documentText,
        documentInfo
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
