function WordPreviewPlaceholder({ fileName, fileSize }) {
  return (
    <div className="preview-card">
      <div className="preview-head">
        <div className="preview-label">Word Preview</div>
        <div className="preview-meta">
          <strong>{fileName}</strong>
          <span>{fileSize}</span>
        </div>
      </div>
      <div className="placeholder-wrap">
        <div className="placeholder-box">
          <h3>Word 문서 미리보기는 추후 지원 예정입니다.</h3>
          <p>현재 1차 단계에서는 DOC/DOCX 문서의 선택과 유효성 검사만 지원합니다.</p>
          <p>TODO: `mammoth` 기반 본문 추출 또는 렌더링 전략을 다음 단계에서 검토합니다.</p>
        </div>
      </div>
    </div>
  );
}

export default WordPreviewPlaceholder;
