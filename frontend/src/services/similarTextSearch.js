const MAX_QUERY_LENGTH = 100;
const MAX_WINDOW_WORDS = 12;

function normalized(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function editDistance(first, second) {
  let beforePrevious = null;
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex];
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current[secondIndex] = Math.min(
        current[secondIndex - 1] + 1,
        previous[secondIndex] + 1,
        previous[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1)
      );
      if (beforePrevious && firstIndex > 1 && secondIndex > 1
        && first[firstIndex - 1] === second[secondIndex - 2]
        && first[firstIndex - 2] === second[secondIndex - 1]) {
        current[secondIndex] = Math.min(current[secondIndex], beforePrevious[secondIndex - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[second.length];
}

function similarity(first, second) {
  if (first === second) return 1;
  const longer = Math.max(first.length, second.length);
  return longer ? 1 - editDistance(first, second) / longer : 0;
}

/** Find literal text that the document's ordinary search can search again. */
export function findSimilarDocumentTexts(segments, keyword, limit = 5) {
  const target = normalized(keyword);
  if (target.length < 2 || target.length > MAX_QUERY_LENGTH || !Array.isArray(segments)) return [];

  const queryWords = String(keyword).trim().split(/\s+/u).length;
  const maxWords = Math.min(MAX_WINDOW_WORDS, Math.max(3, queryWords + 3, Math.ceil(target.length / 2) + 1));
  const minimumScore = target.length < 4 ? 0.5 : target.length < 5 ? 0.65 : 0.6;
  const bestByText = new Map();
  let order = 0;

  segments.forEach((segment) => {
    const text = String(typeof segment === 'string' ? segment : segment?.text || '').trim();
    if (!text) return;
    const words = [...text.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)]
      .map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
    for (let start = 0; start < words.length; start += 1) {
      for (let end = start; end < Math.min(words.length, start + maxWords); end += 1) {
        const candidate = text.slice(words[start].start, words[end].end);
        const candidateKey = normalized(candidate);
        if (candidateKey.length < Math.max(2, Math.floor(target.length * 0.6))
          || candidateKey.length > Math.ceil(target.length * 1.5)) continue;
        const score = similarity(target, candidateKey);
        if (score < minimumScore) continue;
        const existing = bestByText.get(candidateKey);
        if (!existing || score > existing.score) {
          bestByText.set(candidateKey, { text: candidate, score, order });
        }
        order += 1;
      }
    }
  });

  const ranked = [...bestByText.values()]
    .sort((first, second) => second.score - first.score || first.order - second.order);
  const selected = [];
  for (const candidate of ranked) {
    const key = normalized(candidate.text);
    if (selected.some((other) => {
      const otherKey = normalized(other.text);
      return key.includes(otherKey) || otherKey.includes(key);
    })) continue;
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected.map(({ text }) => text);
}
