import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { safeHyperlink } from '../services/hyperlinkService.js';
import { resolvePdfJsDestination } from '../services/pdfInternalLinks.js';

export default function PdfHyperlinkLayer({ pdf, pageNumber, viewport, editingEnabled, edits = [], onChange, onNavigate, getTextBoxAtTarget }) {
  const [links, setLinks] = useState([]);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [targetPage, setTargetPage] = useState('1');
  const [error, setError] = useState('');
  const layerRef = useRef(null);
  const menuRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    (async () => {
      const page = await pdf.getPage(pageNumber);
      const annotations = await page.getAnnotations({ intent: 'display' });
      const resolved = await Promise.all(annotations.filter((entry) => entry.subtype === 'Link').map(async (entry) => {
        const destination = entry.dest ? await resolvePdfJsDestination(pdf, entry.dest).catch(() => null) : null;
        return { ...entry, destination };
      }));
      if (!cancelled) setLinks(resolved.filter((entry) => entry.destination || safeHyperlink(entry.url)));
    })().catch((reason) => console.warn('[PdfHyperlinkLayer] 링크를 불러오지 못했습니다.', reason));
    return () => { cancelled = true; };
  }, [pdf, pageNumber]);
  useEffect(() => {
    const change = (event) => setCtrlHeld(event.ctrlKey || event.metaKey);
    const clear = () => setCtrlHeld(false);
    document.addEventListener('keydown', change);
    document.addEventListener('keyup', change);
    window.addEventListener('blur', clear);
    return () => { document.removeEventListener('keydown', change); document.removeEventListener('keyup', change); window.removeEventListener('blur', clear); };
  }, []);
  useEffect(() => {
    if (!menu) return undefined;
    const dismiss = (event) => { if (!menuRef.current?.contains(event.target)) setMenu(null); };
    const escape = (event) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [menu]);
  useEffect(() => { if (dialog) inputRef.current?.focus(); }, [dialog]);
  useEffect(() => { setMenu(null); }, [viewport]);
  useEffect(() => {
    const page = layerRef.current?.parentElement;
    const change = (event) => setCtrlHeld(event.ctrlKey || event.metaKey);
    page?.addEventListener('pointermove', change, { passive: true });
    return () => page?.removeEventListener('pointermove', change);
  }, [viewport]);

  const pageEdits = edits.filter((edit) => edit.pageNumber === pageNumber);
  const visible = [
    ...links.filter((link) => !pageEdits.some((edit) => edit.sourceId === link.id || edit.id === link.annotationName)),
    ...pageEdits.filter((edit) => !edit.deleted)
  ];
  const screenRect = (rect) => {
    const points = [...viewport.convertToViewportPoint(rect[0], rect[1]), ...viewport.convertToViewportPoint(rect[2], rect[3])];
    return { left: Math.min(points[0], points[2]), top: Math.min(points[1], points[3]), width: Math.abs(points[2] - points[0]), height: Math.abs(points[3] - points[1]) };
  };
  const pdfRect = (rect) => {
    const a = viewport.convertToPdfPoint(rect.left, rect.top);
    const b = viewport.convertToPdfPoint(rect.left + rect.width, rect.top + rect.height);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  };
  useEffect(() => {
    const page = layerRef.current?.parentElement;
    if (!page || !viewport || !editingEnabled) return undefined;
    const context = (event) => {
      if (event.target.closest?.('a[data-hyperlink-id]')) return;
      const bounds = page.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const hit = visible.find((link) => {
        if (!link.destination) return false;
        const r = screenRect(link.rect);
        return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
      });
      const textBox = getTextBoxAtTarget?.(event.target);
      let rect = hit?.rect || (textBox ? pdfRect(textBox) : null);
      if (!rect) {
        const selection = window.getSelection();
        if (selection?.rangeCount && !selection.isCollapsed && page.contains(selection.anchorNode) && page.contains(selection.focusNode)) {
          const r = selection.getRangeAt(0).getBoundingClientRect();
          rect = pdfRect({ left: r.left - bounds.left, top: r.top - bounds.top, width: r.width, height: r.height });
        } else {
          const box = event.target.closest?.('.movable-text-object');
          if (box) {
            const r = box.getBoundingClientRect();
            rect = pdfRect({ left: r.left - bounds.left, top: r.top - bounds.top, width: r.width, height: r.height });
          }
        }
      }
      if (!rect) return;
      event.preventDefault(); event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, link: hit, rect });
    };
    page.addEventListener('contextmenu', context, true);
    return () => page.removeEventListener('contextmenu', context, true);
  });
  const update = (deleted = false) => {
    const source = dialog || menu;
    const previous = source.link;
    const number = Number(targetPage);
    if (!deleted && (!Number.isInteger(number) || number < 1 || number > pdf.numPages)) { setError(`1부터 ${pdf.numPages}까지 입력해주세요.`); return; }
    const originalDestination = previous?.destination || {};
    const samePage = number === originalDestination.pageNumber;
    const destination = deleted ? null : samePage
      ? originalDestination
      : { pageNumber: number };
    onChange?.({ id: previous?.id?.startsWith('DocPilotInternal:') ? previous.id : `DocPilotInternal:${previous?.id || Date.now()}`,
      sourceId: previous?.sourceId || (previous && !previous.id?.startsWith('DocPilotInternal:') ? previous.id : undefined),
      pageNumber, rect: source.rect, destination, deleted });
    setMenu(null); setDialog(null); setError('');
  };
  const openDialog = () => { setTargetPage(String(menu.link?.destination?.pageNumber || pageNumber)); setDialog(menu); setMenu(null); setError(''); };
  if (!viewport) return null;
  return <>
    <div ref={layerRef} className="pdf-hyperlink-layer">
      {visible.map((link) => {
        const internal = Boolean(link.destination);
        if (!internal && editingEnabled) return null;
        const label = internal ? `${link.destination.pageNumber}페이지로 이동 (Ctrl+클릭)` : link.url;
        return <a key={link.id} className={internal ? 'pdf-internal-link' : undefined}
          href={internal ? `#pdf-page-${link.destination.pageNumber}` : safeHyperlink(link.url)}
          target={internal ? undefined : '_blank'} rel="noopener noreferrer" aria-label={label} title={label}
          style={{ ...screenRect(link.rect), pointerEvents: internal && !ctrlHeld ? 'none' : 'auto' }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { if (!internal) return; event.preventDefault(); event.stopPropagation(); if (event.ctrlKey || event.metaKey) onNavigate?.(link.destination); }} />;
      })}
    </div>
    {menu ? createPortal(<div ref={menuRef} className="docpilot-hyperlink-menu" role="menu" aria-label="내부 링크 메뉴"
      style={{ left: Math.max(0, Math.min(menu.x, window.innerWidth - 190)), top: Math.max(0, Math.min(menu.y, window.innerHeight - 100)) }}
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <button type="button" role="menuitem" onClick={openDialog}>{menu.link ? '이동 대상 변경' : '내부 링크 설정'}</button>
      {menu.link ? <button type="button" role="menuitem" onClick={() => update(true)}>내부 링크 제거</button> : null}
    </div>, document.body) : null}
    {dialog ? createPortal(<div className="pdf-internal-link-backdrop" onPointerDown={(event) => event.stopPropagation()}>
      <form className="pdf-internal-link-dialog" role="dialog" aria-modal="true" aria-label="내부 링크 설정" onSubmit={(event) => { event.preventDefault(); update(); }} onKeyDown={(event) => { if (event.key === 'Escape') setDialog(null); }}>
        <strong>내부 링크 설정</strong>
        <label>이동할 페이지 <input ref={inputRef} type="number" min="1" max={pdf.numPages} value={targetPage} onChange={(event) => setTargetPage(event.target.value)} /></label>
        <span>전체 {pdf.numPages}페이지 · Ctrl+클릭으로 이동합니다.</span>
        {error ? <p role="alert">{error}</p> : null}
        <div><button type="button" onClick={() => setDialog(null)}>취소</button><button type="submit">확인</button></div>
      </form>
    </div>, document.body) : null}
  </>;
}
