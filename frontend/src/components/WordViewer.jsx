import './WordViewer.css';
function WordViewer({ previewModel }) {
  const { html, renderError, messages = [] } = previewModel || {};

  if (renderError) {
    return (
      <div className="word-viewer word-viewer-state" role="status">
        <strong>Word 문서를 표시할 수 없습니다.</strong>
        <span>{renderError}</span>
      </div>
    );
  }

  if (!html) {
    return (
      <div className="word-viewer word-viewer-state" role="status">
        <strong>표시할 DOCX 내용이 없습니다.</strong>
      </div>
    );
  }

  return (
    <div className="word-viewer-shell">
      {messages.length > 0 ? (
        <div className="word-viewer-warning" role="status">
          일부 Word 서식은 웹 미리보기에서 단순화될 수 있습니다.
        </div>
      ) : null}
      <div className="word-viewer-scroll">
        <article
          className="word-document"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

export default WordViewer;
