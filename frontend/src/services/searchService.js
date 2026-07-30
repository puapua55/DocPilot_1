import { FEATURE_MESSAGES } from '../utils/constants';

export function getFeatureMessage(featureKey) {
  return FEATURE_MESSAGES[featureKey] || '이 기능은 준비 중입니다.';
}

export async function searchInDocument() {
  // TODO: Spring Boot 테스트 API 또는 Electron 로컬 인덱싱 로직으로 대체합니다.
  return [];
}
