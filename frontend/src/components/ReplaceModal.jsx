import { useEffect, useMemo, useState } from 'react';

function replaceWithMode(text, target, replacement, matchMode) {
  const source = String(text || '');
  if (!target) return source;
  if (matchMode !== 'exact') return source.split(target).join(replacement);

  let cursor = 0;
  let output = '';
  while (cursor <= source.length - target.length) {
    const found = source.indexOf(target, cursor);
    if (found === -1) break;

    const beforeChar = found > 0 ? source[found - 1] : null;
    const afterIndex = found + target.length;
    const afterChar = afterIndex < source.length ? source[afterIndex] : null;
    const beforeOk = beforeChar == null || beforeChar === ' ' || beforeChar === '\n' || beforeChar === '\t';
    const afterOk = afterChar == null || afterChar === ' ' || afterChar === '\n' || afterChar === '\t';

    if (beforeOk && afterOk) {
      output += source.slice(cursor, found) + replacement;
      cursor = afterIndex;
    } else {
      output += source.slice(cursor, found + target.length);
      cursor = found + target.length;
    }
  }

  return output + source.slice(cursor);
}

function normalizeResult(raw, index, originalText, newText, matchMode) {
  const source = String(raw?.originalText ?? raw?.text ?? raw?.fullText ?? raw?.content ?? '').trim();
  return {
    id: raw?.id || `replace-result-${index}`,
    pageNumber: Number(raw?.pageNumber ?? raw?.page ?? 1) || 1,
    paragraphNumber: raw?.paragraphNumber == null ? undefined : Number(raw.paragraphNumber),
    lineNumber: raw?.lineNumber == null ? undefined : Number(raw.lineNumber),
    originalText: source,
    replacedText: String(raw?.replacedText ?? replaceWithMode(source, originalText, newText, matchMode)),
    keyword: String(raw?.keyword || originalText),
    newText: String(raw?.newText ?? newText),
    matchIndex: raw?.matchIndex,
    occurrenceIndex: raw?.occurrenceIndex,
    blockIndex: raw?.blockIndex,
    raw
  };
}

function normalizeResponse(raw, originalText, newText, matchMode) {
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
  const results = items.map((item, index) => normalizeResult(item, index, originalText, newText, matchMode));
  const count = typeof raw === 'number'
    ? raw
    : typeof raw?.count === 'number'
      ? raw.count
      : typeof raw?.replaceCount === 'number'
        ? raw.replaceCount
        : results.length;
  return { count, results };
}

function formatLocation(result, index) {
  const values = [];
  if (Number.isFinite(result.paragraphNumber)) values.push(`문단 ${result.paragraphNumber}`);
  if (Number.isFinite(result.lineNumber)) values.push(`줄 ${result.lineNumber}`);
  return values.length ? values.join(' / ') : `결과 ${index + 1}`;
}

