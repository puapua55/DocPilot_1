import { useEffect, useState } from 'react';
import DraggableResizableModal from './DraggableResizableModal';

function replaceFirst(sourceValue, searchValue, replacementValue) {
  const source = String(sourceValue ?? '');
  const search = String(searchValue ?? '');
  if (!search) return source;
  const matchAt = source.toLowerCase().indexOf(search.toLowerCase());
  if (matchAt < 0) return source;
  return `${source.slice(0, matchAt)}${replacementValue}${source.slice(matchAt + search.length)}`;
}

function normalizeResults(response, keyword, newText) {
  const rawResults = Array.isArray(response)
    ? response
    : Array.isArray(response?.results) ? response.results : [];

  return rawResults.map((rawValue, index) => {
    const raw = rawValue?.raw || rawValue || {};
    const foundText = String(raw.matchedText ?? raw.originalText ?? raw.matchText ?? raw.text ?? keyword).trim();
    const pageNumber = Number(raw.pageNumber ?? raw.page) || null;
    const lineNumber = Number(raw.lineNumber ?? raw.line) || null;
    return {
      id: String(raw.id || `batch-replace-${pageNumber || 0}-${lineNumber || 0}-${raw.matchIndex ?? index}-${index}`),
      pageNumber,
      lineNumber,
      foundText,
      newText: replaceFirst(foundText, keyword, newText),
      originalOrder: index,
      raw
    };
  }).sort((first, second) => (
    (first.pageNumber ?? Number.MAX_SAFE_INTEGER) - (second.pageNumber ?? Number.MAX_SAFE_INTEGER)
    || (first.lineNumber ?? Number.MAX_SAFE_INTEGER) - (second.lineNumber ?? Number.MAX_SAFE_INTEGER)
    || Number(first.raw?.matchIndex ?? 0) - Number(second.raw?.matchIndex ?? 0)
    || first.originalOrder - second.originalOrder
  ));
}

function getInitialSelectedIds(results, initialValues) {
  if (initialValues?.selectAll === true) return results.map((result) => result.id);
  const targets = Array.isArray(initialValues?.selectedTargets) ? initialValues.selectedTargets : [];
  if (!targets.length) return [];
  return targets.map((target) => {
    const page = Number(target?.pageNumber ?? target?.page);
    const occurrence = Number(target?.occurrence);
    const pageResults = results.filter((result) => Number(result.pageNumber) === page);
    return pageResults[occurrence - 1]?.id || null;
  }).filter(Boolean);
}

