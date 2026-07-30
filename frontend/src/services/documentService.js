import {
  normalizeDocumentFile,
  uploadDocumentForDev,
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

  await uploadDocumentForDev(file);

  if (isPdfDocument(documentFile)) {
    return {
      ok: true,
      errorMessage: '',
      documentFile,
      preview: getPdfPreviewModel(documentFile)
    };
  }

  if (isWordDocument(documentFile)) {
    await extractWordContentForDev(file);

    return {
      ok: true,
      errorMessage: '',
      documentFile,
      preview: getWordPreviewModel(documentFile)
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
