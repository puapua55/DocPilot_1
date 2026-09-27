import { useEffect, useMemo, useState } from 'react';
import DraggableResizableModal from './DraggableResizableModal';

const COLOR_OPTIONS = [
  { value: 'none', label: '미설정' },
  { value: 'yellow', label: '노랑' },
  { value: 'green', label: '초록' },
  { value: 'blue', label: '파랑' },
  { value: 'pink', label: '분홍' }
];

function normalizeHighlightResult(rawResult, index, keyword, color) {
  const raw = rawResult || {};
  return {
    id: raw.id || `highlight-result-${index}`,
    pageNumber: Number(raw.pageNumber ?? raw.page ?? 1) || 1,
    paragraphNumber: raw.paragraphNumber == null ? undefined : Number(raw.paragraphNumber),
    lineNumber: raw.lineNumber == null ? undefined : Number(raw.lineNumber),
    // Search results already contain one entry per match. Display the
    // matched token/phrase in the table instead of repeating the whole line
    // for every match on that line, just like the replacement list.
    text: String(raw.matchedText ?? raw.originalText ?? raw.text ?? raw.content ?? raw.fullText ?? '').trim(),
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
  onSearch,
  onApply,
  onReset,
  onResultClick,
  onClose
}) {
  const [keyword, setKeyword] = useState('');
  const [matchMode, setMatchMode] = useState('contains');
  const [results, setResults] = useState([]);
  const [resultCount, setResultCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [activeHighlightId, setActiveHighlightId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);

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
      setMatchMode('contains');
      setResults([]);
      setResultCount(0);
      setStatusMessage('');
      setStatusType('');
      setActiveHighlightId(null);
      setSelectedIds([]);
      setIsApplying(false);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleSearch = async () => {
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
    setStatusMessage('문서에서 텍스트를 찾고 있습니다.');
    setActiveHighlightId(null);

    try {
      const rawResponse = await onSearch?.(normalizedKeyword, { matchMode });
      if (rawResponse?.ok === false) {
        throw new Error(rawResponse.message || '하이라이트를 적용하지 못했습니다.');
      }

      const normalized = normalizeHighlightResponse(rawResponse, normalizedKeyword, 'none');
      setResults(normalized.results);
      setResultCount(normalized.count);
      setSelectedIds([]);

      if (normalized.count > 0) {
        setStatusType('success');
        setStatusMessage(`총 ${normalized.count}건을 찾았습니다. 하이라이트할 항목을 선택하세요.`);
      } else {
        setStatusType('empty');
        setStatusMessage('하이라이트할 단어를 찾을 수 없습니다.');
      }
    } catch (error) {
      console.error('[HighlightModal] highlight search failed:', error);
      setResults([]);
      setResultCount(0);
      setStatusType('error');
      setStatusMessage('검색 중 오류가 발생했습니다. 다시 시도해주세요.');
    } finally {
      setIsApplying(false);
    }
  };

  const handleApplySelected = async () => {
    const normalizedKeyword = keyword.trim();
    const selectedResults = results.filter((result) => selectedIds.includes(result.id));
    if (!selectedResults.length) {
      setStatusType('error');
      setStatusMessage('하이라이트할 항목을 하나 이상 선택해주세요.');
      return;
    }
    const colorAppliedResults = selectedResults.filter((result) => result.color !== 'none');
    if (!colorAppliedResults.length) {
      setStatusType('error');
      setStatusMessage('하이라이트 색상을 하나 이상 지정해주세요.');
      return;
    }
    setIsApplying(true);
    setStatusType('progress');
    setStatusMessage('선택한 항목에 하이라이트를 적용하고 있습니다.');
    try {
      const rawResponse = await onApply?.(normalizedKeyword, {
        matchMode,
        selectedTargets: colorAppliedResults.map((result) => ({ ...result.raw, color: result.color }))
      });
      if (rawResponse?.ok === false) throw new Error(rawResponse.message || '하이라이트를 적용하지 못했습니다.');
      const normalized = normalizeHighlightResponse(rawResponse, normalizedKeyword, 'none');
      setResults(normalized.results);
      setResultCount(normalized.count);
      setSelectedIds(normalized.results.map((result) => result.id));
      setStatusType('success');
      setStatusMessage(`${normalized.count}건에 하이라이트를 적용했습니다.`);
    } catch (error) {
      console.error('[HighlightModal] highlight apply failed:', error);
      setStatusType('error');
      setStatusMessage(error?.message || '하이라이트 적용 중 오류가 발생했습니다.');
    } finally {
      setIsApplying(false);
    }
  };

  const handleReset = () => {
    setKeyword('');
    setMatchMode('contains');
    setResults([]);
    setResultCount(0);
    setStatusMessage('');
    setStatusType('');
    setActiveHighlightId(null);
    setSelectedIds([]);
    onReset?.();
  };

  const handleResultClick = (result) => {
    setActiveHighlightId(result.id);
    setSelectedIds((current) => current.includes(result.id)
      ? current.filter((id) => id !== result.id) : [...current, result.id]);
    try {
      onResultClick?.(result);
    } catch (error) {
      console.warn('[HighlightModal] highlight result navigation failed:', error);
    }
  };

  const toggleSelectAll = () => {
    setSelectedIds((current) => (
      current.length === results.length ? [] : results.map((result) => result.id)
    ));
  };

  const updateResultColor = (id, nextColor) => {
    setResults((current) => current.map((result) => (
      result.id === id ? { ...result, color: nextColor } : result
    )));
  };

  const updateAllResultColors = (nextColor) => {
    setResults((current) => current.map((result) => ({ ...result, color: nextColor })));
  };

  const handleClose = () => {
    onReset?.();
    onClose?.();
  };

  return (
    <DraggableResizableModal
      title="위치 하이라이트"
      titleId="highlight-modal-title"
      className="highlight-panel"
      initialWidth={600}
      initialHeight={670}
      onClose={handleClose}
    >

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
                    handleSearch();
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

            <div className="highlight-form-actions">
              <button
                type="button"
                className="highlight-button highlight-search-button search-modal-button"
                onClick={handleSearch}
                disabled={isApplying}
              >
                {isApplying ? '처리 중...' : '검색'}
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

          {results.length > 0 ? (
            <div className="highlight-result-summary">
              <span>검색 결과: 총 <strong>{resultCount}</strong>건 · 선택 <strong>{selectedIds.length}</strong>건</span>
              <div className="highlight-result-actions">
                <button type="button" className="highlight-reset-button" onClick={toggleSelectAll} disabled={isApplying}>{selectedIds.length === results.length ? '전체 해제' : '전체 선택'}</button>
                {selectedIds.length === results.length ? (
                  <label className="highlight-all-color-control">
                    <span>전체 색상</span>
                    <select
                      value=""
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        if (event.target.value) updateAllResultColors(event.target.value);
                        event.target.value = '';
                      }}
                      disabled={isApplying}
                      aria-label="전체 검색 결과 하이라이트 색상"
                    >
                      <option value="">선택</option>
                      {COLOR_OPTIONS.filter((option) => option.value !== 'none').map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <button type="button" className="highlight-button search-modal-button" onClick={handleApplySelected} disabled={isApplying || selectedIds.length === 0}>적용</button>
              </div>
            </div>
          ) : null}

          {results.length > 0 ? (
            <div className="highlight-result-table-wrap">
              <table className="highlight-result-table">
                <thead>
                  <tr>
                    <th>선택</th>
                    <th>찾은 텍스트</th>
                    <th>하이라이트 색상</th>
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
                      <td className="highlight-result-check-cell"><input type="checkbox" checked={selectedIds.includes(result.id)} readOnly tabIndex={-1} aria-label={`${index + 1}번 하이라이트 결과 선택`} /></td>
                      <td className="highlight-result-text" title={result.text}>
                        <strong>{result.text || '-'}</strong>
                        <small>{result.pageNumber ? `${result.pageNumber}페이지` : '-'} · {formatHighlightLocation(result, index)}</small>
                      </td>
                      <td>
                        <select
                          className="highlight-result-color-select"
                          value={result.color || 'none'}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => updateResultColor(result.id, event.target.value)}
                          disabled={isApplying}
                          aria-label={`${index + 1}번 검색 결과 하이라이트 색상`}
                        >
                          {COLOR_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : statusType === 'empty' ? (
            <div className="highlight-result-empty">하이라이트할 단어를 찾을 수 없습니다.</div>
          ) : null}

    </DraggableResizableModal>
  );
}

export default HighlightModal;
