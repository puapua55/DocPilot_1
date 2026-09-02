import { useEffect, useState } from 'react';
import {
  downloadHtmlTextFile,
  extractPdfToHtmlText,
  makeHtmlConvertedFileName,
  parseHtmlTextStructure,
  renderPdfFromHtmlText,
  replaceTextInHtmlText
} from '../services/pdfHtmlTextConvertService';
import { convertTextReplacement, getDocumentFileType } from '../services/documentReplaceService';

function ReplaceModal({ isOpen, selectedDocument, previewModel, onApplyPreview, onReplaceDocument, onClose }) {
  const [originalText, setOriginalText] = useState('');
  const [newText, setNewText] = useState('');
  const [message, setMessage] = useState('');
  const [isConverting, setIsConverting] = useState(false);
  const [lastSummary, setLastSummary] = useState(null);

  useEffect(() => {
    if (!isOpen) {
      setOriginalText('');
      setNewText('');
      setMessage('');
      setIsConverting(false);
      setLastSummary(null);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const summaryPageCount = lastSummary?.pages ?? 0;
  const summaryTextCount = lastSummary?.texts ?? 0;
  const summaryLineCount = lastSummary?.lines ?? 0;
  const summaryReplacementCount = lastSummary?.replacements ?? 0;

  const handleConvert = async () => {
    try {
      const target = String(originalText || '').trim();
      const replacement = String(newText || '').trim();
      const file = selectedDocument?.file;
      const fileType = getDocumentFileType(file);

      console.log('[ReplaceModal] convert clicked', {
        fileName: file?.name,
        fileType,
        originalText: target,
        newText: replacement
      });

      setIsConverting(true);
      setMessage('');
      setLastSummary(null);

      if (!target) {
        setMessage('기존 단어를 입력해주세요.');
        return;
      }

      if (!replacement) {
        setMessage('변경 단어를 입력해주세요.');
        return;
      }

      if (fileType === 'docx') {
        const result = await convertTextReplacement({
          file,
          fileType,
          originalText: target,
          newText: replacement
        });

        if (result.replaceCount === 0) {
          setMessage('교체할 텍스트를 찾을 수 없습니다.');
          return;
        }

        setLastSummary({
          pages: 0,
          texts: 0,
          lines: 0,
          replacements: result.replaceCount,
          outputFileName: result.outputFileName,
          warning: ''
        });
        setMessage('변환된 DOCX 파일이 다운로드되었습니다.');
        return;
      }

      if (!selectedDocument || previewModel?.type !== 'pdf' || !file) {
        setMessage('먼저 PDF 또는 DOCX 파일을 선택해주세요.');
        return;
      }

      setMessage('PDF를 HTML 형식 텍스트 구조로 변환 중입니다...');

      const htmlText = await extractPdfToHtmlText(file);

      console.log('[HtmlTextConvert] htmlText:', htmlText);
      console.log('[HtmlTextConvert] originalHtmlText:', htmlText);

      setMessage('HTML 텍스트 구조 안에서 텍스트를 치환하는 중입니다...');

      const replaceResult = replaceTextInHtmlText(htmlText, target, replacement);
      const replacedHtmlText = replaceResult.htmlText;
      const replacementCount = replaceResult.replaceCount;

      console.log('[HtmlTextConvert] replacedHtmlText:', replacedHtmlText);

      if (!replacedHtmlText.includes(replacement)) {
        console.warn('[HtmlTextConvert] replacedHtmlText does not include newText:', replacement);
      }

      if (replacedHtmlText.includes(target)) {
        console.warn('[HtmlTextConvert] replacedHtmlText still includes originalText:', target);
      }

      downloadHtmlTextFile(replacedHtmlText, file.name);

      const parsedStructure = parseHtmlTextStructure(replacedHtmlText);
      const totalTextCount = parsedStructure.pages.reduce((sum, page) => sum + page.texts.length, 0);
      const totalLineCount = parsedStructure.pages.reduce((sum, page) => sum + page.lines.length, 0);

      if (totalTextCount === 0) {
        throw new Error('HTML 구조에서 .pdf-text를 찾지 못했습니다.');
      }

      if (totalLineCount === 0) {
        throw new Error('HTML 구조에서 .pdf-line을 찾지 못했습니다.');
      }

      if (replacementCount === 0) {
        setMessage('교체할 텍스트를 찾을 수 없습니다.');
        setLastSummary({
          pages: parsedStructure.pages.length,
          texts: totalTextCount,
          lines: totalLineCount,
          replacements: 0,
          outputFileName: makeHtmlConvertedFileName(file.name),
          warning: ''
        });
        return;
      }

      setMessage('수정된 HTML 텍스트 구조를 PDF로 재생성 중입니다...');

      const outputFileName = makeHtmlConvertedFileName(file.name);
      await renderPdfFromHtmlText(replacedHtmlText, outputFileName);

      setLastSummary({
        pages: parsedStructure.pages.length,
        texts: totalTextCount,
        lines: totalLineCount,
        replacements: replacementCount,
        outputFileName,
        warning: ''
      });
      setMessage('변환된 PDF가 다운로드되었습니다.');
    } catch (error) {
      console.error('[Convert] failed:', error);
      setMessage(error?.message || 'PDF 변환 중 오류가 발생했습니다.');
    } finally {
      setIsConverting(false);
    }
  };

  const handleApplyPreview = () => {
    const target = originalText.trim();

    if (!target) {
      setMessage('기존 단어를 입력해주세요.');
      return;
    }

    const docxReplacementCount = onReplaceDocument?.(target, newText);

    if (typeof docxReplacementCount === 'number') {
      setMessage(
        docxReplacementCount > 0
          ? `DOCX 뷰어 화면에 ${docxReplacementCount}건의 교체를 적용했습니다.`
          : '교체할 텍스트를 찾을 수 없습니다.'
      );
      return;
    }

    if (!selectedDocument || previewModel?.type !== 'pdf') {
      setMessage('먼저 PDF 또는 DOCX 문서를 선택해주세요.');
      return;
    }

    onApplyPreview?.({
      originalText: target,
      newText,
      appliedAt: Date.now()
    });
    setMessage('현재 PDF 뷰어 화면에 교체 미리보기를 적용했습니다.');
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="search-modal replace-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replace-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-modal-header">
          <button
            type="button"
            className="search-modal-close"
            onClick={onClose}
            aria-label="텍스트 교체 모달 닫기"
          >
            x
          </button>
        </div>

        <div className="search-modal-body">
          <h2 id="replace-modal-title" className="search-modal-title">
            즉시 텍스트 교체
          </h2>
          {message ? <p className="search-modal-error">{message}</p> : null}
          <div className="replace-field-stack">
            <label className="replace-field">
              <span>기존 단어</span>
              <input
                className="search-modal-input"
                type="text"
                value={originalText}
                onChange={(event) => setOriginalText(event.target.value)}
                placeholder="예: 테스트"
              />
            </label>
            <label className="replace-field">
              <span>변경 단어</span>
              <input
                className="search-modal-input"
                type="text"
                value={newText}
                onChange={(event) => setNewText(event.target.value)}
                placeholder="예: 시험"
              />
            </label>
          </div>
          <div className="replace-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={handleApplyPreview}
              disabled={isConverting}
            >
              적용
            </button>
            <button
              type="button"
              className="search-modal-button"
              onClick={handleConvert}
              disabled={isConverting}
            >
              {isConverting ? '변환 중...' : '변환'}
            </button>
          </div>
          {lastSummary ? (
            (() => {
              console.log('[ConvertTrace] conversionResult UI value:', lastSummary);
              return null;
            })()
          ) : null}
          {lastSummary ? (
            <div className="replace-summary" role="status">
              <span>{lastSummary.outputFileName}</span>
              <span>
                {summaryPageCount}페이지 / 텍스트 {summaryTextCount}개 / 선 {summaryLineCount}개
              </span>
              <span>텍스트 치환 {summaryReplacementCount}건</span>
              {lastSummary.warning ? <span>{lastSummary.warning}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ReplaceModal;
