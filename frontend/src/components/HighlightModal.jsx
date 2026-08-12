import { useEffect, useState } from 'react';

function HighlightModal({ isOpen, onClose, onSearch }) {
  const [keyword, setKeyword] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setKeyword('');
      setMessage('');
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleSearch = () => {
    const normalizedKeyword = keyword.trim();

    console.log('[HighlightModal] keyword:', normalizedKeyword);

    if (!normalizedKeyword) {
      setMessage('검색어를 입력해주세요.');
      return;
    }

    const result = onSearch?.(normalizedKeyword);

    if (result?.ok === false) {
      setMessage(result.message);
      return;
    }

    if (result?.closeModal) {
      onClose?.();
      return;
    }

    setMessage(result?.message || '');
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="search-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="highlight-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-modal-header">
          <button
            type="button"
            className="search-modal-close"
            onClick={onClose}
            aria-label="하이라이트 모달 닫기"
          >
            x
          </button>
        </div>

        <div className="search-modal-body">
          <h2 id="highlight-modal-title" className="search-modal-title">
            하이라이트 표시할 단어를 입력하세요.
          </h2>
          {message ? <p className="search-modal-error">{message}</p> : null}
          <div className="search-modal-input-row">
            <input
              className="search-modal-input"
              type="text"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="검색어를 입력하세요"
            />
            <button type="button" className="search-modal-button" onClick={handleSearch}>
              검색
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default HighlightModal;
