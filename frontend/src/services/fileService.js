import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE } from '../utils/constants';

export function getFileExtension(fileName = '') {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function validateDocumentFile(file) {
  if (!file) {
    return { valid: false, message: '문서를 선택해 주세요.' };
  }

  const extension = getFileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return {
      valid: false,
      message: '지원하지 않는 형식입니다. PDF, DOC, DOCX 문서만 열 수 있습니다.'
    };
  }

  if (file.size <= 0) {
    return {
      valid: false,
      message: '0 byte 파일은 열 수 없습니다.'
    };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      message: '문서 크기는 50MB 이하만 허용됩니다.'
    };
  }

  return { valid: true, message: '' };
}

export function pickFirstFile(files) {
  return files?.[0] ?? null;
}

export function normalizeDocumentFile(file) {
  if (!file) {
    return null;
  }

  return {
    file,
    name: file.name,
    size: file.size,
    extension: getFileExtension(file.name),
    mimeType: file.type || ''
  };
}
