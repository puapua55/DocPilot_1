import { useEffect, useState } from 'react';
import { formatFileSize } from '../utils/fileUtils';
import { isMobileViewport } from '../utils/viewerUtils';

function PdfPreview({ file }) {
  const [objectUrl, setObjectUrl] = useState('');
  const mobile = isMobileViewport();

  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setObjectUrl(nextUrl);

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [file]);

  return (
    <div className="preview-card">
      <div className="preview-head">
        <div className="preview-label">PDF Preview</div>
        <div className="preview-meta">
          <strong>{file.name}</strong>
          <span>{formatFileSize(file.size)}</span>
        </div>
      </div>

      {mobile ? (
        <div className="mobile-preview-note">
          모바일 환경에서는 iframe 기반 PDF 미리보기가 브라우저에 따라 불안정할 수 있습니다.
        </div>
      ) : null}

      <div className="preview-frame-wrap">
        {objectUrl ? (
          <iframe
            className="preview-frame"
            title="pdf-preview"
            src={objectUrl}
          />
        ) : null}
      </div>
    </div>
  );
}

export default PdfPreview;
