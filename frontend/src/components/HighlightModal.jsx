import { useEffect, useMemo, useState } from 'react';

const COLOR_OPTIONS = [
  { value: 'yellow', label: '노랑' },
  { value: 'green', label: '초록' },
  { value: 'blue', label: '파랑' },
  { value: 'pink', label: '분홍' }
];

const COLOR_LABELS = Object.fromEntries(COLOR_OPTIONS.map((item) => [item.value, item.label]));

function normalizeHighlightResult(rawResult, index, keyword, color) {
  const raw = rawResult || {};
  return {
    id: raw.id || `highlight-result-${index}`,
    pageNumber: Number(raw.pageNumber ?? raw.page ?? 1) || 1,
    paragraphNumber: raw.paragraphNumber == null ? undefined : Number(raw.paragraphNumber),
    lineNumber: raw.lineNumber == null ? undefined : Number(raw.lineNumber),
    text: String(raw.text ?? raw.content ?? raw.fullText ?? raw.matchedText ?? '').trim(),
    keyword: String(raw.keyword || keyword),
    color: raw.color || color,
    raw
  };
}

function normalizeHighlightResponse(rawResponse, keyword, color) {
  const rawResults = Array.isArray(rawResponse)
    ? rawResponse
    : Array.isArray(rawResponse?.results)
      ? rawResponse.results
      : [];

  const results = rawResults.map((result, index) =>
    normalizeHighlightResult(result, index, keyword, color)
  );

  const count = typeof rawResponse === 'number'
    ? rawResponse
    : typeof rawResponse?.count === 'number'
      ? rawResponse.count
      : typeof rawResponse?.matchCount === 'number'
        ? rawResponse.matchCount
        : results.length;

  return { count, results };
}

function formatHighlightLocation(result, index) {
  const values = [];
  if (Number.isFinite(result.paragraphNumber)) values.push(`문단 ${result.paragraphNumber}`);
  if (Number.isFinite(result.lineNumber)) values.push(`줄 ${result.lineNumber}`);
  return values.length > 0 ? values.join(' / ') : `결과 ${index + 1}`;
}

