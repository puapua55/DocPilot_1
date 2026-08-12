import { useRef, useState } from 'react';

function UploadPanel({ errorMessage, onFileSelect }) {
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = (files) => {
    const file = files?.[0];
    if (file) {
      onFileSelect(file);
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  return (
    <section className="upload-panel">
      <div
        className={`upload-dropzone ${isDragging ? 'is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <div className="upload-mark" aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 16V7M12 7l-3 3M12 7l3 3M5 16.5v.5A2 2 0 0 0 7 19h10a2 2 0 0 0 2-2v-.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h2>문서를 선택하세요</h2>
        <p>PDF, DOCX 문서를 드래그하거나 클릭해 불러오기</p>
        <button
          type="button"
          className="primary-button"
          onClick={() => inputRef.current?.click()}
        >
          + 문서 선택
        </button>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept=".pdf,.doc,.docx"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <div className="secondary-meta">
          <span>현재 단계에서는 브라우저에서 문서를 임시로 엽니다.</span>
          <span>최종 Electron에서는 로컬 파일 열기와 저장 흐름으로 전환됩니다.</span>
        </div>
      </div>

      {errorMessage ? (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      ) : null}
    </section>
  );
}

export default UploadPanel;
