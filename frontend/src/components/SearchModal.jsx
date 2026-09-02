import { useState } from 'react';
import { searchKeywordInDocument } from '../services/searchService';

function getPageNumber(result) {
  return result.pageNumber ?? result.page ?? null;
}

function getParagraphNumber(result) {
  return result.paragraphNumber ?? result.paragraphIndex ?? result.lineNumber ?? result.line ?? null;
}

function getResultText(result) {
  return result.text || result.previewText || result.fullText || result.matchedText || '-';
}

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
              <div className="search-result-table-wrap">
                <table className="search-result-table">
                  <thead>
                    <tr>
                      <th>페이지</th>
                      <th>문단</th>
                      <th>내용</th>
                      <th>검색어</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.length > 0 ? (
                      results.map((result, index) => {
                        const pageNumber = getPageNumber(result);
                        const paragraphNumber = getParagraphNumber(result);

                        return (
                          <tr
                            key={`${result.type || 'pdf'}-${pageNumber || result.blockIndex}-${paragraphNumber || result.index}-${result.keyword}-${index}`}
                            className="search-result-row"
                            onClick={() => handleResultClick(result)}
                          >
                            <td>{pageNumber ? `${pageNumber}페이지` : '-'}</td>
                            <td>{paragraphNumber ? `문단 ${paragraphNumber}` : '-'}</td>
                            <td>{getResultText(result)}</td>
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
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan="4" className="search-result-empty">
                          {emptyMessage}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SearchModal;
