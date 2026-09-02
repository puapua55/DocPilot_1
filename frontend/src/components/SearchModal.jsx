import { useState } from 'react';
import { searchKeywordInDocument } from '../services/searchService';

function SearchModal({ documentText, selectedDocument, onClose, onResultClick, onSearchDocument }) {
  const [mode, setMode] = useState('input');
  const [keyword, setKeyword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [results, setResults] = useState([]);
  const [emptyMessage, setEmptyMessage] = useState('');

  const handleSearch = async () => {
    const normalizedKeyword = keyword.trim();

    if (!normalizedKeyword) {
      setErrorMessage('검색어를 입력해주세요.');
      setEmptyMessage('');
      return;
    }

    if (!selectedDocument) {
      setErrorMessage('먼저 문서를 선택해주세요.');
      setEmptyMessage('');
      return;
    }

    const viewerResults = onSearchDocument?.(normalizedKeyword);

    if (Array.isArray(viewerResults)) {
      setErrorMessage('');
      setResults(viewerResults);
      setEmptyMessage(viewerResults.length === 0 ? '검색 결과가 없습니다.' : '');
      setMode('result');
      return;
    }

    if (!Array.isArray(documentText) || documentText.length === 0) {
      setErrorMessage('문서 텍스트를 아직 읽지 못했습니다.');
      setEmptyMessage('');
      return;
    }

    setErrorMessage('');
    const searchResults = await searchKeywordInDocument(documentText, normalizedKeyword);
    setResults(searchResults);
    setEmptyMessage(searchResults.length === 0 ? '검색 결과가 없습니다.' : '');
    setMode('result');
  };

  const handleBack = () => {
    setMode('input');
    setErrorMessage('');
    setEmptyMessage('');
  };

  const handleClose = () => {
    setMode('input');
    setKeyword('');
    setErrorMessage('');
    setResults([]);
    setEmptyMessage('');
    onClose();
  };

  const handleResultClick = (result) => {
    if (onResultClick) {
      onResultClick(result);
    }

    handleClose();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={handleClose}>
      <div
        className="search-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-modal-header">
          {mode === 'result' ? (
            <button type="button" className="search-modal-back" onClick={handleBack}>
              뒤로가기
            </button>
          ) : null}
          <button
            type="button"
            className="search-modal-close"
            onClick={handleClose}
            aria-label="검색 모달 닫기"
          >
            x
          </button>
        </div>

        <div className="search-modal-body">
          {mode === 'input' ? (
            <>
              <h2 id="search-modal-title" className="search-modal-title">
                찾을 단어 검색
              </h2>
              {errorMessage ? <p className="search-modal-error">{errorMessage}</p> : null}
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
            </>
          ) : (
            <>
              <h2 id="search-modal-title" className="search-modal-title">
                검색 결과
              </h2>
              <table className="search-result-table">
                <thead>
                  <tr>
                    <th>{results[0]?.type === 'docx' ? '문단' : '페이지'}</th>
                    <th>{results[0]?.type === 'docx' ? '내용' : '줄'}</th>
                    <th>검색어</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length > 0 ? (
                    results.map((result, index) => (
                      <tr
                        key={`${result.type || 'pdf'}-${result.page || result.blockIndex}-${result.line || result.index}-${result.keyword}-${index}`}
                        className="search-result-row"
                        onClick={() => handleResultClick(result)}
                      >
                        <td>{result.type === 'docx' ? `문단 ${result.paragraphIndex}` : result.page}</td>
                        <td>{result.type === 'docx' ? result.previewText : result.line}</td>
                        <td>
                          <button
                            type="button"
                            className="search-result-keyword"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleResultClick(result);
                            }}
                          >
                            {result.keyword}
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="3" className="search-result-empty">
                        {emptyMessage}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SearchModal;