function HighlightModal({
  isOpen,
  selectedDocument,
  previewModel,
  onApply,
  onClearAll,
  onReset,
  onResultClick,
  onClose
}) {
  const [keyword, setKeyword] = useState('');
  const [color, setColor] = useState('yellow');
  const [matchMode, setMatchMode] = useState('contains');
  const [results, setResults] = useState([]);
  const [resultCount, setResultCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [activeHighlightId, setActiveHighlightId] = useState(null);

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

  useEffect(() => {
    if (!isOpen) {
      setKeyword('');
      setColor('yellow');
      setMatchMode('contains');
      setResults([]);
      setResultCount(0);
      setStatusMessage('');
      setStatusType('');
      setActiveHighlightId(null);
      setIsApplying(false);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleApply = async () => {
    const normalizedKeyword = keyword.trim();

    if (!selectedDocument) {
      setStatusType('error');
      setStatusMessage('현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.');
      return;
    }

    if (!normalizedKeyword) {
      setStatusType('error');
      setStatusMessage('하이라이트할 단어를 입력해주세요.');
      return;
    }

    setIsApplying(true);
    setStatusType('progress');
    setStatusMessage('하이라이트를 적용하는 중입니다.');
    setActiveHighlightId(null);

    try {
      const rawResponse = await onApply?.(normalizedKeyword, { color, matchMode });
      if (rawResponse?.ok === false) {
        throw new Error(rawResponse.message || '하이라이트를 적용하지 못했습니다.');
      }

      const normalized = normalizeHighlightResponse(rawResponse, normalizedKeyword, color);
      setResults(normalized.results);
      setResultCount(normalized.count);

      if (normalized.count > 0) {
        setStatusType('success');
        setStatusMessage(`총 ${normalized.count}건을 하이라이트했습니다.`);
      } else {
        setStatusType('empty');
        setStatusMessage('하이라이트할 단어를 찾을 수 없습니다.');
      }
    } catch (error) {
      console.error('[HighlightModal] highlight apply failed:', error);
      setResults([]);
      setResultCount(0);
      setStatusType('error');
      setStatusMessage('하이라이트 적용 중 오류가 발생했습니다. 다시 시도해주세요.');
    } finally {
      setIsApplying(false);
    }
  };

  const handleReset = () => {
    setKeyword('');
    setColor('yellow');
    setMatchMode('contains');
    setResults([]);
    setResultCount(0);
    setStatusMessage('');
    setStatusType('');
    setActiveHighlightId(null);
    onReset?.();
  };

  const handleClearAll = async () => {
    try {
      await onClearAll?.();
      setResults([]);
      setResultCount(0);
      setActiveHighlightId(null);
      setStatusType('success');
      setStatusMessage('하이라이트를 모두 제거했습니다.');
    } catch (error) {
      console.error('[HighlightModal] clear highlights failed:', error);
      setStatusType('error');
      setStatusMessage('하이라이트 적용 중 오류가 발생했습니다. 다시 시도해주세요.');
    }
  };

  const handleResultClick = (result) => {
    setActiveHighlightId(result.id);
    try {
      onResultClick?.(result);
    } catch (error) {
      console.warn('[HighlightModal] highlight result navigation failed:', error);
    }
  };

  const handleClose = () => {
    onReset?.();
    onClose?.();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={handleClose}>
      <div
        className="search-modal highlight-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="highlight-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-modal-header">
          <button
            type="button"
            className="search-modal-close"
            onClick={handleClose}
            aria-label="하이라이트 모달 닫기"
          >
            x
          </button>
        </div>

        <div className="search-modal-body">
          <h2 id="highlight-modal-title" className="search-modal-title">
            위치 하이라이트
          </h2>

          <div className="highlight-meta">
            <div><span>현재 문서</span><strong>{documentName || '-'}</strong></div>
            <div><span>파일 형식</span><strong>{documentType}</strong></div>
          </div>

          <div className="highlight-form">
            <label className="highlight-field" htmlFor="document-highlight-input">
              <span>하이라이트할 단어 또는 문장</span>
              <input
                id="document-highlight-input"
                className="highlight-input search-modal-input"
                type="text"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleApply();
                  }
                }}
                placeholder="하이라이트할 단어 또는 문장을 입력하세요"
                disabled={isApplying}
              />
            </label>

            <div className="highlight-options" role="radiogroup" aria-label="하이라이트 방식">
              <span>검색 방식</span>
              <label>
                <input
                  type="radio"
                  name="highlight-match-mode"
                  value="contains"
                  checked={matchMode === 'contains'}
                  onChange={() => setMatchMode('contains')}
                  disabled={isApplying}
                />
                포함
              </label>
              <label>
                <input
                  type="radio"
                  name="highlight-match-mode"
                  value="exact"
                  checked={matchMode === 'exact'}
                  onChange={() => setMatchMode('exact')}
                  disabled={isApplying}
                />
                정확히 일치
              </label>
            </div>

            <div className="highlight-color-options" aria-label="하이라이트 색상">
              <span>색상</span>
              <div>
                {COLOR_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`highlight-color-button ${color === option.value ? 'active' : ''}`}
                    data-color={option.value}
                    aria-pressed={color === option.value}
                    onClick={() => setColor(option.value)}
                    disabled={isApplying}
                  >
                    <span className="highlight-color-swatch" aria-hidden="true" />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="highlight-form-actions">
              <button
                type="button"
                className="highlight-button search-modal-button"
                onClick={handleApply}
                disabled={isApplying}
              >
                {isApplying ? '적용 중...' : '하이라이트 적용'}
              </button>
              <button
                type="button"
                className="highlight-reset-button"
                onClick={handleReset}
                disabled={isApplying}
              >
                초기화
              </button>
            </div>
          </div>

          {(statusMessage || initialDocumentMessage) ? (
            <div
              className={`highlight-status ${statusType ? `highlight-status-${statusType}` : ''}`}
              aria-live="polite"
            >
              {statusMessage || initialDocumentMessage}
            </div>
          ) : null}

          <div className="highlight-result-summary">
            적용 결과: 총 <strong>{resultCount}</strong>건
          </div>

          {results.length > 0 ? (
            <div className="highlight-result-table-wrap">
              <table className="highlight-result-table">
                <thead>
                  <tr>
                    <th>페이지</th>
                    <th>위치</th>
                    <th>내용</th>
                    <th>색상</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result, index) => (
                    <tr
                      key={result.id}
                      className={`highlight-result-row ${activeHighlightId === result.id ? 'active' : ''}`}
                      onClick={() => handleResultClick(result)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleResultClick(result);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-current={activeHighlightId === result.id ? 'true' : undefined}
                    >
                      <td>{result.pageNumber ? `${result.pageNumber}페이지` : '-'}</td>
                      <td>{formatHighlightLocation(result, index)}</td>
                      <td className="highlight-result-text" title={result.text}>{result.text || '-'}</td>
                      <td>{COLOR_LABELS[result.color] || COLOR_LABELS.yellow}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : statusType === 'empty' ? (
            <div className="highlight-result-empty">하이라이트할 단어를 찾을 수 없습니다.</div>
          ) : null}

          <div className="highlight-clear-actions">
            <button
              type="button"
              className="highlight-clear-button"
              onClick={handleClearAll}
              disabled={isApplying}
            >
              전체 제거
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default HighlightModal;
