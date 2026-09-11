import { convertDocxFileWithTextReplace } from './docxTextReplaceService';
import {
  extractPdfToHtmlText,
  makeHtmlConvertedFileName,
  parseHtmlTextStructure,
  renderPdfFromHtmlText,
  replaceTextInHtmlText
} from './pdfHtmlTextConvertService';

export function getDocumentFileType(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  if (name.endsWith('.pdf') || type === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx') || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (name.endsWith('.doc') || type === 'application/msword') return 'doc';
  return 'unknown';
}

export async function applyTextReplacement({
  file,
  fileType,
  documentViewerRef,
  originalText,
  newText,
  options = {},
  onPdfApply
}) {
  if (!file) throw new Error('먼저 문서를 선택해주세요.');
  if (!originalText) throw new Error('기존 단어를 입력해주세요.');
  if (newText == null || newText === '') throw new Error('변경 단어를 입력해주세요.');

  const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';
  const selectedTargets = Array.isArray(options?.selectedTargets) ? options.selectedTargets : null;
  const searchResult = await documentViewerRef?.current?.searchDocument?.(originalText, { matchMode });
  const searchResults = Array.isArray(searchResult)
    ? searchResult
    : Array.isArray(searchResult?.results)
      ? searchResult.results
      : [];

  if (fileType === 'docx' || fileType === 'word') {
    const rawResult = documentViewerRef?.current?.replaceText?.(
      originalText,
      newText,
      { matchMode, selectedTargets }
    ) ?? { count: 0, results: [] };
    const replaceCount = typeof rawResult === 'number'
      ? rawResult
      : Number(rawResult?.count ?? rawResult?.replaceCount ?? 0);
    const results = Array.isArray(rawResult?.results) ? rawResult.results : searchResults;
    return { ...rawResult, count: replaceCount, replaceCount, results, kind: 'docx-apply' };
  }

  if (fileType === 'pdf') {
    const viewerResult = await documentViewerRef?.current?.replaceText?.(
      originalText, newText, { matchMode, selectedTargets }
    );
    const selectedResults = Array.isArray(viewerResult?.results)
      ? viewerResult.results
      : selectedTargets || searchResults;
    if (selectedResults.length > 0) {
      onPdfApply?.({
        originalText,
        newText,
        matchMode,
        selectedTargets: selectedResults,
        appliedAt: Date.now()
      });
    }
    return {
      count: selectedResults.length,
      replaceCount: selectedResults.length,
      results: selectedResults,
      kind: 'pdf-apply'
    };
  }

  throw new Error(fileType === 'doc' ? 'DOC 형식은 현재 텍스트 교체를 지원하지 않습니다. DOCX 파일을 사용해주세요.' : '지원하지 않는 파일 형식입니다.');
}

export async function convertTextReplacement({ file, fileType, originalText, newText, options = {} }) {
  if (!file) throw new Error('먼저 문서를 선택해주세요.');
  if (!originalText) throw new Error('기존 단어를 입력해주세요.');
  if (newText == null || newText === '') throw new Error('변경 단어를 입력해주세요.');

  if (fileType === 'docx' || fileType === 'word') {
    return convertDocxFileWithTextReplace(file, originalText, newText, options);
  }

  if (fileType === 'doc') {
    throw new Error('DOC 형식은 현재 변환 저장을 지원하지 않습니다. DOCX 파일을 사용해주세요.');
  }

  if (fileType !== 'pdf') throw new Error('지원하지 않는 파일 형식입니다.');

  const htmlText = await extractPdfToHtmlText(file);
  const replaceResult = replaceTextInHtmlText(htmlText, originalText, newText, options);
  const parsedStructure = parseHtmlTextStructure(replaceResult.htmlText);
  const totalTextCount = parsedStructure.pages.reduce((sum, page) => sum + page.texts.length, 0);
  const totalLineCount = parsedStructure.pages.reduce((sum, page) => sum + page.lines.length, 0);

  if (totalTextCount === 0) throw new Error('HTML 구조에서 .pdf-text를 찾지 못했습니다.');

  const outputFileName = makeHtmlConvertedFileName(file.name);
  if (replaceResult.replaceCount > 0) {
    await renderPdfFromHtmlText(replaceResult.htmlText, outputFileName);
  }

  return {
    success: true,
    outputFileName,
    fileName: outputFileName,
    fileType: 'pdf',
    replaceCount: replaceResult.replaceCount,
    pages: parsedStructure.pages.length,
    texts: totalTextCount,
    lines: totalLineCount
  };
}