function ReplaceModal({
  isOpen,
  selectedDocument,
  previewModel,
  onPreviewTargets,
  onApply,
  onConvert,
  onResultClick,
  onReset,
  onClose
}) {
  const [originalText, setOriginalText] = useState('');
  const [newText, setNewText] = useState('');
  const [matchMode, setMatchMode] = useState('contains');
  const [runningAction, setRunningAction] = useState(null);
  const [results, setResults] = useState([]);
  const [resultCount, setResultCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState('');
  const [activeResultId, setActiveResultId] = useState(null);
  const [selectedResultIds, setSelectedResultIds] = useState([]);

  const selectedFile = selectedDocument?.file || null;
  const documentName = selectedFile?.name || '';
  const documentType = previewModel?.type === 'pdf' ? 'PDF' : previewModel?.type === 'word' ? 'DOCX' : '-';
  const emptyDocumentMessage = useMemo(
    () => selectedDocument ? '' : '현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.',
    [selectedDocument]
  );

  useEffect(() => {
    if (!isOpen) {
      setOriginalText('');
      setNewText('');
      setMatchMode('contains');
      setRunningAction(null);
      setResults([]);
      setResultCount(0);
      setStatusMessage('');
      setStatusType('');
      setActiveResultId(null);
      setSelectedResultIds([]);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const validate = () => {
    if (!selectedDocument) {
      setStatusType('error');
      setStatusMessage('현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.');
      return false;
    }
    if (!originalText.trim()) {
      setStatusType('error');
      setStatusMessage('교체할 기존 단어를 입력해주세요.');
      return false;
    }
    if (!newText.trim()) {
      setStatusType('error');
      setStatusMessage('변경할 단어를 입력해주세요.');
      return false;
    }
    return true;
  };

  const run = async (action, work) => {
    if (runningAction || !validate()) return;
    setRunningAction(action);
    try {
      await work();
    } finally {
      setRunningAction(null);
    }
  };

  const setNormalized = (raw) => {
    const normalized = normalizeResponse(raw, originalText.trim(), newText, matchMode);
    setResults(normalized.results);
    setResultCount(normalized.count);
    return normalized;
  };

  const clearConfirmedTargets = () => {
    setResults([]);
    setResultCount(0);
    setSelectedResultIds([]);
    setActiveResultId(null);
    setStatusMessage('');
    setStatusType('');
  };

  const handlePreview = () => run('preview', async () => {
    setStatusType('progress');
    setStatusMessage('교체 대상을 확인하는 중입니다.');
    try {
      const normalized = setNormalized(await onPreviewTargets?.(originalText.trim(), newText, { matchMode }));
      setSelectedResultIds(normalized.results.map((result) => result.id));
      setStatusType(normalized.count ? 'success' : 'empty');
      setStatusMessage(normalized.count ? `총 ${normalized.count}건의 교체 대상을 찾았습니다.` : '교체할 단어를 찾을 수 없습니다.');
    } catch (error) {
      console.error('[ReplaceModal] preview failed:', error);
      setStatusType('error');
      setStatusMessage('텍스트 교체 중 오류가 발생했습니다. 다시 시도해주세요.');
    }
  });

  const handleApply = () => {
    const selectedResults = results.filter((result) => selectedResultIds.includes(result.id));
    if (selectedResults.length === 0) {
      setStatusType('error');
      setStatusMessage('적용할 교체 대상을 하나 이상 선택해주세요.');
      return;
    }

    return run('apply', async () => {
    setStatusType('progress');
    setStatusMessage('화면에 텍스트 교체를 적용하는 중입니다.');
    try {
      const normalized = normalizeResponse(await onApply?.(originalText.trim(), newText, {
        matchMode,
        selectedTargets: selectedResults
      }), originalText.trim(), newText, matchMode);
      setStatusType(normalized.count ? 'success' : 'empty');
      setStatusMessage(normalized.count ? `화면에 총 ${normalized.count}건을 적용했습니다.` : '교체할 단어를 찾을 수 없습니다.');
    } catch (error) {
      console.error('[ReplaceModal] apply failed:', error);
      setStatusType('error');
      setStatusMessage('텍스트 교체 중 오류가 발생했습니다. 다시 시도해주세요.');
    }
    });
  };

  const handleConvert = () => run('convert', async () => {
    setStatusType('progress');
    setStatusMessage('변환 파일을 생성하는 중입니다.');
    try {
      if (results.length === 0) {
        const normalized = setNormalized(await onPreviewTargets?.(originalText.trim(), newText, { matchMode }));
        setSelectedResultIds(normalized.results.map((item) => item.id));
      }
      const result = await onConvert?.(originalText.trim(), newText, { matchMode });
      const fileName = result?.fileName || result?.outputFileName || '변환 파일';
      const count = Number(result?.replaceCount ?? 0);
      setResultCount(count);
      setStatusType(count ? 'success' : 'empty');
      setStatusMessage(count ? `변환 파일이 생성되었습니다: ${fileName} (치환 ${count}건)` : '교체할 단어를 찾을 수 없습니다.');
    } catch (error) {
      console.error('[ReplaceModal] conversion failed:', error);
      setStatusType('error');
      setStatusMessage('변환 파일 생성 중 오류가 발생했습니다.');
    }
  });

  const handleReset = () => {
    setOriginalText('');
    setNewText('');
    setMatchMode('contains');
    setResults([]);
    setResultCount(0);
    setStatusMessage('');
    setStatusType('');
    setActiveResultId(null);
    setSelectedResultIds([]);
    onReset?.();
  };

  const toggleResultSelection = (resultId) => {
    setSelectedResultIds((current) => (
      current.includes(resultId)
        ? current.filter((id) => id !== resultId)
        : [...current, resultId]
    ));
  };

  const handleClose = () => {
    onReset?.();
    onClose?.();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="search-modal replace-panel" role="dialog" aria-modal="true" aria-labelledby="replace-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="search-modal-header">
          <button type="button" className="search-modal-close" onClick={handleClose} aria-label="텍스트 교체 모달 닫기">x</button>
        </div>

        <div className="search-modal-body">
          <h2 id="replace-modal-title" className="search-modal-title">즉시 텍스트 교체</h2>

          <div className="replace-meta">
            <div><span>현재 문서</span><strong>{documentName || '-'}</strong></div>
            <div><span>파일 형식</span><strong>{documentType}</strong></div>
          </div>

          <div className="replace-form">
            <label className="replace-field" htmlFor="replace-original-input">
              <span>기존 단어</span>
              <input id="replace-original-input" className="replace-input search-modal-input" value={originalText} onChange={(e) => { setOriginalText(e.target.value); clearConfirmedTargets(); }} placeholder="예: 테스트" disabled={runningAction !== null} />
            </label>
            <label className="replace-field" htmlFor="replace-new-input">
              <span>변경 단어</span>
              <input id="replace-new-input" className="replace-input search-modal-input" value={newText} onChange={(e) => { setNewText(e.target.value); clearConfirmedTargets(); }} placeholder="예: 시험" disabled={runningAction !== null} />
            </label>

            <div className="replace-options" role="radiogroup" aria-label="교체 방식">
              <span>교체 방식</span>
              <label><input type="radio" name="replace-match-mode" checked={matchMode === 'contains'} onChange={() => { setMatchMode('contains'); clearConfirmedTargets(); }} disabled={runningAction !== null} /> 포함 교체</label>
              <label><input type="radio" name="replace-match-mode" checked={matchMode === 'exact'} onChange={() => { setMatchMode('exact'); clearConfirmedTargets(); }} disabled={runningAction !== null} /> 정확히 일치</label>
            </div>

            <div className="replace-form-actions">
              <button type="button" className="replace-button secondary-button" onClick={handlePreview} disabled={runningAction !== null}>{runningAction === 'preview' ? '대상 확인 중...' : '대상 확인'}</button>
              {results.length > 0 ? <button type="button" className="replace-apply-button secondary-button" onClick={handleApply} disabled={runningAction !== null}>{runningAction === 'apply' ? '적용 중...' : '화면에 적용'}</button> : null}
              <button type="button" className="replace-convert-button search-modal-button" onClick={handleConvert} disabled={runningAction !== null}>{runningAction === 'convert' ? '변환 중...' : '변환 파일 다운로드'}</button>
              <button type="button" className="replace-reset-button" onClick={handleReset} disabled={runningAction !== null}>초기화</button>
            </div>
          </div>

          <div className="replace-help">
            화면에 적용은 현재 뷰어 미리보기만 변경합니다. 실제 파일 저장은 변환 파일 다운로드를 사용하세요.
            초기화는 입력값과 결과 목록만 비우며, 이미 화면에 적용된 임시 치환은 되돌리지 않습니다.
          </div>

          {(statusMessage || emptyDocumentMessage) ? <div className={`replace-status ${statusType ? `replace-status-${statusType}` : ''}`} aria-live="polite">{statusMessage || emptyDocumentMessage}</div> : null}

          <div className="replace-result-summary-row">
            <div className="replace-result-summary">교체 대상: 총 <strong>{resultCount}</strong>건</div>
            {results.length > 0 ? (
              <button
                type="button"
                className="replace-select-all-button secondary-button"
                onClick={() => setSelectedResultIds(results.map((result) => result.id))}
                disabled={runningAction !== null || selectedResultIds.length === results.length}
              >
                전체 선택
              </button>
            ) : null}
          </div>

          {results.length > 0 ? (
            <div className="replace-result-table-wrap">
              <table className="replace-result-table">
                <thead><tr><th>선택</th><th>페이지</th><th>위치</th><th>기존 내용</th><th>변경 후</th></tr></thead>
                <tbody>
                  {results.map((result, index) => (
                    <tr
                      key={result.id}
                      className={`replace-result-row ${activeResultId === result.id ? 'active' : ''}`}
                      onClick={() => { setActiveResultId(result.id); onResultClick?.(result); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setActiveResultId(result.id);
                          onResultClick?.(result);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <td className="replace-result-check-cell" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`교체 대상 ${index + 1} 선택`}
                          checked={selectedResultIds.includes(result.id)}
                          disabled={runningAction !== null}
                          onChange={() => toggleResultSelection(result.id)}
                          onKeyDown={(event) => event.stopPropagation()}
                        />
                      </td>
                      <td>{result.pageNumber ? `${result.pageNumber}페이지` : '-'}</td>
                      <td>{formatLocation(result, index)}</td>
                      <td className="replace-result-text" title={result.originalText}>{result.originalText || '-'}</td>
                      <td className="replace-result-text" title={result.replacedText}>{result.replacedText || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : statusType === 'empty' ? <div className="replace-result-empty">교체할 단어를 찾을 수 없습니다.</div> : null}
        </div>
      </div>
    </div>
  );
}

export default ReplaceModal;
