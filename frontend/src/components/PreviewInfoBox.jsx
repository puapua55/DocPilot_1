function PreviewInfoBox() {
  return (
    <div className="preview-card">
      <div className="preview-head">
        <div>
          <div className="preview-label">Preview</div>
        </div>
      </div>
      <div className="placeholder-wrap">
        <div className="info-box">
          <h3>문서 미리보기 영역</h3>
          <p>문서를 선택하면 이 영역에 PDF 기본 미리보기 또는 Word 안내 화면이 표시됩니다.</p>
          <p>PDF.js textLayer, 글자 선택, 글씨체/선택영역 보정 로직은 이번 단계에서 제외했습니다.</p>
        </div>
      </div>
    </div>
  );
}

export default PreviewInfoBox;
