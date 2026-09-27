let fontReady;
const previewFontPromises = new Map();
let nextLocalPreviewFontId = 0;

function decodeBase64Font(base64) {
  return Uint8Array.from(atob(String(base64 || '').replace(/\s/g, '')), (char) => char.charCodeAt(0));
}

function getFontCandidates(fontCandidates) {
  return [...new Set((Array.isArray(fontCandidates) ? fontCandidates : [fontCandidates])
    .filter((candidate) => typeof candidate === 'string' && candidate.trim())
    .map((candidate) => candidate.trim()))];
}
export function ensureReplacementFont() {
  if (!fontReady) {
    // `import.meta.env.BASE_URL` is `./` in the packaged Electron build.
    // Resolving from the document URL keeps this working for both Vite HTTP
    // development and the packaged `file://.../dist/index.html` URL.
    const fontUrl = new URL(
      `${import.meta.env.BASE_URL}fonts/NotoSansKR-Regular.base64.txt`,
      window.location.href
    );
    fontReady = fetch(fontUrl).then(async (response) => {
      if (!response.ok) throw new Error('교체 글꼴을 불러오지 못했습니다.');
      const bytes = decodeBase64Font(await response.text());
      const face = await new FontFace('DocPilotReplacement', bytes).load();
      document.fonts.add(face);
    }).catch((error) => { fontReady = null; throw error; });
  }
  return fontReady;
}

// Registers a local Windows font in the renderer when Electron located the
// same font used by the source PDF. The private CSS family prevents a browser
// fallback with the same public family name from silently taking precedence.
export function resolveReplacementPreviewFont(fontCandidates = [], options = {}) {
  const candidates = getFontCandidates(fontCandidates);
  const preferBold = options.preferBold === true;
  if (!candidates.length || !window.docPilotFonts?.resolve) {
    return ensureReplacementFont().then(() => ({
      fontFamily: 'DocPilotReplacement',
      source: 'bundled',
        originalFamily: '',
        selectionValue: ''
    }));
  }

  const cacheKey = `${preferBold ? 'bold' : 'normal'}\u0000${candidates.join('\u0000')}`;
  if (!previewFontPromises.has(cacheKey)) {
    const loading = window.docPilotFonts.resolve({ candidates, preferBold })
      .then(async (localFont) => {
        if (!localFont?.found || !localFont.base64) {
          await ensureReplacementFont();
          return { fontFamily: 'DocPilotReplacement', source: 'bundled', originalFamily: '', selectionValue: '' };
        }
        const fontFamily = `DocPilotLocalPreview${nextLocalPreviewFontId++}`;
        const face = await new FontFace(fontFamily, decodeBase64Font(localFont.base64)).load();
        document.fonts.add(face);
        return {
          fontFamily,
          source: 'local',
          originalFamily: localFont.fullName || localFont.family || candidates[0],
          selectionValue: localFont.fullName || localFont.family || candidates[0]
        };
      })
      .catch((error) => {
        previewFontPromises.delete(cacheKey);
        throw error;
      });
    previewFontPromises.set(cacheKey, loading);
  }
  return previewFontPromises.get(cacheKey);
}
