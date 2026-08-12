import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE } from './constants';

export function getFileExtension(fileName = '') {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function isPdfFile(file) {
  if (!file) {
    return false;
  }

  const name = file.name?.toLowerCase?.() ?? '';
  return file.type === 'application/pdf' || name.endsWith('.pdf');
}

export function isWordFile(file) {
  if (!file) {
    return false;
  }

  const name = file.name?.toLowerCase?.() ?? '';
  return (
    file.type === 'application/msword' ||
    file.type ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.doc') ||
    name.endsWith('.docx')
  );
}

export function formatFileSize(bytes = 0) {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function validateFile(file) {
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

export { ALLOWED_EXTENSIONS, MAX_FILE_SIZE };
