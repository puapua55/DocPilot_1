import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function PdfPasswordDialog({ fileName, onConfirm, onCancel }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (opening) return;
    if (!password) {
      setError('비밀번호를 입력해주세요.');
      return;
    }
    setOpening(true);
    setError('');
    try {
      await onConfirm(password);
    } catch (openError) {
      setError(openError?.message || 'PDF를 열지 못했습니다. 비밀번호를 확인해주세요.');
      setOpening(false);
    }
  };

  return createPortal(
    <div className="pdf-download-preview-backdrop">
      <form className="pdf-password-dialog" role="dialog" aria-modal="true" aria-label="PDF 비밀번호 입력" onSubmit={submit}>
        <h2>PDF 비밀번호 입력</h2>
        <p><strong>{fileName}</strong> 파일을 열려면 비밀번호가 필요합니다.</p>
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(event) => { setPassword(event.target.value); setError(''); }}
          aria-label="PDF 열기 비밀번호"
          autoComplete="off"
          disabled={opening}
        />
        {error ? <span role="alert" className="pdf-password-error">{error}</span> : null}
        <div className="pdf-password-actions">
          <button type="button" onClick={onCancel} disabled={opening}>취소</button>
          <button type="submit" disabled={opening}>{opening ? '여는 중...' : '확인'}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}
