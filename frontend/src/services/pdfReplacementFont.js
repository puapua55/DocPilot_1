let fontReady;
export function ensureReplacementFont() {
  if (!fontReady) {
    fontReady = fetch('/fonts/NotoSansKR-Regular.base64.txt').then(async (response) => {
      if (!response.ok) throw new Error('교체 글꼴을 불러오지 못했습니다.');
      const bytes = Uint8Array.from(atob((await response.text()).replace(/\s/g, '')), (c) => c.charCodeAt(0));
      const face = await new FontFace('DocPilotReplacement', bytes).load();
      document.fonts.add(face);
    }).catch((error) => { fontReady = null; throw error; });
  }
  return fontReady;
}
