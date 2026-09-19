import { useEffect, useRef, useState } from 'react';
import './DraggableResizableModal.css';

const EDGE_MARGIN = 12;
const VISIBLE_MARGIN = 72;

function getInitialSize(initialWidth, initialHeight) {
  const viewportWidth = typeof window === 'undefined' ? initialWidth : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? initialHeight : window.innerHeight;

  return {
    width: Math.min(initialWidth, Math.max(320, viewportWidth - EDGE_MARGIN * 2)),
    height: Math.min(initialHeight, Math.max(260, viewportHeight - EDGE_MARGIN * 2))
  };
}

function clampPosition(left, top, element, width = window.innerWidth, height = window.innerHeight) {
  const elementWidth = element?.offsetWidth || 0;
  const elementHeight = element?.offsetHeight || 0;
  const minLeft = EDGE_MARGIN - Math.max(0, elementWidth - VISIBLE_MARGIN);
  const maxLeft = Math.max(EDGE_MARGIN, width - VISIBLE_MARGIN);
  const minTop = EDGE_MARGIN;
  const maxTop = Math.max(EDGE_MARGIN, height - VISIBLE_MARGIN);

  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop)
  };
}

function DraggableResizableModal({
  title,
  titleId,
  onClose,
  children,
  className = '',
  initialWidth = 920,
  initialHeight = 700,
  minWidth = 520,
  minHeight = 360
}) {
  const modalRef = useRef(null);
  const dragRef = useRef(null);
  const [{ width, height }, setSize] = useState(() => getInitialSize(initialWidth, initialHeight));
  const [position, setPosition] = useState(() => {
    const size = getInitialSize(initialWidth, initialHeight);
    return {
      left: Math.max(EDGE_MARGIN, (window.innerWidth - size.width) / 2),
      top: Math.max(EDGE_MARGIN, (window.innerHeight - size.height) / 2)
    };
  });

  useEffect(() => {
    const handleViewportResize = () => {
      const next = clampPosition(position.left, position.top, modalRef.current);
      setPosition(next);
      setSize((current) => ({
        width: Math.min(current.width, Math.max(minWidth, window.innerWidth - EDGE_MARGIN * 2)),
        height: Math.min(current.height, Math.max(minHeight, window.innerHeight - EDGE_MARGIN * 2))
      }));
    };

    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, [minHeight, minWidth, position.left, position.top]);

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (!dragRef.current) return;
      const { startX, startY, startLeft, startTop } = dragRef.current;
      setPosition(clampPosition(
        startLeft + event.clientX - startX,
        startTop + event.clientY - startY,
        modalRef.current
      ));
    };

    const handlePointerUp = () => {
      dragRef.current = null;
      document.body.classList.remove('is-modal-dragging');
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.classList.remove('is-modal-dragging');
    };
  }, []);

  const handleHeaderPointerDown = (event) => {
    if (event.button !== 0 || event.target.closest('button, input, textarea, select, a')) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: position.left,
      startTop: position.top
    };
    document.body.classList.add('is-modal-dragging');
    event.preventDefault();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={modalRef}
        className={`draggable-modal search-modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          width,
          height,
          minWidth: `min(${minWidth}px, calc(100vw - ${EDGE_MARGIN * 2}px))`,
          minHeight: `min(${minHeight}px, calc(100vh - ${EDGE_MARGIN * 2}px))`,
          left: position.left,
          top: position.top
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="draggable-modal-header" onPointerDown={handleHeaderPointerDown}>
          <h2 id={titleId} className="search-modal-title">{title}</h2>
          <button type="button" className="search-modal-close" onClick={onClose} aria-label={`${title} 모달 닫기`}>x</button>
        </div>
        <div className="draggable-modal-body search-modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

export default DraggableResizableModal;
