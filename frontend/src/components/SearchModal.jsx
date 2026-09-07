import { useMemo, useState } from 'react';

function normalizeSearchResult(rawResult, index, keyword) {
  const raw = rawResult || {};
  const pageNumber = Number(raw.pageNumber ?? raw.page ?? 1) || 1;
  const paragraphNumber = raw.paragraphNumber ?? raw.paragraphIndex;
  const lineNumber = raw.lineNumber ?? raw.line;
  const text = String(raw.text ?? raw.fullText ?? raw.content ?? raw.matchedText ?? '').trim();

  return {
    id: raw.id || `search-result-${pageNumber}-${index}`,
    pageNumber,
    paragraphNumber: paragraphNumber == null ? undefined : Number(paragraphNumber),
    lineNumber: lineNumber == null ? undefined : Number(lineNumber),
    text,
    keyword: String(raw.keyword || keyword),
    matchIndex: raw.matchIndex,
    raw
  };
}

function normalizeSearchResponse(rawResponse, keyword) {
  const rawResults = Array.isArray(rawResponse)
    ? rawResponse
    : Array.isArray(rawResponse?.results)
      ? rawResponse.results
      : [];

  return rawResults.map((result, index) => normalizeSearchResult(result, index, keyword));
}

function formatResultLocation(result, index) {
  const locations = [];

  if (Number.isFinite(result.paragraphNumber)) {
    locations.push(`문단 ${result.paragraphNumber}`);
  }

  if (Number.isFinite(result.lineNumber)) {
    locations.push(`줄 ${result.lineNumber}`);
  }

  return locations.length > 0 ? locations.join(' / ') : `결과 ${index + 1}`;
}

function SearchModal({
  selectedDocument,
  previewModel,
  onSearch,
  onReset,
  onClose,
  onResultClick
}) {
  const [keyword, setKeyword] = useState('');
  const [matchMode, setMatchMode] = useState('contains');
  const [results, setResults] = useState([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [activeResultId, setActiveResultId] = useState(null);

  const documentName = selectedDocument?.file?.name ?? selectedDocument?.name ?? '';
  const documentType = previewModel?.type === 'pdf'
    ? 'PDF'
    : previewModel?.type === 'word'
      ? 'DOCX'
      : '-';

  const initialDocumentMessage = useMemo(
    () => selectedDocument
      ? ''
      : '현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.',
    [selectedDocument]
  );

  const handleSearch = async () => {
    const normalizedKeyword = keyword.trim();

    if (!selectedDocument) {
      setStatusType('error');
      setStatusMessage('현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.');
      setResults([]);
      setActiveResultId(null);
      return;
    }

    if (!normalizedKeyword) {
      setStatusType('error');
      setStatusMessage('검색어를 입력해주세요.');
      setResults([]);
      setActiveResultId(null);
      return;
    }

    setIsSearching(true);
    setStatusType('progress');
    setStatusMessage('문서를 검색하는 중입니다.');
    setActiveResultId(null);

    try {
      const rawResponse = await onSearch?.(normalizedKeyword, { matchMode });
      const normalizedResults = normalizeSearchResponse(rawResponse, normalizedKeyword);

      setResults(normalizedResults);
      if (normalizedResults.length > 0) {
        setStatusType('success');
        setStatusMessage(`총 ${normalizedResults.length}건을 찾았습니다.`);
      } else {
        setStatusType('empty');
        setStatusMessage('검색 결과가 없습니다.');
      }
    } catch (error) {
      console.error('[SearchModal] search failed:', error);
      setResults([]);
      setStatusType('error');
      setStatusMessage('검색 중 오류가 발생했습니다. 다시 시도해주세요.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleReset = () => {
    setKeyword('');
    setMatchMode('contains');
    setResults([]);
    setStatusMessage('');
    setStatusType('');
    setActiveResultId(null);
    onReset?.();
  };

  const handleClose = () => {
    onReset?.();
    onClose?.();
  };

  const handleResultClick = (result) => {
    setActiveResultId(result.id);
    try {
      onResultClick?.(result);
    } catch (error) {
      console.warn('[SearchModal] result navigation failed:', error);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={handleClose}>
      <div
        className="search-modal search-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-modal-header">
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
          <h2 id="search-modal-title" className="search-modal-title">
            정확한 문서 검색
          </h2>

          <div className="search-meta">
            <div><span>현재 문서</span><strong>{documentName || '-'}</strong></div>
            <div><span>파일 형식</span><strong>{documentType}</strong></div>
          </div>

          <div className="search-form">
            <label className="search-field" htmlFor="document-search-input">
              <span>검색어</span>
              <input
                id="document-search-input"
                className="search-input search-modal-input"
                type="text"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleSearch();
                  }
                }}
                placeholder="검색어를 입력하세요"
                disabled={isSearching}
              />
            </label>

            <div className="search-options" role="radiogroup" aria-label="검색 방식">
              <span>검색 방식</span>
              <label>
                <input
                  type="radio"
                  name="search-match-mode"
                  value="contains"
                  checked={matchMode === 'contains'}
                  onChange={() => setMatchMode('contains')}
                  disabled={isSearching}
                />
                포함 검색
              </label>
              <label>
                <input
                  type="radio"
                  name="search-match-mode"
                  value="exact"
                  checked={matchMode === 'exact'}
                  onChange={() => setMatchMode('exact')}
                  disabled={isSearching}
                />
                정확히 일치
              </label>
            </div>

            <div className="search-form-actions">
              <button
                type="button"
                className="search-button search-modal-button"
                onClick={handleSearch}
                disabled={isSearching}
              >
                {isSearching ? '검색 중...' : '검색'}
              </button>
              <button
                type="button"
                className="search-reset-button"
                onClick={handleReset}
                disabled={isSearching}
              >
                초기화
              </button>
            </div>
          </div>

          {(statusMessage || initialDocumentMessage) ? (
            <div
              className={`search-status ${statusType ? `search-status-${statusType}` : ''}`}
              role="status"
              aria-live="polite"
            >
              {statusMessage || initialDocumentMessage}
            </div>
          ) : null}

          <div className="search-result-summary">
            검색 결과: 총 <strong>{results.length}</strong>건
          </div>

          {results.length > 0 ? (
            <div className="search-result-table-wrap">
              <table className="search-result-table">
                <thead>
                  <tr>
                    <th>페이지</th>
                    <th>위치</th>
                    <th>내용</th>
                    <th>검색어</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result, index) => (
                    <tr
                      key={result.id}
                      className={`search-result-row ${activeResultId === result.id ? 'active' : ''}`}
                      onClick={() => handleResultClick(result)}
                      aria-current={activeResultId === result.id ? 'true' : undefined}
                    >
                      <td>{result.pageNumber ? `${result.pageNumber}페이지` : '-'}</td>
                      <td>{formatResultLocation(result, index)}</td>
                      <td className="search-result-text" title={result.text}>{result.text || '-'}</td>
                      <td>{result.keyword}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : statusType === 'empty' ? (
            <div className="search-result-empty">검색 결과가 없습니다.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default SearchModal;
