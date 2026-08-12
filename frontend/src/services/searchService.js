import { FEATURE_MESSAGES } from '../utils/constants';

export function getFeatureMessage(featureKey) {
  return FEATURE_MESSAGES[featureKey] || '이 기능은 준비 중입니다.';
}

function isWordSeparator(char) {
  return char === ' ' || char === '\n' || char === '\t';
}

function extractMatchedWord(lineText, foundIndex, keyword) {
  const startTarget = foundIndex;
  const endTarget = foundIndex + keyword.length;

  let start = startTarget;
  let end = endTarget;

  while (start > 0 && !isWordSeparator(lineText[start - 1])) {
    start -= 1;
  }

  while (end < lineText.length && !isWordSeparator(lineText[end])) {
    end += 1;
  }

  return lineText.slice(start, end).trim();
}

export function searchKeywordInDocument(documentText, keyword) {
  const normalizedKeyword = keyword?.trim();

  if (!normalizedKeyword) {
    return [];
  }

  if (!Array.isArray(documentText) || documentText.length === 0) {
    return [];
  }

  const loweredKeyword = normalizedKeyword.toLowerCase();
  const results = [];

  documentText.forEach((pageData) => {
    const pageNumber = pageData.page;
    const lines = Array.isArray(pageData.lines) ? pageData.lines : [];

    lines.forEach((lineText, index) => {
      const rawLineText = String(lineText);
      const normalizedLine = rawLineText.toLowerCase();
      let startIndex = 0;

      while (true) {
        const foundIndex = normalizedLine.indexOf(loweredKeyword, startIndex);

        if (foundIndex === -1) {
          break;
        }

        results.push({
          page: pageNumber,
          line: index + 1,
          keyword: extractMatchedWord(rawLineText, foundIndex, normalizedKeyword)
        });

        startIndex = foundIndex + loweredKeyword.length;
      }
    });
  });

  console.log('[search keyword]', normalizedKeyword);
  console.log('[search results]', results);

  return results;
}

export async function searchInDocument() {
  // TODO: Spring Boot 테스트 API 또는 Electron 로컬 인덱싱 로직으로 대체합니다.
  return [];
}
