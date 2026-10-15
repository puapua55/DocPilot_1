// Link destinations are independent of font/color/decoration. Only these
// protocols may be opened from a document or written into a PDF annotation.
export function safeHyperlink(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:', 'ftp:', 'mailto:'].includes(url.protocol)) return null;
    if (url.protocol === 'mailto:') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(decodeURIComponent(url.pathname)) ? url.href : null;
    return url.hostname ? url.href : null;
  } catch { return null; }
}

let nextLinkId = 0;
const candidates = /(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>"'\u200B]+|[\p{L}\p{N}.!#$%&*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]*\.)+[\p{L}]{2,}/giu;

export function findHyperlinks(text) {
  text = String(text || '');
  const result = [];
  for (const match of String(text || '').matchAll(candidates)) {
    if (match.index > 0 && /[\p{L}\p{N}_@]/u.test(text[match.index - 1])) continue;
    let token = match[0].replace(/[.,!;:。！，；：]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (token.endsWith(close) && token.split(close).length > token.split(open).length) token = token.slice(0, -1);
    }
    const href = safeHyperlink(/^www\./i.test(token) ? `https://${token}`
      : /^[^:]+@/u.test(token) ? `mailto:${token}` : token);
    if (href) result.push({ start: match.index, end: match.index + token.length, href });
  }
  return result;
}

export function autoLinkFontRuns(input) {
  const runs = input || [];
  const text = runs.map((run) => run.text || '').join('');
  let offset = 0;
  const positioned = runs.map((run) => {
    const start = offset;
    offset += String(run.text || '').length;
    return { run, start, end: offset };
  });
  const links = findHyperlinks(text).map((link) => {
    const overlaps = positioned.filter(({ start, end }) => start < link.end && end > link.start);
    const previous = overlaps.find(({ run }) => run.hyperlinkId && safeHyperlink(run.hyperlink));
    return {
      ...link,
      suppressed: overlaps.some(({ run }) => run.hyperlinkSuppressed === link.href),
      id: previous?.run.hyperlinkId || `auto-link-${++nextLinkId}`
    };
  });
  const output = [];
  positioned.forEach(({ run, start, end }) => {
    const matches = links.filter((link) => link.start < end && link.end > start);
    const boundaries = [...new Set([start, end, ...matches.flatMap((link) => [Math.max(start, link.start), Math.min(end, link.end)])])].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const left = boundaries[index];
      const right = boundaries[index + 1];
      const part = { ...run, text: text.slice(left, right) };
      const link = matches.find((entry) => left >= entry.start && right <= entry.end);
      if (link && !link.suppressed) {
        if (!safeHyperlink(run.hyperlink)) {
          part.hyperlinkOriginalColor = run.color || '#111111';
          part.hyperlinkOriginalDecoration = run.textDecoration || 'none';
          part.color = '#0000ff';
          part.textDecoration = 'underline';
        }
        part.hyperlink = link.href;
        part.hyperlinkId = link.id;
        part.hyperlinkAuto = true;
        part.hyperlinkSuppressed = null;
      } else if (link?.suppressed || run.hyperlinkAuto) {
        if (!link && run.hyperlinkAuto) {
          part.color = run.hyperlinkOriginalColor || '#111111';
          part.textDecoration = run.hyperlinkOriginalDecoration || 'none';
        }
        part.hyperlink = null;
        part.hyperlinkId = null;
        part.hyperlinkAuto = false;
      }
      output.push(part);
    }
  });
  return output;
}

export function removeHyperlinkFromRuns(runs, id) {
  return runs.map((run) => run.hyperlinkId === id ? {
    ...run,
    hyperlinkSuppressed: safeHyperlink(run.hyperlink),
    hyperlink: null,
    hyperlinkId: null,
    hyperlinkAuto: false
  } : run);
}
