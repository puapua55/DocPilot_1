import { useEffect, useState } from 'react';
import { convertDocxFileWithTextReplace } from '../services/docxTextReplaceService';
import {
  downloadHtmlTextFile,
  extractPdfToHtmlText,
  makeHtmlConvertedFileName,
  parseHtmlTextStructure,
  renderPdfFromHtmlText,
  replaceTextInHtmlText
} from '../services/pdfHtmlTextConvertService';

function getFileType(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();

  if (name.endsWith('.pdf') || type === 'application/pdf') {
    return 'pdf';
  }

  if (
    name.endsWith('.docx') ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }

  if (name.endsWith('.doc') || type === 'application/msword') {
    return 'doc';
  }

  return 'unknown';
}

function ReplaceModal({
  isOpen,
  selectedDocument,
  previewModel,
  onDocxReplace,
  onApplyPreview,
  onClose
}) {
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

  const selectedFile = selectedDocument?.file || null;
  const fileType = getFileType(selectedFile);
  const summaryPageCount = lastSummary?.pages ?? 0;
  const summaryTextCount = lastSummary?.texts ?? 0;
  const summaryLineCount = lastSummary?.lines ?? 0;
  const summaryReplacementCount = lastSummary?.replacements ?? 0;

  const applyDocxReplacement = (target, replacement) => {
    const result = onDocxReplace?.(target, replacement) || {
      replaceCount: 0,
      html: ''
    };
    const replaceCount = result.replaceCount ?? 0;

    setLastSummary({
      kind: 'docx-apply',
      replacements: replaceCount,
      outputFileName: selectedFile?.name || '',
      modifiedHtmlAvailable: Boolean(result.html)
    });
    setMessage(
      replaceCount > 0
        ? `DOCX 화면에 텍스트 치환 ${replaceCount}건 적용됨`
        : '교체할 텍스트를 찾을 수 없습니다.'
    );

    return result;
  };

  const handlePdfConvert = async (target, replacement) => {
    console.log('[ConvertTrace] handler file: ReplaceModal.jsx');
    console.log('[ConvertTrace] extractPdfToHtmlText function:', extractPdfToHtmlText);
    console.log('[ConvertTrace] replaceTextInHtmlText function:', replaceTextInHtmlText);
    console.log('[ConvertTrace] renderPdfFromHtmlText function:', renderPdfFromHtmlText);

    setMessage('PDF를 HTML 형식 텍스트 구조로 변환 중입니다...');

    const htmlText = await extractPdfToHtmlText(selectedFile);

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

    downloadHtmlTextFile(replacedHtmlText, selectedFile.name);

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
        kind: 'pdf',
        pages: parsedStructure.pages.length,
        texts: totalTextCount,
        lines: totalLineCount,
        replacements: 0,
        outputFileName: makeHtmlConvertedFileName(selectedFile.name),
        warning: ''
      });
      return;
    }

    setMessage('수정된 HTML 텍스트 구조를 PDF로 재생성 중입니다...');

    const outputFileName = makeHtmlConvertedFileName(selectedFile.name);
    await renderPdfFromHtmlText(replacedHtmlText, outputFileName);

    setLastSummary({
      kind: 'pdf',
      pages: parsedStructure.pages.length,
      texts: totalTextCount,
      lines: totalLineCount,
      replacements: replacementCount,
      outputFileName,
      warning: ''
    });
    setMessage('변환된 PDF가 다운로드되었습니다.');
  };

  const handleConvert = async () => {
    try {
      const target = String(originalText || '').trim();
      const replacement = String(newText || '').trim();

      console.log('========== [ConvertTrace] 변환 버튼 클릭됨 ==========');
      console.log('[ConvertTrace] selectedFile:', selectedFile?.name);
      console.log('[ConvertTrace] fileType:', fileType);
      console.log('[ConvertTrace] originalText:', target);
      console.log('[ConvertTrace] newText:', replacement);

      setIsConverting(true);
      setMessage('');
      setLastSummary(null);

      if (!selectedFile) {
        setMessage('먼저 문서를 선택해주세요.');
        return;
      }

      if (!target) {
        setMessage('기존 단어를 입력해주세요.');
        return;
      }

      if (!replacement) {
        setMessage('변경 단어를 입력해주세요.');
        return;
      }

      if (fileType === 'docx') {
        // 중요: [변환]은 뷰어 DOM replace를 호출하지 않습니다.
        // 항상 원본 selectedFile의 DOCX ZIP/XML을 수정해 새 .docx를 생성합니다.
        setMessage('DOCX 파일에 수정 내용을 반영하는 중입니다...');

        const result = await convertDocxFileWithTextReplace(
          selectedFile,
          target,
          replacement
        );

        setLastSummary({
          kind: 'docx-convert',
          outputFileName: result.outputFileName,
          replacements: result.replaceCount
        });
        setMessage(
          result.replaceCount > 0
            ? `DOCX 파일 변환 완료: 텍스트 치환 ${result.replaceCount}건`
            : 'DOCX 파일은 생성했지만 교체할 텍스트를 찾지 못했습니다.'
        );
        return;
      }

      if (fileType === 'doc') {
        setMessage('DOC 형식은 현재 변환 저장을 지원하지 않습니다. DOCX 파일을 사용해주세요.');
        return;
      }

      if (fileType === 'pdf') {
        // 기존 PDF → HTML 구조 → PDF 재생성 경로는 그대로 유지합니다.
        await handlePdfConvert(target, replacement);
        return;
      }

      setMessage('지원하지 않는 파일 형식입니다.');
    } catch (error) {
      console.error('[Convert] failed:', error);
      setMessage(error?.message || '문서 변환 중 오류가 발생했습니다.');
    } finally {
      setIsConverting(false);
    }
  };

  const handleApplyPreview = () => {
    const target = originalText.trim();

    if (!selectedFile) {
      setMessage('먼저 문서를 선택해주세요.');
      return;
    }

    if (!target) {
      setMessage('기존 단어를 입력해주세요.');
      return;
    }

    if (fileType === 'docx') {
      const replacement = newText.trim();
      if (!replacement) {
        setMessage('변경 단어를 입력해주세요.');
        return;
      }

      // [적용]은 기존대로 현재 DOCX 뷰어 DOM만 변경합니다.
      applyDocxReplacement(target, replacement);
      return;
    }

    if (fileType === 'doc') {
      setMessage('DOC 형식은 현재 텍스트 교체를 지원하지 않습니다. DOCX 파일을 사용해주세요.');
      return;
    }

    if (fileType !== 'pdf' || previewModel?.type !== 'pdf') {
      setMessage('지원하는 문서 형식이 아닙니다.');
      return;
    }

    // 기존 PDF 적용 동작은 변경하지 않습니다.
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
              {lastSummary.kind === 'docx-apply' ? (
                <>
                  <span>{lastSummary.outputFileName}</span>
                  <span>DOCX 화면 텍스트 치환 {summaryReplacementCount}건</span>
                  <span>현재 뷰어에만 반영되었으며 파일은 다운로드되지 않았습니다.</span>
                </>
              ) : lastSummary.kind === 'docx-convert' ? (
                <>
                  <span>{lastSummary.outputFileName}</span>
                  <span>DOCX 파일 텍스트 치환 {summaryReplacementCount}건</span>
                  <span>수정된 DOCX 파일을 다운로드했습니다.</span>
                </>
              ) : (
                <>
                  <span>{lastSummary.outputFileName}</span>
                  <span>
                    {summaryPageCount}페이지 / 텍스트 {summaryTextCount}개 / 선 {summaryLineCount}개
                  </span>
                  <span>텍스트 치환 {summaryReplacementCount}건</span>
                  {lastSummary.warning ? <span>{lastSummary.warning}</span> : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ReplaceModal;
