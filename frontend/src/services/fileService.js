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

export async function uploadDocumentForDev(file) {
  void file;

  // TODO: Spring Boot `/api/...` 연동이 필요해지면 이 함수 안에서만 처리합니다.
  // TODO: Electron 전환 후에는 preload/IPC 기반 파일 열기 API로 교체합니다.
  return { mode: 'local-preview' };
}
