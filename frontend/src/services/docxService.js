export function isWordDocument(documentFile) {
  return documentFile?.extension === 'doc' || documentFile?.extension === 'docx';
}

export function getWordPreviewModel(documentFile) {
  return {
    type: 'word',
    fileName: documentFile.name,
    fileSize: documentFile.size
  };
}

export async function extractWordContentForDev(file) {
  void file;

  // TODO: 현재는 미리보기 안내만 제공합니다.
  // TODO: Spring Boot 테스트 API 또는 Electron 로컬 파서로 교체 가능한 지점입니다.
  return null;
}
