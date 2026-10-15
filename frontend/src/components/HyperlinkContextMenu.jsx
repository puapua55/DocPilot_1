import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function HyperlinkContextMenu({ position, onRemove, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!position) return undefined;
    const dismiss = (event) => { if (!ref.current?.contains(event.target)) onClose(); };
    const key = (event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [position, onClose]);
  if (!position) return null;
  return createPortal(
    <div ref={ref} className="docpilot-hyperlink-menu" role="menu" aria-label="하이퍼링크 메뉴"
      style={{ left: Math.max(0, Math.min(position.x, window.innerWidth - 180)), top: Math.max(0, Math.min(position.y, window.innerHeight - 48)) }}
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onContextMenu={(event) => event.preventDefault()}>
      <button type="button" role="menuitem" onClick={onRemove}>하이퍼링크 제거</button>
    </div>, document.body
  );
}