function BatchTextReplaceModal({ isOpen, selectedDocument, previewModel, initialValues = null, onSearch, onApply, onResultClick, onClose }) {
  const [searchText, setSearchText] = useState('');
  const [replacementText, setReplacementText] = useState('');
  const [matchMode, setMatchMode] = useState('contains');
  const [results, setResults] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [statusType, setStatusType] = useState('');
  const [activeResultId, setActiveResultId] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setSearchText(String(initialValues?.originalText || ''));
      setReplacementText(String(initialValues?.newText || ''));
      setMatchMode(initialValues?.matchMode === 'exact' ? 'exact' : 'contains');
      const initialResults = normalizeResults(initialValues?.searchResults || [], initialValues?.originalText || '', initialValues?.newText || '');
      setResults(initialResults);
      setSelectedIds(getInitialSelectedIds(initialResults, initialValues));
      setActiveResultId(null);
      setBusy(false);
      setStatus('');
      setStatusType('');
    } else {
      setSearchText('');
      setReplacementText('');
      setMatchMode('contains');
      setResults([]);
      setSelectedIds([]);
      setActiveResultId(null);
      setBusy(false);
      setStatus('');
      setStatusType('');
    }
  }, [isOpen, initialValues]);

  if (!isOpen) return null;

  const runSearch = async () => {
    const keyword = searchText.trim();
    if (!selectedDocument?.file) {
      setStatus('먼저 문서를 선택해주세요.');
      setStatusType('error');
      return;
    }
    if (!keyword) {
      setStatus('찾을 텍스트를 입력해주세요.');
      setStatusType('error');
      return;
    }
    if (!replacementText.trim()) {
      setStatus('변경할 텍스트를 입력해주세요.');
      setStatusType('error');
      return;
    }

    setBusy(true);
    setStatus('문서에서 텍스트를 찾고 있습니다.');
    setStatusType('progress');
    try {
      const response = await onSearch?.(keyword, { matchMode });
      const nextResults = normalizeResults(response, keyword, replacementText);
      setResults(nextResults);
      setActiveResultId(null);
      // Searching only prepares the candidate rows. The user explicitly
      // chooses which rows to change, so none are checked by default.
      setSelectedIds([]);
      setStatus(nextResults.length ? `${nextResults.length}건을 찾았습니다. 변경할 항목을 선택하세요.` : '찾은 텍스트가 없습니다.');
      setStatusType(nextResults.length ? 'success' : 'empty');
    } catch (error) {
      console.error('[BatchTextReplaceModal] search failed:', error);
      setResults([]);
      setSelectedIds([]);
      setStatus(error?.message || '검색 중 오류가 발생했습니다.');
      setStatusType('error');
    } finally {
      setBusy(false);
    }
  };

  const handleReplacementChange = (value) => {
    setReplacementText(value);
    setResults((current) => current.map((result) => ({
      ...result,
      newText: replaceFirst(result.foundText, searchText.trim(), value)
    })));
  };

  const toggleResult = (id) => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((selectedId) => selectedId !== id)
      : [...current, id]);
  };

  const navigateToResult = (result) => {
    setActiveResultId(result.id);
    onResultClick?.({
      ...result.raw,
      pageNumber: result.pageNumber,
      lineNumber: result.lineNumber,
      keyword: searchText.trim(),
      matchedText: result.foundText,
      originalText: result.foundText
    });
  };

  const applySelected = async () => {
    const selectedResults = results.filter((result) => selectedIds.includes(result.id));
    if (!searchText.trim() || !replacementText.trim()) {
      setStatus('찾을 텍스트와 변경할 텍스트를 모두 입력해주세요.');
      setStatusType('error');
      return;
    }
    if (!selectedResults.length) {
      setStatus('적용할 항목을 하나 이상 체크해주세요.');
      setStatusType('error');
      return;
    }

    setBusy(true);
    setStatus(`${selectedResults.length}건을 적용하고 있습니다.`);
    setStatusType('progress');
    try {
      const response = await onApply?.(searchText.trim(), replacementText, {
        matchMode,
        selectedTargets: selectedResults.map((result) => result.raw)
      });
      const count = Number(response?.replaceCount ?? response?.count ?? selectedResults.length);
      setStatus(`${count}건을 적용했습니다.`);
      setStatusType('success');
      setSelectedIds([]);
    } catch (error) {
      console.error('[BatchTextReplaceModal] apply failed:', error);
      setStatus(error?.message || '텍스트 적용 중 오류가 발생했습니다.');
      setStatusType('error');
    } finally {
      setBusy(false);
    }
  };

  const documentName = selectedDocument?.file?.name || selectedDocument?.name || '-';
  const documentType = previewModel?.type === 'pdf' ? 'PDF' : previewModel?.type === 'word' ? 'DOCX' : '-';

  return (
    <DraggableResizableModal
      title="텍스트 일괄 변경"
      titleId="batch-text-replace-title"
      className="batch-replace-panel"
      initialWidth={600}
      initialHeight={670}
      minWidth={600}
      minHeight={420}
      onClose={onClose}
    >
      <div className="batch-replace-meta">
        <div><span>현재 문서</span><strong title={documentName}>{documentName}</strong></div>
        <div><span>파일 형식</span><strong>{documentType}</strong></div>
      </div>

      <div className="batch-replace-fields">
        <label className="batch-replace-field" htmlFor="batch-replace-search-text">
          <span>찾을 텍스트</span>
          <input
            id="batch-replace-search-text"
            className="search-modal-input"
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              setResults([]);
              setSelectedIds([]);
              setStatus('');
            }}
            onKeyDown={(event) => { if (event.key === 'Enter') runSearch(); }}
            placeholder="문서에서 찾을 텍스트"
            disabled={busy}
          />
        </label>
        <label className="batch-replace-field" htmlFor="batch-replace-new-text">
          <span>변경할 텍스트</span>
          <input
            id="batch-replace-new-text"
            className="search-modal-input"
            value={replacementText}
            onChange={(event) => handleReplacementChange(event.target.value)}
            placeholder="찾은 텍스트를 바꿀 내용"
            disabled={busy}
          />
        </label>
      </div>

      <div className="batch-replace-options" role="radiogroup" aria-label="검색 방식">
        <span>검색 방식</span>
        <label><input type="radio" name="batch-replace-match-mode" checked={matchMode === 'contains'} onChange={() => { setMatchMode('contains'); setResults([]); setSelectedIds([]); }} disabled={busy} /> 포함 검색</label>
        <label><input type="radio" name="batch-replace-match-mode" checked={matchMode === 'exact'} onChange={() => { setMatchMode('exact'); setResults([]); setSelectedIds([]); }} disabled={busy} /> 정확히 일치</label>
        <button type="button" className="search-modal-button" onClick={runSearch} disabled={busy}>{busy ? '처리 중...' : '검색'}</button>
      </div>

      {status ? <div className={`batch-replace-status is-${statusType}`} role="status" aria-live="polite">{status}</div> : null}

      {results.length ? (
        <>
          <div className="batch-replace-list-heading">
            <div>검색 결과 {results.length}건 · 선택 {selectedIds.length}건</div>
            <div className="batch-replace-list-actions">
              <button
                type="button"
                className="search-modal-button secondary"
                onClick={() => setSelectedIds(results.map((result) => result.id))}
                disabled={busy || selectedIds.length === results.length}
              >전체 선택</button>
              <button type="button" className="search-modal-button" onClick={applySelected} disabled={busy || !selectedIds.length}>
                {busy ? '적용 중...' : '적용'}
              </button>
            </div>
          </div>
          <div className="batch-replace-table-wrap">
            <table className="batch-replace-table">
              <thead><tr><th>No.</th><th>선택</th><th>찾은 텍스트</th><th>변경할 텍스트</th></tr></thead>
              <tbody>
                {results.map((result, index) => (
                  <tr
                    key={result.id}
                    data-search-result-trigger="true"
                    className={`batch-replace-result-row ${activeResultId === result.id ? 'active' : ''}`}
                    onClick={() => navigateToResult(result)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigateToResult(result);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-current={activeResultId === result.id ? 'true' : undefined}
                  >
                    <td className="batch-replace-index-cell">{index + 1}</td>
                    <td className="batch-replace-check-cell">
                      <input type="checkbox" checked={selectedIds.includes(result.id)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onChange={() => toggleResult(result.id)} aria-label={`페이지 ${result.pageNumber || '-'} 찾은 텍스트 ${result.foundText} 선택`} disabled={busy} />
                    </td>
                    <td title={result.foundText}>
                      <span className="batch-replace-value">{result.foundText || '-'}</span>
                      <small>{result.pageNumber ? `${result.pageNumber}페이지` : ''}{result.lineNumber ? ` · 줄 ${result.lineNumber}` : ''}</small>
                    </td>
                    <td title={result.newText}>{result.newText || <span className="batch-replace-placeholder">변경 텍스트를 입력하세요</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : statusType === 'empty' ? <div className="batch-replace-empty">검색 결과가 없습니다.</div> : null}
    </DraggableResizableModal>
  );
}

export default BatchTextReplaceModal;
