// An exported overlay PDF may retain source text under a painted replacement.
// PDF.js returns both text runs even though only the later run is visible.
// Keep the top run in the selectable text layer when it covers the earlier
// run at the same PDF baseline.
export function visibleTextItemIndices(items = []) {
  const entries = items.map((item, index) => {
    const transform = item?.transform;
    const x = Number(transform?.[4]);
    const y = Number(transform?.[5]);
    const width = Number(item?.width);
    const fontSize = Math.hypot(Number(transform?.[0]) || 0, Number(transform?.[1]) || 0);
    return { index, text: String(item?.str || ''), x, y, width, fontSize,
      horizontal: Math.abs(Number(transform?.[1]) || 0) < 0.01 && Math.abs(Number(transform?.[2]) || 0) < 0.01 };
  });
  const hidden = new Set();
  entries.forEach((source, index) => {
    if (!source.text || !source.horizontal || !Number.isFinite(source.x) || !Number.isFinite(source.y)
      || !Number.isFinite(source.width) || source.width <= 0) return;
    const baselineTolerance = Math.max(0.5, Math.min(1.5, source.fontSize * 0.08));
    const later = entries.slice(index + 1).filter((candidate) => candidate.horizontal
      && candidate.text && Number.isFinite(candidate.x) && Number.isFinite(candidate.y)
      && Math.abs(candidate.y - source.y) <= baselineTolerance);
    if (/^\s+$/.test(source.text)) {
      if (later.some((candidate) => /^\s+$/.test(candidate.text) && Math.abs(candidate.x - source.x) <= 1)) hidden.add(source.index);
      return;
    }
    const intervals = later.filter((candidate) => !/^\s+$/.test(candidate.text) && candidate.width > 0)
      .map((candidate) => [Math.max(source.x, candidate.x), Math.min(source.x + source.width, candidate.x + candidate.width)])
      .filter(([left, right]) => right > left)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let right = source.x;
    intervals.forEach(([left, end]) => {
      covered += Math.max(0, end - Math.max(left, right));
      right = Math.max(right, end);
    });
    if (covered >= source.width * 0.85) hidden.add(source.index);
  });
  const order = (entry) => {
    if (!entry.text || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return entry.index;
    const replaced = entries.slice(0, entry.index).filter((source) => hidden.has(source.index)
      && Math.abs(source.y - entry.y) <= Math.max(0.5, Math.min(1.5, source.fontSize * 0.08))
      && entry.x < source.x + source.width && entry.x + Math.max(entry.width, 0) > source.x);
    if (!replaced.length) return entry.index;
    const source = replaced[0];
    return source.index + Math.max(0, Math.min(0.99, (entry.x - source.x) / Math.max(source.width, 1)));
  };
  return entries.filter((entry) => !hidden.has(entry.index))
    .map((entry) => ({ index: entry.index, order: order(entry) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.index);
}
