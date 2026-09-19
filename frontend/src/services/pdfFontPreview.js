import { OPS } from 'pdfjs-dist';

// PDF.js may remap embedded glyphs to private Unicode slots. The invisible
// selection layer uses ordinary text, so its CSS font family is not enough
// to reproduce the canvas font. Use PDF.js's rendered glyph mapping instead.
export async function describePdfTextFonts(page, textContent) {
  const operators = await page.getOperatorList();
  const fonts = new Map();
  let currentFont = null;
  const stack = [];
  operators.fnArray.forEach((op, index) => {
    const args = operators.argsArray[index];
    if (op === OPS.save) stack.push(currentFont);
    else if (op === OPS.restore) currentFont = stack.pop() || null;
    else if (op === OPS.setFont) currentFont = args[0];
    else if (op === OPS.showText && currentFont) {
      if (!fonts.has(currentFont)) fonts.set(currentFont, new Map());
      const map = fonts.get(currentFont);
      for (const glyph of args[0]) {
        if (typeof glyph === 'number' || !glyph.unicode || !glyph.fontChar || glyph.accent) continue;
        if (map.has(glyph.unicode) && map.get(glyph.unicode) !== glyph.fontChar) map.set(glyph.unicode, null);
        else if (!map.has(glyph.unicode)) map.set(glyph.unicode, glyph.fontChar);
      }
    }
  });
  const descriptors = new Map();
  for (const fontName of fonts.keys()) {
    const font = page.commonObjs.get(fontName);
    const style = textContent.styles[fontName] || {};
    const embedded = !!font.data?.length;
    descriptors.set(fontName, {
      pdfFontName: fontName,
      fontFamily: embedded ? `"${font.loadedName}"` : (style.fontSubstitution || font.fallbackName || style.fontFamily),
      fontWeight: embedded ? 'normal' : font.black ? '900' : font.bold ? 'bold' : 'normal',
      fontStyle: embedded ? 'normal' : font.italic ? 'italic' : 'normal',
      embedded,
      ascent: Number.isFinite(style.ascent) ? style.ascent : 0.8,
      keys: [...fonts.get(fontName).keys()].sort((a, b) => b.length - a.length)
    });
  }
  return textContent.items.filter((item) => typeof item.str === 'string').map((item) => {
    const descriptor = descriptors.get(item.fontName);
    if (!descriptor || textContent.styles[item.fontName]?.vertical) return null;
    let offset = 0;
    let glyphText = '';
    while (offset < item.str.length) {
      const key = descriptor.keys.find((key) => item.str.startsWith(key, offset));
      const glyph = key && fonts.get(item.fontName).get(key);
      if (!glyph) return null;
      glyphText += glyph;
      offset += key.length;
    }
    const { keys, ...sourceFont } = descriptor;
    return { ...sourceFont, glyphText, fontSize: Math.hypot(item.transform[2], item.transform[3]) };
  });
}
