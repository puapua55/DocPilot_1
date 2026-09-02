const PDF_FONT_DEFINITIONS = [
  {
    key: 'MalgunGothic',
    displayName: 'Malgun Gothic',
    fileName: 'MalgunGothic-Regular.ttf',
    url: '/fonts/MalgunGothic-Regular.ttf',
    optional: true,
    aliases: ['malgun', 'malgun gothic', 'malgungothic', '맑은 고딕', 'gothic']
  },
  {
    key: 'NotoSansKR',
    displayName: 'Noto Sans KR',
    fileName: 'NotoSansKR-Regular.ttf',
    url: '/fonts/NotoSansKR-Regular.ttf',
    base64Url: '/fonts/NotoSansKR-Regular.base64.txt',
    globalBase64Name: '__DOC_PILOT_KOREAN_FONT_BASE64__',
    optional: false,
    aliases: ['noto', 'noto sans kr', 'notosanskr']
  },
  {
    key: 'NanumGothic',
    displayName: 'Nanum Gothic',
    fileName: 'NanumGothic-Regular.ttf',
    url: '/fonts/NanumGothic-Regular.ttf',
    optional: true,
    aliases: ['nanum gothic', 'nanumgothic', '나눔고딕']
  },
  {
    key: 'NanumMyeongjo',
    displayName: 'Nanum Myeongjo',
    fileName: 'NanumMyeongjo-Regular.ttf',
    url: '/fonts/NanumMyeongjo-Regular.ttf',
    optional: true,
    aliases: ['nanum myeongjo', 'nanummyeongjo', '나눔명조']
  }
];

const registeredFonts = new Set();

export async function registerAvailablePdfFonts(pdf) {
  registeredFonts.clear();

  for (const fontDef of PDF_FONT_DEFINITIONS) {
    await tryRegisterFont(pdf, fontDef);
  }

  console.log('[PdfFont] final registered fonts:', Array.from(registeredFonts));
  console.log('[PdfFont] jsPDF fontList:', pdf.getFontList?.());

  return new Set(registeredFonts);
}

export function resolvePdfFontName(requestedFont, availableFonts) {
  const value = String(requestedFont || '').toLowerCase();
  const fonts = availableFonts || registeredFonts;

  if ((value.includes('malgun') || value.includes('맑은') || value.includes('gothic')) && fonts.has('MalgunGothic')) {
    return 'MalgunGothic';
  }

  if ((value.includes('noto') || value.includes('notosanskr')) && fonts.has('NotoSansKR')) {
    return 'NotoSansKR';
  }

  if ((value.includes('nanum gothic') || value.includes('nanumgothic') || value.includes('나눔고딕')) && fonts.has('NanumGothic')) {
    return 'NanumGothic';
  }

  if ((value.includes('nanum myeongjo') || value.includes('nanummyeongjo') || value.includes('나눔명조')) && fonts.has('NanumMyeongjo')) {
    return 'NanumMyeongjo';
  }

  if (fonts.has('MalgunGothic')) {
    return 'MalgunGothic';
  }

  if (fonts.has('NotoSansKR')) {
    return 'NotoSansKR';
  }

  if (fonts.has('NanumGothic')) {
    return 'NanumGothic';
  }

  if (fonts.has('NanumMyeongjo')) {
    return 'NanumMyeongjo';
  }

  return null;
}

export function setPdfFontSafe(pdf, fontName, availableFonts) {
  if (!fontName) {
    console.warn('[PdfFont] no fontName to set');
    return false;
  }

  const fonts = availableFonts || registeredFonts;

  if (!fonts.has(fontName)) {
    console.warn('[PdfFont] skip unregistered font:', fontName);
    return false;
  }

  try {
    pdf.setFont(fontName, 'normal');
    return true;
  } catch (error) {
    console.warn('[PdfFont] setFont failed:', { fontName, error });
    return false;
  }
}

export function getRegisteredPdfFonts() {
  return new Set(registeredFonts);
}

async function tryRegisterFont(pdf, fontDef) {
  try {
    const base64 = await loadFontDefinitionAsBase64(fontDef);

    if (!isLikelyBase64Font(base64)) {
      console.warn('[PdfFont] invalid font base64:', {
        key: fontDef.key,
        length: base64?.length,
        sample: String(base64 || '').slice(0, 100)
      });
      return false;
    }

    pdf.addFileToVFS(fontDef.fileName, base64);
    pdf.addFont(fontDef.fileName, fontDef.key, 'normal');

    const fontList = pdf.getFontList?.() || {};
    const registered = Object.prototype.hasOwnProperty.call(fontList, fontDef.key);

    if (!registered) {
      console.warn('[PdfFont] font not registered:', { key: fontDef.key, fontList });
      return false;
    }

    registeredFonts.add(fontDef.key);
    console.log('[PdfFont] registered:', {
      key: fontDef.key,
      fileName: fontDef.fileName,
      base64Length: base64.length
    });

    return true;
  } catch (error) {
    const level = fontDef?.optional ? 'warn' : 'error';

    console[level]('[PdfFont] register failed:', {
      key: fontDef?.key,
      url: fontDef?.url,
      error
    });
    return false;
  }
}

async function loadFontDefinitionAsBase64(fontDef) {
  if (
    fontDef?.globalBase64Name &&
    typeof window !== 'undefined' &&
    typeof window[fontDef.globalBase64Name] === 'string'
  ) {
    return window[fontDef.globalBase64Name];
  }

  if (fontDef?.url && await fontExists(fontDef.url)) {
    return loadFontUrlAsBase64(fontDef.url);
  }

  if (fontDef?.url) {
    const level = fontDef.optional ? 'warn' : 'error';

    console[level]('[PdfFont] font file not found:', {
      key: fontDef.key,
      url: fontDef.url,
      optional: fontDef.optional
    });
  }

  if (fontDef?.base64Url && await fontExists(fontDef.base64Url)) {
    return loadBase64Text(fontDef.base64Url);
  }

  return null;
}

async function fontExists(url) {
  if (typeof fetch !== 'function') {
    return false;
  }

  try {
    const headResponse = await fetch(url, { method: 'HEAD' });

    if (headResponse.ok) {
      return true;
    }
  } catch {
    // Some dev/static servers do not support HEAD. Try GET below.
  }

  try {
    const getResponse = await fetch(url, { method: 'GET' });
    return getResponse.ok;
  } catch {
    return false;
  }
}

async function loadFontUrlAsBase64(fontUrl) {
  const response = await fetch(fontUrl);

  if (!response.ok) {
    throw new Error(`Failed to load font: ${fontUrl}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }

  return btoa(binary);
}

async function loadBase64Text(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to load font base64: ${url}`);
  }

  return (await response.text()).trim();
}

function isLikelyBase64Font(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();

  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('http') ||
    trimmed.includes('.ttf') ||
    trimmed.includes('.otf')
  ) {
    return false;
  }

  return trimmed.length >= 10000;
}
