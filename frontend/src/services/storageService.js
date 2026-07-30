export async function saveDocumentForDev(documentFile) {
  void documentFile;

  // TODO: 현재 `uploads/` 저장은 Spring Boot 임시 테스트용으로만 간주합니다.
  // TODO: 최종 Electron에서는 "다른 이름으로 저장" 또는 원본 파일 덮어쓰기 흐름으로 교체합니다.
  return { saved: false, mode: 'not-configured' };
}

export async function openDocumentFromSystem() {
  // TODO: 브라우저 단계에서는 `<input type="file">`를 사용합니다.
  // TODO: Electron 전환 시 이 함수를 OS 파일 선택 대화상자 API로 교체합니다.
  return null;
}
