import './AiActionCard.css';

const ACTION_LABELS = {
  search: '문서 검색',
  highlight: '위치 하이라이트',
  'batch-replace': '텍스트 일괄 변경'
};

function AiActionCard({
  action,
  selectedFile,
  onSearch,
  onHighlight,
  onBatchReplace,
  disabled = false,
  runningType = ''
}) {
  if (!action || !ACTION_LABELS[action.type]) return null;

  const rows = [{ label: '작업 유형', value: ACTION_LABELS[action.type] }];
  if (action.type === 'search') rows.push({ label: '검색어', value: action.keyword || '-' });
  if (action.type === 'highlight') rows.push({ label: '대상 단어', value: action.keyword || '-' });
  if (action.type === 'batch-replace') {
    rows.push({ label: '찾을 텍스트', value: action.originalText || '-' });
    rows.push({ label: '변경할 텍스트', value: action.newText || '-' });
  }
  rows.push({ label: '대상 문서', value: selectedFile?.name || '선택된 문서 없음' });

  const isRunning = Boolean(runningType);
  const buttonDisabled = disabled || isRunning;

  return (
    <div className="ai-action-card" data-action-type={action.type}>
      <div className="ai-action-card-title">작업 준비됨</div>
      {rows.map((row) => (
        <div className="ai-action-card-row" key={row.label}>
          <span className="ai-action-card-label">{row.label}</span>
          <span className="ai-action-card-value">{row.value}</span>
        </div>
      ))}
      <div className="ai-action-card-buttons">
        {action.type === 'search' ? (
          <button type="button" className="ai-action-button" disabled={buttonDisabled} onClick={() => onSearch?.(action)}>
            {runningType === 'search' ? '검색 실행 중...' : '검색 실행'}
          </button>
        ) : null}
        {action.type === 'highlight' ? (
          <button type="button" className="ai-action-button" disabled={buttonDisabled} onClick={() => onHighlight?.(action)}>
            {runningType === 'highlight' ? '하이라이트 적용 중...' : '하이라이트 실행'}
          </button>
        ) : null}
        {action.type === 'batch-replace' ? (
          <button type="button" className="ai-action-button" disabled={buttonDisabled} onClick={() => onBatchReplace?.(action)}>
            {runningType === 'batch-replace' ? '열는 중...' : '텍스트 일괄 변경 열기'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default AiActionCard;
