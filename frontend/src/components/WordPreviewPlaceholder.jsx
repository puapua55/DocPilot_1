function WordPreviewPlaceholder({
  fileName,
  fileSize,
  message = 'Word 문서 미리보기는 추후 지원 예정입니다.',
  description = '현재 1차 단계에서는 DOC/DOCX 문서의 선택과 유효성 검사만 지원합니다.'
}) {
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
          <h3>{message}</h3>
          <p>{description}</p>
        </div>
      </div>
    </div>
  );
}

export default WordPreviewPlaceholder;
