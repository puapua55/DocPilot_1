import { OPS } from 'pdfjs-dist';

function toCssRgb(operatorArgs = []) {
  if (typeof operatorArgs[0] === 'string') return operatorArgs[0];
  const channels = [operatorArgs[0], operatorArgs[1], operatorArgs[2]].map(Number);
  if (!channels.every(Number.isFinite)) return null;
  const rgb = channels.map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function multiplyMatrices(first, second) {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5]
  ];
}

function asMatrix(value) {
  const matrix = Array.from(value || []).map(Number);
  return matrix.length === 6 && matrix.every(Number.isFinite) ? matrix : null;
}

function isBoldFontName(value = '') {
  return /(?:bold|black|heavy|semibold|demibold|extrabold|ultrabold)/i.test(String(value));
}

// PDF.js may remap embedded glyphs to private Unicode slots. The invisible
// selection layer uses ordinary text, so its CSS font family is not enough
// to reproduce the canvas font. Use PDF.js's rendered glyph mapping instead.
export async function describePdfTextFonts(page, textContent) {
  const operators = await page.getOperatorList();
  const fonts = new Map();
  const fontColors = new Map();
  const glyphRuns = [];
  let currentFont = null;
  let currentTextColor = null;
  let currentCtm = [1, 0, 0, 1, 0, 0];
  let currentTextMatrix = [1, 0, 0, 1, 0, 0];
  const stack = [];
  operators.fnArray.forEach((op, index) => {
    const args = operators.argsArray[index];
    if (op === OPS.save) stack.push({
      font: currentFont,
      textColor: currentTextColor,
      ctm: currentCtm,
      textMatrix: currentTextMatrix
    });
    else if (op === OPS.restore) {
      const restored = stack.pop();
      currentFont = restored?.font || null;
      currentTextColor = restored?.textColor || null;
      currentCtm = restored?.ctm || [1, 0, 0, 1, 0, 0];
      currentTextMatrix = restored?.textMatrix || [1, 0, 0, 1, 0, 0];
    }
    else if (op === OPS.transform) {
      const transform = asMatrix(args);
      if (transform) currentCtm = multiplyMatrices(currentCtm, transform);
    }
    else if (op === OPS.setTextMatrix) {
      const textMatrix = asMatrix(args[0]);
      if (textMatrix) currentTextMatrix = textMatrix;
    }
    else if (op === OPS.setFont) currentFont = args[0];
    // PDF.js passes RGB fill components as numbers for most PDF `rg`
    // operators, but passes a CSS string for a few synthesized cases.
    // Keep both forms so replacement text uses the original operator color
    // rather than an anti-aliased canvas pixel blended with the background.
    else if (op === OPS.setFillRGBColor) currentTextColor = toCssRgb(args) || currentTextColor;
    else if (op === OPS.setFillGray && Number.isFinite(Number(args[0]))) {
      const channel = Math.round(Math.max(0, Math.min(1, Number(args[0])) * 255));
      currentTextColor = `rgb(${channel}, ${channel}, ${channel})`;
    }
    else if (op === OPS.showText && currentFont) {
      if (!fonts.has(currentFont)) fonts.set(currentFont, new Map());
      if (!fontColors.has(currentFont)) fontColors.set(currentFont, new Set());
      if (currentTextColor) fontColors.get(currentFont).add(currentTextColor);
      const map = fonts.get(currentFont);
      for (const glyph of args[0]) {
        if (typeof glyph === 'number' || !glyph.unicode || !glyph.fontChar || glyph.accent) continue;
        if (map.has(glyph.unicode) && map.get(glyph.unicode) !== glyph.fontChar) map.set(glyph.unicode, null);
        else if (!map.has(glyph.unicode)) map.set(glyph.unicode, glyph.fontChar);
      }
      const unicodeText = args[0]
        .filter((glyph) => typeof glyph !== 'number' && glyph?.unicode && !glyph.accent)
        .map((glyph) => glyph.unicode)
        .join('');
      if (unicodeText) glyphRuns.push({
        fontName: currentFont,
        text: unicodeText,
        color: currentTextColor,
        transform: multiplyMatrices(currentCtm, currentTextMatrix)
      });
    }
  });
  const descriptors = new Map();
  for (const fontName of fonts.keys()) {
    const font = page.commonObjs.get(fontName);
    const style = textContent.styles[fontName] || {};
    const embedded = !!font.data?.length;
    const fontCandidates = [
      font.name,
      font.familyName,
      font.fallbackName,
      style.fontFamily,
      style.fontSubstitution,
      font.loadedName
    ].filter((value, index, values) => typeof value === 'string' && value.trim()
      && values.indexOf(value) === index);
    const sourceIsBold = Boolean(font.black || font.bold || fontCandidates.some(isBoldFontName));
    descriptors.set(fontName, {
      pdfFontName: fontName,
      fontFamily: embedded ? `"${font.loadedName}"` : (style.fontSubstitution || font.fallbackName || style.fontFamily),
      // Prefer the original PDF family name when available. PDF.js's loaded
      // name is often an internal identifier (for example g_d0_f1), which
      // cannot be matched against a Windows-installed font file.
      fontCandidates,
      textColor: fontColors.get(fontName)?.size === 1
        ? [...fontColors.get(fontName)][0]
        : null,
      // An embedded source font can still be a Bold face (for example
      // HCRDotum-Bold). Preserve that face metadata instead of treating every
      // embedded font as regular, so the matching installed Bold file can be
      // selected for a replacement.
      fontWeight: font.black ? '900' : sourceIsBold ? 'bold' : 'normal',
      preferBoldFont: sourceIsBold,
      fontStyle: embedded ? 'normal' : font.italic ? 'italic' : 'normal',
      embedded,
      ascent: Number.isFinite(style.ascent) ? style.ascent : 0.8,
      keys: [...fonts.get(fontName).keys()].sort((a, b) => b.length - a.length)
    });
  }
  // A font can legitimately be used with several colors on one page. Match
  // each PDF.js text item to its ordered showText runs, so a selected word
  // keeps its own fill color instead of losing it when the font has more than
  // one color elsewhere on the page.
  let glyphRunCursor = 0;
  const findItemTextColor = (item) => {
    const expected = String(item?.str || '');
    if (!expected) return null;
    const itemX = Number(item?.transform?.[4]);
    const itemY = Number(item?.transform?.[5]);
    if (Number.isFinite(itemX) && Number.isFinite(itemY)) {
      const nearest = glyphRuns
        .filter((run) => run.fontName === item.fontName && run.color && run.transform)
        .map((run) => ({
          run,
          distance: Math.hypot(run.transform[4] - itemX, run.transform[5] - itemY)
        }))
        .sort((first, second) => first.distance - second.distance)[0];
      // The first glyph's transformed coordinates are the same coordinates
      // exposed by PDF.js for the text item. This handles documents whose
      // text items merge several single-glyph showText operations.
      if (nearest?.distance <= 0.75) return nearest.run.color;
    }
    for (let start = glyphRunCursor; start < glyphRuns.length; start += 1) {
      if (glyphRuns[start].fontName !== item.fontName) continue;
      let joined = '';
      const colors = new Set();
      for (let end = start; end < glyphRuns.length; end += 1) {
        const run = glyphRuns[end];
        if (run.fontName !== item.fontName) break;
        joined += run.text;
        if (run.color) colors.add(run.color);
        if (joined === expected) {
          glyphRunCursor = end + 1;
          return colors.size === 1 ? [...colors][0] : null;
        }
        if (!expected.startsWith(joined)) break;
      }
    }
    return null;
  };

  return textContent.items.filter((item) => typeof item.str === 'string').map((item) => {
    const descriptor = descriptors.get(item.fontName);
    if (!descriptor || textContent.styles[item.fontName]?.vertical) return null;
    const itemTextColor = findItemTextColor(item);
    let offset = 0;
    let glyphText = '';
    while (offset < item.str.length) {
      const key = descriptor.keys.find((key) => item.str.startsWith(key, offset));
      const glyph = key && fonts.get(item.fontName).get(key);
      // Some embedded CID fonts expose Unicode text to PDF.js but do not
      // expose a reliable browser glyph character. The glyph replay feature
      // cannot use such a run, but its original PDF font name is still valid
      // and is required to resolve an installed Windows font for replacements.
      // Do not discard the entire descriptor merely because this optional
      // glyph mapping is unavailable.
      if (!glyph) {
        const { keys, ...sourceFont } = descriptor;
        return {
        ...sourceFont,
          textColor: itemTextColor || sourceFont.textColor,
          glyphText: null,
          fontSize: Math.hypot(item.transform[2], item.transform[3])
        };
      }
      glyphText += glyph;
      offset += key.length;
    }
    const { keys, ...sourceFont } = descriptor;
    return {
      ...sourceFont,
      textColor: itemTextColor || sourceFont.textColor,
      glyphText,
      fontSize: Math.hypot(item.transform[2], item.transform[3])
    };
  });
}
