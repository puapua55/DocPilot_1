import { FEATURE_MESSAGES } from '../utils/constants';

export function getFeatureMessage(featureKey) {
  return FEATURE_MESSAGES[featureKey] || '이 기능은 준비 중입니다.';
}

function isWordSeparator(char) {
  return char == null || char === ' ' || char === '\n' || char === '\t';
}

function isExactMatch(text, startIndex, keywordLength) {
  const before = startIndex > 0 ? text[startIndex - 1] : null;
  const afterIndex = startIndex + keywordLength;
  const after = afterIndex < text.length ? text[afterIndex] : null;
  return isWordSeparator(before) && isWordSeparator(after);
}

function findKeywordMatches(lineText, keyword, matchMode) {
  const loweredLine = lineText.toLowerCase();
  const loweredKeyword = keyword.toLowerCase();
  const matches = [];
  let startIndex = 0;

  while (startIndex <= loweredLine.length - loweredKeyword.length) {
    const foundIndex = loweredLine.indexOf(loweredKeyword, startIndex);
    if (foundIndex === -1) break;

    if (matchMode !== 'exact' || isExactMatch(lineText, foundIndex, keyword.length)) {
      matches.push(foundIndex);
    }

    startIndex = foundIndex + Math.max(loweredKeyword.length, 1);
  }

  return matches;
}

export function searchKeywordInDocument(documentText, keyword, options = {}) {
  const normalizedKeyword = keyword?.trim();
  const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';

  if (!normalizedKeyword || !Array.isArray(documentText) || documentText.length === 0) {
    return [];
  }

  const results = [];

  documentText.forEach((pageData, pageIndex) => {
    const pageNumber = Number(pageData?.page ?? pageData?.pageNumber ?? pageIndex + 1) || pageIndex + 1;
    const lines = Array.isArray(pageData?.lines) ? pageData.lines : [];

    lines.forEach((lineValue, lineIndex) => {
      const rawLineText = typeof lineValue === 'string'
        ? lineValue
        : String(lineValue?.text ?? '');

      findKeywordMatches(rawLineText, normalizedKeyword, matchMode).forEach((matchIndex, occurrenceIndex) => {
        results.push({
          id: `pdf-${pageNumber}-${lineIndex + 1}-${matchIndex}-${occurrenceIndex}`,
          type: 'pdf',
          pageNumber,
          lineNumber: lineIndex + 1,
          text: rawLineText,
          keyword: normalizedKeyword,
          matchIndex,
          page: pageNumber,
          line: lineIndex + 1,
          fullText: rawLineText,
          x: null,
          y: null,
          width: null,
          height: null
        });
      });
    });
  });

  console.log('[search keyword]', normalizedKeyword);
  console.log('[search mode]', matchMode);
  console.log('[search results]', results);

  return results;
}

export async function searchInDocument() {
  // TODO: Spring Boot 테스트 API 또는 Electron 로컬 인덱싱 로직으로 대체합니다.
  return [];
}
