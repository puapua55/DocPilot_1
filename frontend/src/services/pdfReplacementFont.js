let fontReady;
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
      const bytes = Uint8Array.from(atob((await response.text()).replace(/\s/g, '')), (c) => c.charCodeAt(0));
      const face = await new FontFace('DocPilotReplacement', bytes).load();
      document.fonts.add(face);
    }).catch((error) => { fontReady = null; throw error; });
  }
  return fontReady;
}
