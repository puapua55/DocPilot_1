import { createPortal } from 'react-dom';

export default function PdfEncryptionChoice({ currentName, insertedName, onSelect, onCancel }) {
  return createPortal(
    <div className="pdf-download-preview-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="pdf-encryption-choice-dialog" role="dialog" aria-modal="true" aria-label="합본 암호화 설정 선택">
        <h2>합본 암호화 설정 선택</h2>
        <p>두 PDF가 모두 암호화되어 있습니다. 다운로드할 합본에 적용할 설정을 선택해주세요.</p>
        <button type="button" onClick={() => onSelect('current')}>
          <strong>현재 PDF 설정</strong><span>{currentName}</span>
        </button>
        <button type="button" onClick={() => onSelect('inserted')}>
          <strong>삽입할 PDF 설정</strong><span>{insertedName}</span>
        </button>
        <button type="button" className="pdf-encryption-choice-cancel" onClick={onCancel}>취소</button>
      </section>
    </div>,
    document.body
  );
}
