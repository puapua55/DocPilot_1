import { useEffect, useState } from 'react';
import { safeHyperlink } from '../services/hyperlinkService.js';

export default function PdfHyperlinkLayer({ pdf, pageNumber, viewport, editingEnabled }) {
  const [links, setLinks] = useState([]);
  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    pdf.getPage(pageNumber).then((page) => page.getAnnotations({ intent: 'display' })).then((annotations) => {
      if (!cancelled) setLinks(annotations.filter((entry) => entry.subtype === 'Link' && safeHyperlink(entry.url)));
    }).catch((error) => console.warn('[PdfHyperlinkLayer] 링크를 불러오지 못했습니다.', error));
    return () => { cancelled = true; };
  }, [pdf, pageNumber]);
  if (!viewport || editingEnabled) return null;
  return <div className="pdf-hyperlink-layer">{links.map((link) => {
    const rect = [
      ...viewport.convertToViewportPoint(link.rect[0], link.rect[1]),
      ...viewport.convertToViewportPoint(link.rect[2], link.rect[3])
    ];
    return <a key={link.id} href={safeHyperlink(link.url)} target="_blank" rel="noopener noreferrer"
      aria-label={link.url} title={link.url}
      onPointerDown={(event) => event.stopPropagation()}
      style={{ left: Math.min(rect[0], rect[2]), top: Math.min(rect[1], rect[3]), width: Math.abs(rect[2] - rect[0]), height: Math.abs(rect[3] - rect[1]) }} />;
  })}</div>;
}
