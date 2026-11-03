import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadPdfDocument } from '../services/pdfService';

function PreviewPage({ pdf, pageNumber, scrollRoot }) {
  const pageRef = useRef(null);
  const canvasRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [pageRatio, setPageRatio] = useState(0.72);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const node = pageRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { root: scrollRoot.current, rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    let renderTask;
    const render = async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const naturalViewport = page.getViewport({ scale: 1 });
      setPageRatio(naturalViewport.width / naturalViewport.height);
      const width = Math.min(pageRef.current?.clientWidth || 800, 900);
      const density = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (width / naturalViewport.width) * density });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      await renderTask.promise;
      if (!cancelled) setRendered(true);
    };
    render().catch((error) => {
      if (!cancelled && error?.name !== 'RenderingCancelledException') console.error('PDF preview render failed', error);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, visible]);

  return <div ref={pageRef} className="pdf-download-preview-page" style={{ aspectRatio: pageRatio }} data-page-number={pageNumber} data-rendered={rendered}>
    <canvas ref={canvasRef} aria-label={`${pageNumber}페이지 미리보기`} />
    <span className="pdf-download-preview-page-number">{pageNumber}</span>
  </div>;
}

export default function PdfDownloadPreview({ bytes, fileName, pageCount, isExtract, notice, documentFormat = 'PDF', suggestEncryption = false, encryptionSource = null, onCancel, onConfirm }) {
  const [pdf, setPdf] = useState(null);
  const [error, setError] = useState('');
  const [encryptDownload, setEncryptDownload] = useState(suggestEncryption);
  const [inheritEncryption, setInheritEncryption] = useState(Boolean(encryptionSource));
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [encryptionError, setEncryptionError] = useState('');
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef(null);
  const cancelRef = useRef(null);
  const docxPreviewRef = useRef(null);
  const isDocx = documentFormat === 'DOCX';
  const title = isExtract ? '페이지 추출 미리보기' : `${documentFormat} 다운로드 미리보기`;
  const failureMessage = isExtract ? '추출 실패하였습니다.' : '다운로드 실패했습니다';

  useEffect(() => {
    let active = true;
    let loadingTask;
    setPdf(null);
    setError('');
    if (isDocx) {
      const container = docxPreviewRef.current;
      Promise.all([import('docx-preview'), import('../services/docxDirectEditService.js')])
        .then(async ([{ renderAsync }, { makeDocxPageBreakPreview }]) => {
          const previewFile = await makeDocxPageBreakPreview(new Blob([bytes]));
          if (!active) return;
          await renderAsync(previewFile, container, container, {
            className: 'docx-download', inWrapper: true, breakPages: true, useBase64URL: true
          });
        }).then(() => { if (active) setPdf({ numPages: container.querySelectorAll('section.docx-download').length }); })
        .catch(loadError => {
          console.error('[DownloadPreview] DOCX preview failed:', loadError);
          if (active) setError(failureMessage);
        });
      return () => { active = false; };
    }
    loadPdfDocument(bytes.slice().buffer, { onLoadingTask: (task) => { loadingTask = task; } })
      .then((result) => { if (active) setPdf(result.pdf); })
      .catch((loadError) => {
        console.error('[DownloadPreview] PDF preview failed:', loadError);
        if (active) setError(failureMessage);
      });
    return () => {
      active = false;
      loadingTask?.destroy().catch(() => {});
    };
  }, [bytes, isDocx, failureMessage]);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, saving]);

  const confirmDownload = async () => {
    if (encryptDownload && !inheritEncryption && (password.length < 4 || (isDocx && password.length > 255))) {
      setEncryptionError(isDocx ? '비밀번호는 4~255자로 입력해주세요.' : '비밀번호를 4자 이상 입력해주세요.');
      return;
    }
    if (encryptDownload && !inheritEncryption && password !== passwordConfirmation) {
      setEncryptionError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setEncryptionError('');
    setSaving(true);
    try {
      await onConfirm({
        password: encryptDownload && !inheritEncryption ? password : undefined,
        inheritSource: encryptDownload && inheritEncryption ? encryptionSource : undefined
      });
    } catch (saveError) {
      console.error('[DownloadPreview] save failed:', saveError);
      setEncryptionError(failureMessage);
      setSaving(false);
    }
  };

  return createPortal(<div className="pdf-download-preview-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !saving) onCancel();
  }}>
    <section className="pdf-download-preview-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header className="pdf-download-preview-header">
        <div>
          <strong>{title}</strong>
          <span>{fileName} · {isDocx && pdf ? pdf.numPages : pageCount}페이지</span>
          {notice ? <span className="pdf-download-preview-notice">{notice}</span> : null}
        </div>
        <button type="button" onClick={onCancel} aria-label="미리보기 닫기" disabled={saving}>×</button>
      </header>
      <div ref={scrollRef} className="pdf-download-preview-scroll" aria-label={`스크롤 ${documentFormat} 미리보기`}>
        {isDocx ? <div ref={docxPreviewRef} className="docx-download-preview-document" /> : null}
        {error ? <p className="pdf-download-encryption-error" role="alert">{error}</p> : pdf ? !isDocx && Array.from({ length: pdf.numPages }, (_, index) => (
          <PreviewPage key={index + 1} pdf={pdf} pageNumber={index + 1} scrollRoot={scrollRef} />
        )) : <p role="status">{documentFormat} 미리보기를 준비 중입니다...</p>}
      </div>
      <div className="pdf-download-encryption-settings">
        <label className="pdf-download-encryption-toggle">
          <input type="checkbox" checked={encryptDownload} onChange={(event) => { setEncryptDownload(event.target.checked); setEncryptionError(''); }} disabled={saving} />
          암호화하여 다운로드
        </label>
        {encryptDownload && encryptionSource ? <div className="pdf-download-encryption-options" role="radiogroup" aria-label="암호화 방식">
          <label><input type="radio" name="pdf-encryption-mode" checked={inheritEncryption} onChange={() => setInheritEncryption(true)} disabled={saving} /> 원본 설정 승계 ({encryptionSource.name})</label>
          <label><input type="radio" name="pdf-encryption-mode" checked={!inheritEncryption} onChange={() => setInheritEncryption(false)} disabled={saving} /> 새 비밀번호 설정</label>
        </div> : null}
        {encryptDownload && !inheritEncryption ? <div className="pdf-download-encryption-fields">
          <input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setEncryptionError(''); }} placeholder="새 비밀번호 (4자 이상)" aria-label={`${documentFormat} 새 비밀번호`} autoComplete="new-password" disabled={saving} />
          <input type="password" value={passwordConfirmation} onChange={(event) => { setPasswordConfirmation(event.target.value); setEncryptionError(''); }} placeholder="비밀번호 확인" aria-label={`${documentFormat} 비밀번호 확인`} autoComplete="new-password" disabled={saving} />
        </div> : null}
        {encryptionError ? <span className="pdf-download-encryption-error" role="alert">{encryptionError}</span> : null}
      </div>
      <footer className="pdf-download-preview-footer">
        <button ref={cancelRef} type="button" className="pdf-download-preview-cancel" onClick={onCancel} disabled={saving}>취소</button>
        <button type="button" className="pdf-download-preview-confirm" onClick={confirmDownload} disabled={!pdf || Boolean(error) || saving}>{saving ? '암호화 중...' : '확인'}</button>
      </footer>
    </section>
  </div>, document.body);
}
