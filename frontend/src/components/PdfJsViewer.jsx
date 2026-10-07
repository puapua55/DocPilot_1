import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import PdfPage from './PdfPage';
import PdfTableToolbar from './PdfTableToolbar';
import TextAlignmentIcon from './TextAlignmentIcon';
import { loadPdfDocument } from '../services/pdfService';
import { searchKeywordInDocument } from '../services/searchService';
import { isPdfFile } from '../utils/fileUtils';
import { resolveReplacementPreviewFont } from '../services/pdfReplacementFont';
import { createHighlightBoxesFromTextLayer } from '../services/highlightService';
import { duplicateTable, tableSizes, tableToTsv } from '../services/pdfTableModel.js';

let copiedPdfTable = null;

function fitMovableTextToBox(value, settings, target) {
  const text = String(value ?? '');
  const sourceSize = Math.max(4, Number(settings.baseFontSize ?? settings.fontSize) || 10);
  const sourceSpacing = Number(settings.baseLetterSpacing ?? settings.letterSpacing) || 0;
  if (target?.manualFontSize) {
    return { fontSize: Math.max(4, Number(settings.fontSize) || sourceSize), letterSpacing: sourceSpacing };
  }
  if (target?.type === 'addedText') {
    return { fontSize: sourceSize, letterSpacing: sourceSpacing };
  }
  const boxWidth = Number(target?.fitTextWidth || target?.originalRect?.width || target?.currentRect?.width || 0);
  if (!text || boxWidth <= 0 || typeof document === 'undefined') {
    return { fontSize: sourceSize, letterSpacing: sourceSpacing };
  }
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return { fontSize: sourceSize, letterSpacing: sourceSpacing };
  const family = target?.renderFontFamily || settings.fontFamily || target?.fontFamily || 'Arial, sans-serif';
  const weight = settings.fontWeight || target?.fontWeight || 'normal';
  const style = settings.fontStyle || target?.fontStyle || 'normal';
  const glyphGaps = Math.max(0, [...text].length - 1);
  const minSpacing = Math.min(sourceSpacing, -sourceSize * 0.12);
  const fontRuns = Array.isArray(settings.fontRuns) && settings.fontRuns.length > 0 ? settings.fontRuns : null;
  const fontRunsBaseSize = Math.max(1, Number(target?.autoFitBaseFontSize || settings.baseFontSize || sourceSize));
  const measure = (size) => {
    if (fontRuns) {
      const sizeRatio = size / fontRunsBaseSize;
      return fontRuns.reduce((width, run) => {
        context.font = `${run.fontStyle || style} ${run.fontWeight || weight} ${Math.max(1, Number(run.fontSize || sourceSize) * sizeRatio)}px ${run.fontFamily || family}`;
        return width + context.measureText(String(run.text || '')).width;
      }, 0);
    }
    context.font = `${style} ${weight} ${size}px ${family}`;
    return context.measureText(text).width;
  };
  let fontSize = sourceSize;
  let naturalWidth = measure(fontSize);
  let letterSpacing = sourceSpacing;
  if (naturalWidth + glyphGaps * letterSpacing > boxWidth) {
    letterSpacing = glyphGaps ? Math.max(minSpacing, (boxWidth - naturalWidth) / glyphGaps) : 0;
    if (naturalWidth + glyphGaps * letterSpacing > boxWidth && fontSize > 4) {
      let low = 4;
      let high = fontSize;
      for (let i = 0; i < 18; i += 1) {
        const mid = (low + high) / 2;
        if (measure(mid) + glyphGaps * minSpacing <= boxWidth) low = mid;
        else high = mid;
      }
      fontSize = low;
      naturalWidth = measure(fontSize);
      letterSpacing = glyphGaps ? Math.max(minSpacing * (fontSize / sourceSize), (boxWidth - naturalWidth) / glyphGaps) : 0;
    }
  }
  return { fontSize, letterSpacing };
}

function resizeMovableTextItem(item, currentRect) {
  const resized = {
    ...item,
    currentRect,
    movedRect: currentRect,
    displayRect: currentRect,
    fitTextWidth: currentRect.width,
    hasChanges: item.persistedToPdf ? true : item.hasChanges
  };
  const value = String(item.displayText ?? item.text ?? '');
  const fitted = fitMovableTextToBox(value, {
    fontSize: Number(item.fontSize) || 10,
    baseFontSize: Number(item.autoFitBaseFontSize || item.fontSize) || 10,
    baseLetterSpacing: Number(item.autoFitBaseLetterSpacing ?? item.letterSpacing) || 0,
    fontWeight: item.fontWeight,
    fontStyle: item.fontStyle,
    fontRuns: item.fontRuns,
    fontFamily: getCurrentFontCandidate(item)
  }, resized);
  return { ...resized, ...fitted };
}

function applyFontFamilyToRunRange(fontRuns, selectionRange, fontFamily, rangeId) {
  const start = Math.max(0, Number(selectionRange?.start) || 0);
  const end = Math.max(start, Number(selectionRange?.end) || 0);
  if (end <= start) return null;
  let offset = 0;
  const nextRuns = [];
  fontRuns.forEach((run) => {
    const text = String(run.text || '');
    const runStart = offset;
    const runEnd = runStart + text.length;
    const selectedStart = Math.max(start, runStart);
    const selectedEnd = Math.min(end, runEnd);
    if (selectedStart >= selectedEnd) {
      nextRuns.push(run);
      offset = runEnd;
      return;
    }
    const localStart = selectedStart - runStart;
    const localEnd = selectedEnd - runStart;
    if (localStart > 0) nextRuns.push({ ...run, text: text.slice(0, localStart) });
    const selectedFont = fontFamily ? {
      ...run,
      text: text.slice(localStart, localEnd),
      selectedFontFamily: fontFamily,
      fontRangeId: rangeId,
      originalFontCandidates: run.originalFontCandidates || run.fontCandidates || [],
      originalFontFamily: run.originalFontFamily || run.fontFamily || '',
      fontCandidates: [fontFamily],
      preferBoldFont: run.fontWeight === 'bold' || Number(run.fontWeight) >= 600
    } : {
      ...run,
      text: text.slice(localStart, localEnd),
      selectedFontFamily: '',
      fontRangeId: rangeId,
      fontCandidates: run.originalFontCandidates || run.fontCandidates || [],
      fontFamily: run.originalFontFamily || run.fontFamily || '',
      preferBoldFont: run.originalPreferBoldFont === true || run.fontWeight === 'bold' || Number(run.fontWeight) >= 600
    };
    nextRuns.push(selectedFont);
    if (localEnd < text.length) nextRuns.push({ ...run, text: text.slice(localEnd) });
    offset = runEnd;
  });
  return nextRuns;
}

function applyInlineStyleToRunRange(fontRuns, selectionRange, style, fontSizeScale = 1) {
  const start = Math.max(0, Number(selectionRange?.start) || 0);
  const end = Math.max(start, Number(selectionRange?.end) || 0);
  if (end <= start) return null;
  let offset = 0;
  const nextRuns = [];
  fontRuns.forEach((run) => {
    const text = String(run.text || '');
    const runStart = offset;
    const runEnd = runStart + text.length;
    offset = runEnd;
    const selectedStart = Math.max(start, runStart);
    const selectedEnd = Math.min(end, runEnd);
    if (selectedStart >= selectedEnd) {
      nextRuns.push(run);
      return;
    }
    const localStart = selectedStart - runStart;
    const localEnd = selectedEnd - runStart;
    if (localStart > 0) nextRuns.push({ ...run, text: text.slice(0, localStart) });
    const selectedRun = { ...run, text: text.slice(localStart, localEnd) };
    Object.entries(style).forEach(([key, value]) => {
      if (key === 'fontSize') selectedRun.fontSize = Number(value) / Math.max(0.01, fontSizeScale);
      else selectedRun[key] = value;
    });
    nextRuns.push(selectedRun);
    if (localEnd < text.length) nextRuns.push({ ...run, text: text.slice(localEnd) });
  });
  return nextRuns;
}

function normalizeFontRunsForText(fontRuns, text) {
  const runs = Array.isArray(fontRuns) ? fontRuns.map((run) => ({ ...run, text: String(run.text || '') })) : [];
  if (!runs.length) return [];
  const joined = runs.map((run) => run.text).join('');
  if (joined.trim() !== text) {
    // A commit can trim or otherwise normalize editor text. Do not discard
    // every later font run when that happens: align the old and new text and
    // retain the original run style for characters that still match.
    if (!text) return [];
    const oldLength = joined.length;
    const newLength = text.length;
    const runAtOffset = new Int32Array(oldLength);
    let sourceOffset = 0;
    runs.forEach((run, index) => {
      runAtOffset.fill(index, sourceOffset, sourceOffset + run.text.length);
      sourceOffset += run.text.length;
    });

    // Keep memory and work bounded for unusually large text boxes. Ordinary
    // paragraph edits use LCS alignment; the fallback keeps each font run's
    // relative share instead of collapsing the paragraph to its first run.
    const maxAlignmentCells = 2_000_000;
    const matchedOldByNew = new Int32Array(newLength).fill(-1);
    if (oldLength > 0 && oldLength * newLength <= maxAlignmentCells) {
      const width = newLength + 1;
      const table = Array.from({ length: oldLength + 1 }, () => new Uint16Array(width));
      for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
          table[oldIndex][newIndex] = joined[oldIndex] === text[newIndex]
            ? table[oldIndex + 1][newIndex + 1] + 1
            : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
        }
      }
      let oldIndex = 0;
      let newIndex = 0;
      while (oldIndex < oldLength && newIndex < newLength) {
        if (joined[oldIndex] === text[newIndex]) {
          matchedOldByNew[newIndex] = oldIndex;
          oldIndex += 1;
          newIndex += 1;
        } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
          oldIndex += 1;
        } else {
          newIndex += 1;
        }
      }
    } else {
      let prefix = 0;
      while (prefix < oldLength && prefix < newLength && joined[prefix] === text[prefix]) prefix += 1;
      let suffix = 0;
      while (suffix < oldLength - prefix && suffix < newLength - prefix
        && joined[oldLength - 1 - suffix] === text[newLength - 1 - suffix]) suffix += 1;
      for (let index = 0; index < prefix; index += 1) matchedOldByNew[index] = index;
      for (let index = 0; index < suffix; index += 1) {
        matchedOldByNew[newLength - 1 - index] = oldLength - 1 - index;
      }
    }

    const runAtNewOffset = new Int32Array(newLength).fill(-1);
    for (let index = 0; index < newLength; index += 1) {
      const oldIndex = matchedOldByNew[index];
      if (oldIndex >= 0) runAtNewOffset[index] = runAtOffset[oldIndex];
    }
    let nearestLeft = -1;
    for (let index = 0; index < newLength; index += 1) {
      if (runAtNewOffset[index] >= 0) nearestLeft = runAtNewOffset[index];
      else if (nearestLeft >= 0) runAtNewOffset[index] = nearestLeft;
    }
    let nearestRight = -1;
    for (let index = newLength - 1; index >= 0; index -= 1) {
      if (runAtNewOffset[index] >= 0) nearestRight = runAtNewOffset[index];
      else if (nearestRight >= 0) runAtNewOffset[index] = nearestRight;
    }
    // If the entire value was replaced, no old character can anchor it.
    if (!runAtNewOffset.some((runIndex) => runIndex >= 0)) runAtNewOffset.fill(0);

    const reconciled = [];
    for (let index = 0; index < newLength; index += 1) {
      const runIndex = runAtNewOffset[index] >= 0 ? runAtNewOffset[index] : 0;
      const previous = reconciled[reconciled.length - 1];
      if (previous?.sourceRunIndex === runIndex) previous.text += text[index];
      else reconciled.push({ ...runs[runIndex], sourceRunIndex: runIndex, text: text[index] });
    }
    return reconciled;
  }
  let trimStart = joined.length - joined.trimStart().length;
  let remaining = joined.trim().length;
  return runs.map((run) => {
    const start = Math.min(trimStart, run.text.length);
    trimStart -= start;
    const available = run.text.length - start;
    const kept = Math.min(remaining, available);
    remaining -= kept;
    return { ...run, text: run.text.slice(start, start + kept) };
  }).filter((run) => run.text);
}

function ensureEditableFontRuns(item, value) {
  const text = String(value || '');
  const existing = normalizeFontRunsForText(item?.fontRuns, text);
  if (existing.length) return existing;
  const candidates = [...new Set([
    ...(Array.isArray(item?.originalFontCandidates) ? item.originalFontCandidates : []),
    ...(Array.isArray(item?.fontCandidates) ? item.fontCandidates : [])
  ].filter((candidate) => typeof candidate === 'string' && candidate.trim()))];
  return text ? [{
    text,
    fontCandidates: candidates,
    originalFontCandidates: candidates,
    fontFamily: item?.previewFontFamily || item?.fontFamily || 'DocPilotReplacement',
    originalFontFamily: item?.fontFamily || item?.previewFontFamily || 'DocPilotReplacement',
    fontSize: Number(item?.autoFitBaseFontSize || item?.fontSize) || 10,
    fontWeight: item?.fontWeight || 'normal',
    fontStyle: item?.fontStyle || 'normal',
    textDecoration: item?.textDecoration || 'none',
    color: item?.color || '#111111',
    preferBoldFont: item?.originalPreferBoldFont === true || item?.preferBoldFont === true,
    originalPreferBoldFont: item?.originalPreferBoldFont === true || item?.preferBoldFont === true
  }] : [];
}

function getCurrentFontCandidate(item) {
  const candidates = [
    item?.selectedFontFamily,
    item?.previewFontFamily,
    ...(Array.isArray(item?.fontRuns) ? item.fontRuns.flatMap((run) => [
      run.selectedFontFamily,
      ...(Array.isArray(run.originalFontCandidates) ? run.originalFontCandidates : []),
      ...(Array.isArray(run.fontCandidates) ? run.fontCandidates : []),
      run.originalFontFamily,
      run.fontFamily
    ]) : []),
    ...(Array.isArray(item?.originalFontCandidates) ? item.originalFontCandidates : []),
    ...(Array.isArray(item?.fontCandidates) ? item.fontCandidates : []),
    item?.fontFamily
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim() || '';
}

function normalizeFontDisplayKey(value) {
  return String(value || '')
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/-\d{4,6}$/, '')
    .replace(/(bold|italic|oblique|regular|medium|light|black|semibold|demibold|heavy)mt$/i, '$1')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLocaleLowerCase();
}

function resolveDisplayedFont(fontValue, fonts) {
  if (!fontValue) return { value: '', label: '' };
  const key = normalizeFontDisplayKey(fontValue);
  const match = fonts.find((font) => [font.candidate, font.family, font.label]
    .some((name) => normalizeFontDisplayKey(name) === key));
  if (match) return { value: match.candidate, label: match.label || match.candidate };
  const readableName = String(fontValue).replace(/^[A-Z]{6}\+/, '').replace(/-\d{4,6}$/, '')
    .replace(/-(Bold|Italic|Regular|Medium|Light|Black)MT$/i, ' $1');
  return { value: fontValue, label: readableName };
}

function normalizePdfLines(textItems) {
  const groupedLines = [];

  textItems.forEach((item) => {
    // Keep PDF.js whitespace tokens. A comma can be a separate item right
    // after a word, while its following space is another item.
    const value = String(item?.str || '');
    if (!value) {
      return;
    }

    const y = Array.isArray(item?.transform) ? Number(item.transform[5]) || 0 : 0;
    const lastLine = groupedLines[groupedLines.length - 1];

    if (lastLine && Math.abs(lastLine.y - y) < 4) {
      lastLine.parts.push(value);
      return;
    }

    groupedLines.push({ y, parts: [value] });
  });

  return groupedLines
    .map((line) => ({
      y: line.y,
      // Match the text-layer's span concatenation so its Range indexes and
      // search result indexes are identical.
      text: line.parts.join('').replace(/\s+/g, ' ').trim()
    }))
    .filter((line) => line.text);
}

async function extractAllPdfText(pdf) {
  if (!pdf) {
    return [];
  }

  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = normalizePdfLines(textContent.items);
    const text = lines.map((line) => line.text).join(' ').replace(/\s+/g, ' ').trim();

    pages.push({ pageNumber, text, lines });
  }
  return pages;
}

function formatPdfPagesText(pages) {
  return pages
    .map(({ pageNumber, text }) => `[${pageNumber}페이지]\n${text}`)
    .join('\n\n')
    .trim();
}

function normalizeMovableMatchText(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function filterMovedSourceSearchResults(results, movableTexts) {
  const hidden = movableTexts
    .map((item) => ({
      pageNumber: Number(item.pageNumber),
      text: normalizeMovableMatchText(item.previousSourceText || item.sourceSelection?.selectedText || item.sourceText || item.originalText)
    }))
    .filter((item) => item.pageNumber > 0 && item.text);
  const consumed = new Set();
  return results.filter((result) => {
    // The overlay result represents the visible, replacement text itself.
    // Only suppress the stale source-PDF hit; filtering the overlay by the
    // source text can hide a newly applied value when the selected source
    // range also contained the searched word.
    if (result?.type === 'pdf-replacement') return true;
    const pageNumber = Number(result.pageNumber ?? result.page);
    const fullText = normalizeMovableMatchText(result.fullText || result.lineText || result.text);
    const keyword = normalizeMovableMatchText(result.keyword);
    const index = hidden.findIndex((item, hiddenIndex) => (
      !consumed.has(hiddenIndex) && item.pageNumber === pageNumber
        && item.text.includes(keyword)
        && fullText.includes(item.text)
    ));
    if (index < 0) return true;
    consumed.add(index);
    return false;
  });
}

function getReplacementSearchText(item) {
  return String(item?.displayText ?? item?.editedText ?? item?.text ?? '').trim();
}

function getReplacementSearchResults(keyword, options, movableTexts) {
  const candidates = (Array.isArray(movableTexts) ? movableTexts : [])
    // A saved overlay is not guaranteed to be exposed by PDF.js as selectable
    // text (for example, when the PDF writer emitted positioned glyph runs).
    // Keep every replacement item searchable from its visible text as well.
    .map((item) => ({ item, text: getReplacementSearchText(item) }))
    .filter(({ item, text }) => Number(item?.pageNumber) > 0 && text);

  return candidates.flatMap(({ item, text }) => {
    const lineNumber = Number(item?.lineNumber ?? item?.searchLineNumber ?? 1) || 1;
    const results = searchKeywordInDocument(
      [{ page: Number(item.pageNumber), lines: [text] }],
      keyword,
      options
    );
    return results.map((result) => ({
      ...result,
      id: `pdf-replacement-${item.id}-${result.matchIndex}`,
      type: 'pdf-replacement',
      isReplacement: true,
      replacementId: item.id,
      lineNumber,
      line: lineNumber,
      replacementRect: item.currentRect || item.displayRect || item.originalRect || null,
      lineText: text,
      fullText: text,
      text,
      originalText: result.matchedText,
      matchedText: result.matchedText
    }));
  });
}

function getVerticalBaselineOffset(item, verticalAlign = 'middle') {
  const height = Math.max(0, Number(item?.currentRect?.height) || 0);
  const fontSize = Math.max(1, Number(item?.fontSize) || 1);
  const freeSpace = Math.max(0, height - fontSize);
  const topOffset = fontSize * 0.88;
  if (verticalAlign === 'top') return topOffset;
  if (verticalAlign === 'bottom') return freeSpace + topOffset;
  return freeSpace / 2 + topOffset;
}

function TextEditFormatToolbar({ editing, onChange, onCommit, fonts = [], onFontChange, onBeforeFormat }) {
  const [fontSizeDraft, setFontSizeDraft] = useState(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  useEffect(() => setFontSizeDraft(null), [editing?.id]);
  if (!editing) return null;
  const commitFontSize = () => {
    if (fontSizeDraft === null) return;
    const value = Number(fontSizeDraft);
    if (fontSizeDraft !== '' && Number.isFinite(value)) {
      onChange?.({ fontSize: Math.max(4, Math.min(144, value)) });
    }
    setFontSizeDraft(null);
  };
  const hasRange = Number(editing.selectionRange?.end) > Number(editing.selectionRange?.start);
  const hasCaret = Number.isFinite(Number(editing.selectionRange?.start)) && !hasRange;
  const hasInlineSelection = hasRange || hasCaret;
  const activeWeight = hasInlineSelection ? (editing.selectedRangeFontWeight || 'normal') : editing.fontWeight;
  const activeStyle = hasInlineSelection ? (editing.selectedRangeFontStyle || 'normal') : editing.fontStyle;
  const activeDecoration = hasInlineSelection ? (editing.selectedRangeTextDecoration || 'none') : editing.textDecoration;
  const hasMixedFont = hasInlineSelection && editing.selectedRangeFontMixed === true;
  const mixedFontValue = '__docpilot_mixed_font__';
  const fontValue = hasMixedFont
    ? mixedFontValue
    : hasInlineSelection
      ? (editing.selectedRangeFontFamily || '')
      : (editing.fontFamily ?? '');
  const displayedFont = resolveDisplayedFont(fontValue, fonts);
  const fontValueListed = hasMixedFont || fonts.some((font) => font.candidate === displayedFont.value);
  return (
    <div
      className="pdf-text-edit-toolbar"
      role="toolbar"
      aria-label="텍스트 서식"
      onMouseDown={(event) => {
        const selection = window.getSelection();
        const editor = document.querySelector('.movable-text-edit-rich[contenteditable="true"]');
        if (editor && selection?.rangeCount && editor.contains(selection.anchorNode)
          && (selection.isCollapsed || editor.contains(selection.focusNode))) {
          const range = selection.getRangeAt(0);
          const before = range.cloneRange();
          before.selectNodeContents(editor);
          before.setEnd(range.startContainer, range.startOffset);
          const start = before.toString().length;
          onBeforeFormat?.({ start, end: start + range.toString().length });
        }
        // 서식 버튼은 편집 입력창의 포커스를 유지하되, 색상·자간 입력칸과
        // number 스피너는 브라우저 기본 입력 동작을 그대로 사용해야 한다.
        if (!event.target.closest('input, select')) event.preventDefault();
      }}
      onBlur={() => {
        window.setTimeout(() => {
          if (!document.activeElement?.closest?.('.pdf-text-edit-toolbar')) onCommitRef.current?.();
        }, 0);
      }}
    >
      <div className="text-edit-format-controls">
        <label className="text-edit-font-control" title="글꼴">
          <span>글꼴</span>
          <select
            value={displayedFont.value}
            onChange={(event) => onFontChange?.(event.target.value)}
            aria-label="글꼴"
          >
            <option value="">원본 글꼴</option>
            {hasMixedFont ? <option value={mixedFontValue} disabled>혼합된 글꼴</option> : null}
            {displayedFont.value && !fontValueListed ? <option value={displayedFont.value}>{displayedFont.label}</option> : null}
            {fonts.map((font) => <option key={font.candidate} value={font.candidate}>{font.label}</option>)}
          </select>
        </label>
        <label className="text-edit-font-size" title="글자 크기">
          <input
            type="number"
            min="4"
            max="144"
            step="0.1"
            value={fontSizeDraft ?? (hasInlineSelection
              ? (editing.selectedRangeFontSize ?? '') : (editing.fontSize ?? 10))}
            onChange={(event) => setFontSizeDraft(event.target.value)}
            onBlur={commitFontSize}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitFontSize();
              }
            }}
            aria-label="글자 크기"
          />
          <small>pt</small>
        </label>
        <button
          type="button"
          className={activeWeight === 'bold' ? 'is-active' : ''}
          onClick={() => onChange?.({ fontWeight: activeWeight === 'bold' ? 'normal' : 'bold' })}
          aria-label="굵게"
          title="굵게"
        ><strong>가</strong></button>
        <button
          type="button"
          className={activeStyle === 'italic' ? 'is-active' : ''}
          onClick={() => onChange?.({ fontStyle: activeStyle === 'italic' ? 'normal' : 'italic' })}
          aria-label="기울임"
          title="기울임"
        ><em>가</em></button>
        <button
          type="button"
          className={activeDecoration === 'underline' ? 'is-active' : ''}
          onClick={() => onChange?.({ textDecoration: activeDecoration === 'underline' ? 'none' : 'underline' })}
          aria-label="밑줄"
          title="밑줄"
        ><u>가</u></button>
        <button
          type="button"
          className={activeDecoration === 'line-through' ? 'is-active' : ''}
          onClick={() => onChange?.({ textDecoration: activeDecoration === 'line-through' ? 'none' : 'line-through' })}
          aria-label="취소선"
          title="취소선"
        ><s>가</s></button>
        <label className="text-edit-color-control" title="글자색" style={{ '--text-edit-color': editing.color || '#111111' }}>
          <span aria-hidden="true">A</span>
          <input type="color" value={editing.color || '#111111'} onChange={(event) => onChange?.({ color: event.target.value })} aria-label="글자색" />
        </label>
        <label className="text-edit-letter-spacing" title="자간">
          <span>자간</span>
          <input
            type="number"
            min="-5"
            max="20"
            step="0.1"
            value={editing.letterSpacing ?? 0}
            onChange={(event) => {
              const rawValue = event.target.value;
              if (rawValue === '') {
                onChange?.({ letterSpacing: '' });
                return;
              }
              const value = Number(rawValue);
              if (Number.isFinite(value)) {
                onChange?.({ letterSpacing: Math.max(-5, Math.min(20, value)) });
              }
            }}
            aria-label="자간"
          />
          <small>px</small>
        </label>
        <div className="text-edit-format-group" role="group" aria-label="세로 기준선">
          {[
            ['top', '↥', '위쪽 기준선'],
            ['middle', '↕', '가운데 기준선'],
            ['bottom', '↧', '아래쪽 기준선']
          ].map(([value, icon, title]) => (
            <button
              key={value}
              type="button"
              className={editing.verticalAlign === value ? 'is-active' : ''}
              onClick={() => onChange?.({ verticalAlign: value })}
              aria-label={title}
              title={title}
            >{icon}</button>
          ))}
        </div>
        <div className="text-edit-format-group" role="group" aria-label="가로 정렬">
          {[
            ['left', '왼쪽 정렬'],
            ['center', '가운데 정렬'],
            ['right', '오른쪽 정렬'],
            ['justify', '양쪽 정렬']
          ].map(([value, title]) => (
            <button
              key={value}
              type="button"
              className={`text-align-button text-align-${value} ${editing.textAlign === value ? 'is-active' : ''}`}
              onClick={() => onChange?.({ textAlign: value })}
              aria-label={title}
              title={title}
            ><TextAlignmentIcon align={value} /></button>
          ))}
        </div>
      </div>
    </div>
  );
}

function collectInstantReplacementReviewItems(viewScale = 1) {
  const scale = Number.isFinite(Number(viewScale)) && Number(viewScale) > 0 ? Number(viewScale) : 1;
  return Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]')).flatMap((pageElement) => {
    const pageNumber = Number(pageElement.dataset.pageNumber);
    const pageRect = pageElement.getBoundingClientRect();
    const sourcePageWidth = (pageElement.clientWidth || pageRect.width) / scale;
    const sourcePageHeight = (pageElement.clientHeight || pageRect.height) / scale;
    return Array.from(pageElement.querySelectorAll('.replacement-layer > div')).map((element, index) => {
      const cover = element.querySelector('.replacement-cover');
      const textElement = element.querySelector('.replacement-text');
      if (!cover || !textElement) return null;
      let source = {};
      try { source = JSON.parse(element.dataset.replacementSource || '{}'); } catch { source = {}; }
      const coverStyle = window.getComputedStyle(cover);
      const textStyle = window.getComputedStyle(textElement);
      const textRect = textElement.getBoundingClientRect();
      const originalRect = {
        x: Number.parseFloat(cover.style.left || coverStyle.left) / scale,
        y: Number.parseFloat(cover.style.top || coverStyle.top) / scale,
        width: Number.parseFloat(cover.style.width || coverStyle.width) / scale,
        height: Number.parseFloat(cover.style.height || coverStyle.height) / scale
      };
      const textX = Number.parseFloat(textElement.style.left || textStyle.left) / scale;
      const textY = Number.parseFloat(textElement.style.top || textStyle.top) / scale;
      const fontSize = Number.parseFloat(textElement.style.fontSize || textStyle.fontSize) / scale;
      const replacementText = String(textElement.textContent || '').trim();
      if (!replacementText || ![pageNumber, sourcePageWidth, sourcePageHeight, ...Object.values(originalRect), textX, textY, fontSize].every(Number.isFinite)) return null;
      const currentRect = {
        x: textX,
        y: textY,
        width: Math.max(1, textRect.width / scale),
        height: Math.max(originalRect.height, textRect.height / scale, fontSize)
      };
      return {
        id: `instant-replace-${source.id || pageNumber}-${index}-${Date.now()}`,
        type: 'movable-text',
        isReplacement: true,
        persistedToPdf: true,
        hasChanges: false,
        pageNumber,
        sourcePageWidth,
        sourcePageHeight,
        // The old word has already been removed. If this review item changes,
        // remove the newly saved word before writing the edited value.
        sourceText: replacementText,
        originalText: replacementText,
        originalUnicodeText: replacementText,
        // Retain the replaced source separately: the PDF text layer may still
        // expose it when the converter had to use a visual cover fallback.
        previousSourceText: String(source.originalText || source.sourceText || ''),
        sourceFullText: '',
        originalRect,
        currentRect,
        movedRect: currentRect,
        displayRect: currentRect,
        // The saved PDF already contains the new text. A review selection
        // must not paint a cover or a second copy over it.
        coverRects: [],
        displayText: replacementText,
        text: replacementText,
        editedText: replacementText,
        textX,
        textY,
        baseline: Number.parseFloat(textElement.dataset.baseline) / scale,
        baselineOffset: fontSize * 0.88,
        fontSize,
        fontFamily: textStyle.fontFamily,
        renderFontFamily: 'DocPilotReplacement',
        fontWeight: textStyle.fontWeight || 'normal',
        fontStyle: textStyle.fontStyle || 'normal',
        textDecoration: textStyle.textDecoration || 'none',
        letterSpacing: Number.parseFloat(textStyle.letterSpacing) || 0,
        color: textStyle.color || '#111111',
        backgroundColor: coverStyle.backgroundColor || '#ffffff',
        forceUnicodeFallback: true,
        sourceSelection: null,
        canDirectEdit: false,
        fallbackReason: '즉시 교체 후 검토·편집 가능한 선택 영역입니다.'
      };
    }).filter(Boolean);
  });
}

const PdfJsViewer = forwardRef(function PdfJsViewer({ file, highlightKeyword, selectedSearchResult, replacePreview, scale = 1, toolbarActions, onVisualConvert, isEditMode = false, onEditModeChange }, ref) {
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pageNumbers, setPageNumbers] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [appliedReplacePreview, setAppliedReplacePreview] = useState(replacePreview);
  const [visualConvertStatus, setVisualConvertStatus] = useState('idle');
  const [visualConvertMessage, setVisualConvertMessage] = useState('');
  const [downloadStatus, setDownloadStatus] = useState('idle');
  const [downloadMessage, setDownloadMessage] = useState('');
  const [downloadFailed, setDownloadFailed] = useState(false);
  const pdfDocumentRef = useRef(null);
  const pagesTextRef = useRef([]);
  const viewerRef = useRef(null);
  const pageRefs = useRef({});
  const historyRef = useRef({ snapshots: [], index: -1 });
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false, canReset: false });
  const [viewMode, setViewMode] = useState('scroll');
  const [currentPage, setCurrentPage] = useState(1);
  const [pdfPageSize, setPdfPageSize] = useState({ width: 0, height: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [textMoveMode, setTextMoveMode] = useState(false);
  const [textAddMode, setTextAddMode] = useState(false);
  const [tableAddMode, setTableAddMode] = useState(false);
  const [textReplaceMode, setTextReplaceMode] = useState(false);
  const [areaTextReplaceMode, setAreaTextReplaceMode] = useState(false);
  const [movableTexts, setMovableTexts] = useState([]);
  const [imageAttachments, setImageAttachments] = useState([]);
  const [tables, setTables] = useState([]);
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [selectedTableCell, setSelectedTableCell] = useState(null);
  const persistedTablesRef = useRef([]);
  const [batchReplaceRequest, setBatchReplaceRequest] = useState(null);
  const batchHandledPagesRef = useRef(new Map());
  const [selectedMovableTextId, setSelectedMovableTextId] = useState(null);
  const [editingMovableText, setEditingMovableText] = useState(null);
  const editingSelectionRangeRef = useRef({ id: null, range: null });
  const [availableFonts, setAvailableFonts] = useState([]);
  const [selectedImageId, setSelectedImageId] = useState(null);
  const imageInputRef = useRef(null);
  const [userHighlight, setUserHighlight] = useState({
    keyword: String(highlightKeyword || ''),
    color: 'yellow',
    matchMode: 'contains'
  });
  const [userHighlights, setUserHighlights] = useState([]);
  const effectiveScale = scale * fitScale;
  const pageOrientation = pdfPageSize.width > pdfPageSize.height ? 'landscape' : 'portrait';

  useEffect(() => {
    if (!selectedTableId) return undefined;
    const dismissTableTools = (event) => {
      if (event.target instanceof Element && event.target.closest('.pdf-table-object, .pdf-table-toolbar, .pdf-table-context-menu')) return;
      setSelectedTableId(null);
      setSelectedTableCell(null);
    };
    document.addEventListener('pointerdown', dismissTableTools);
    return () => document.removeEventListener('pointerdown', dismissTableTools);
  }, [selectedTableId]);

  useEffect(() => {
    if (!isEditMode) {
      setSelectedTableId(null);
      setSelectedTableCell(null);
    }
  }, [isEditMode]);

  useEffect(() => {
    let cancelled = false;
    if (!pdfDocument) {
      setPdfPageSize({ width: 0, height: 0 });
      setFitScale(1);
      return undefined;
    }

    pdfDocument.getPage(1).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1 });
      setPdfPageSize({ width: viewport.width, height: viewport.height });
    }).catch((error) => {
      if (!cancelled) console.warn('[PdfJsViewer] page size measurement failed:', error);
    });

    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !pdfPageSize.width) return undefined;

    const updateFitScale = () => {
      // Match the page to the usable viewer width while preserving its native
      // aspect ratio. The cap avoids making small portrait pages oversized.
      const availableWidth = Math.max(240, viewer.clientWidth - 38);
      const nextFitScale = Math.min(1.2, Math.max(0.5, availableWidth / pdfPageSize.width));
      setFitScale((current) => Math.abs(current - nextFitScale) < 0.005 ? current : nextFitScale);
    };

    updateFitScale();
    const observer = new ResizeObserver(updateFitScale);
    observer.observe(viewer);
    return () => observer.disconnect();
  }, [pdfPageSize]);

  useEffect(() => {
    setTextMoveMode(false);
    setTextAddMode(false);
    setTableAddMode(false);
    setTextReplaceMode(false);
    setAreaTextReplaceMode(Boolean(isEditMode));
    setSelectedMovableTextId(null);
    setEditingMovableText(null);
  }, [isEditMode]);

  useEffect(() => {
    window.docPilotFonts?.list?.()
      .then((fonts) => setAvailableFonts(Array.isArray(fonts) ? fonts : []))
      .catch(() => setAvailableFonts([]));
  }, []);

  const updateHistoryState = () => {
    const { snapshots, index } = historyRef.current;
    setHistoryState({ canUndo: index > 0, canRedo: index >= 0 && index < snapshots.length - 1, canReset: index > 0 });
  };

  const commitPdfChange = (highlight, replace, nextMovableTexts = movableTexts, selectedMovableTextId = null, nextImages = imageAttachments, nextSelectedImageId = selectedImageId, nextTables = tables, nextSelectedTableId = selectedTableId) => {
    const history = historyRef.current;
    const snapshot = { highlight, replace, movableTexts: nextMovableTexts, selectedMovableTextId, imageAttachments: nextImages, selectedImageId: nextSelectedImageId, tables: nextTables, selectedTableId: nextSelectedTableId };
    const current = history.snapshots[history.index];
    if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return;
    historyRef.current = history.index < 0
      ? { snapshots: [snapshot], index: 0 }
      : { snapshots: [...history.snapshots.slice(0, history.index + 1), snapshot], index: history.index + 1 };
    updateHistoryState();
  };

  const restorePdfSnapshot = (snapshot) => {
    if (!snapshot) return false;
    // A batch request is a one-time range-to-editor promotion job, not a
    // document change. Leaving it alive lets newly mounted pages (for example
    // after zooming) promote the same ranges again even after Undo/Reset.
    batchHandledPagesRef.current.clear();
    setBatchReplaceRequest(null);
    setUserHighlight(snapshot.highlight);
    setUserHighlights(Array.isArray(snapshot.highlightEntries) ? snapshot.highlightEntries : (snapshot.highlight?.keyword ? [snapshot.highlight] : []));
    setAppliedReplacePreview(snapshot.replace);
    setMovableTexts(snapshot.movableTexts || []);
    setImageAttachments(snapshot.imageAttachments || []);
    setTables(snapshot.tables || []);
    setSelectedTableId(snapshot.selectedTableId || null);
    setSelectedMovableTextId(snapshot.selectedMovableTextId || null);
    setSelectedImageId(snapshot.selectedImageId || null);
    setEditingMovableText(null);
    return true;
  };

  const undoDocumentChange = () => {
    const history = historyRef.current;
    if (history.index <= 0) return false;
    history.index -= 1;
    restorePdfSnapshot(history.snapshots[history.index]);
    updateHistoryState();
    return true;
  };

  const redoDocumentChange = () => {
    const history = historyRef.current;
    if (history.index >= history.snapshots.length - 1) return false;
    history.index += 1;
    restorePdfSnapshot(history.snapshots[history.index]);
    updateHistoryState();
    return true;
  };

  const resetAllDocumentChanges = () => {
    const history = historyRef.current;
    let reset = false;
    if (history.index > 0 || movableTexts.length || imageAttachments.length || JSON.stringify(tables) !== JSON.stringify(persistedTablesRef.current) || batchReplaceRequest) {
      history.index = 0;
      restorePdfSnapshot(history.snapshots[0] || {
        highlight: { keyword: '', color: 'yellow', matchMode: 'contains' },
        highlightEntries: [],
        replace: null,
        movableTexts: [],
        imageAttachments: [],
        tables: [],
        selectedTableId: null,
        selectedMovableTextId: null,
        selectedImageId: null
      });
      updateHistoryState();
      reset = true;
    }
    return reset;
  };

  const addMovableText = (selection) => {
    const id = `movable-text-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const value = String(selection.displayText ?? selection.text ?? '');
    // Single-selection edits can enter edit mode immediately, before the item
    // has been committed and reopened. Always initialize font runs here so
    // the first editor mount is rich-editable and reports caret/range fonts.
    const fontRuns = ensureEditableFontRuns(selection, value);
    const baseFontSize = Number(selection.autoFitBaseFontSize || selection.fontSize) || 10;
    const baseLetterSpacing = Number(selection.autoFitBaseLetterSpacing ?? selection.letterSpacing) || 0;
    const fitSettings = {
      fontSize: baseFontSize,
      baseFontSize,
      letterSpacing: baseLetterSpacing,
      baseLetterSpacing,
      fontWeight: selection.fontWeight || 'normal',
      fontStyle: selection.fontStyle || 'normal',
      fontRuns,
      fontFamily: selection.selectedFontFamily || selection.previewFontFamily || ''
    };
    const fitted = fitMovableTextToBox(value, fitSettings, selection);
    const fittedSelection = {
      ...selection,
      ...fitted,
      fontRuns,
      autoFitBaseFontSize: baseFontSize,
      autoFitBaseLetterSpacing: baseLetterSpacing,
      baselineOffset: Number.isFinite(Number(selection.baselineOffset))
        ? Number(selection.baselineOffset)
        : getVerticalBaselineOffset({ ...selection, fontSize: fitted.fontSize }, selection.verticalAlign)
    };
    setMovableTexts((current) => {
      const supersededIds = new Set(selection.supersedesIds || []);
      const next = [...current.filter((item) => !supersededIds.has(item.id)), { ...fittedSelection, id }];
      if (selection.type !== 'addedText' || value.trim()) {
        commitPdfChange(userHighlight, appliedReplacePreview, next, id);
      }
      return next;
    });
    setSelectedMovableTextId(id);
    const initial = fittedSelection.autoEdit ? {
      id,
      value,
      fontRuns,
      fontWeight: fittedSelection.fontWeight || 'normal',
      fontStyle: fittedSelection.fontStyle || 'normal',
      textDecoration: fittedSelection.textDecoration || 'none',
      letterSpacing: Number(fittedSelection.letterSpacing) || 0,
      baseLetterSpacing,
      verticalAlign: fittedSelection.verticalAlign || 'middle',
      baselineOffset: fittedSelection.baselineOffset,
      textAlign: fittedSelection.textAlign || 'left',
      fontSize: Number(fittedSelection.fontSize) || 10,
      baseFontSize,
      fontFamily: getCurrentFontCandidate(fittedSelection),
      color: fittedSelection.color || '#111111'
    } : null;
    editingSelectionRangeRef.current = { id: initial?.id || null, range: null };
    setEditingMovableText(initial);
    return id;
  };

  const addMovableTexts = (selections = []) => {
    const normalized = (Array.isArray(selections) ? selections : []).filter(Boolean);
    if (!normalized.length) return [];
    const entries = normalized.map((selection) => {
      const value = String(selection.displayText ?? selection.text ?? '');
      const fontRuns = ensureEditableFontRuns(selection, value);
      const baseFontSize = Number(selection.fontSize) || 10;
      const baseLetterSpacing = Number(selection.letterSpacing) || 0;
      const initial = {
        fontSize: baseFontSize, baseFontSize,
        letterSpacing: baseLetterSpacing, baseLetterSpacing,
        fontWeight: selection.fontWeight, fontStyle: selection.fontStyle
      };
      initial.fontRuns = fontRuns;
      const fitted = fitMovableTextToBox(value, initial, selection);
      return {
        ...selection,
        ...fitted,
        fontRuns,
        autoFitBaseFontSize: baseFontSize,
        autoFitBaseLetterSpacing: baseLetterSpacing,
        baselineOffset: Number.isFinite(Number(selection.baselineOffset))
          ? Number(selection.baselineOffset)
          : getVerticalBaselineOffset({ ...selection, fontSize: fitted.fontSize }, selection.verticalAlign),
        id: `movable-text-${Date.now()}-${Math.random().toString(36).slice(2)}`
      };
    });
    const first = entries[0];
    setMovableTexts((current) => {
      const next = [...current, ...entries];
      commitPdfChange(userHighlight, appliedReplacePreview, next, first.id);
      return next;
    });
    setSelectedMovableTextId(first.id);
    const initial = {
      id: first.id,
      value: String(first.displayText ?? first.text ?? ''),
      fontRuns: first.fontRuns || [],
      fontWeight: first.fontWeight || 'normal',
      fontStyle: first.fontStyle || 'normal',
      textDecoration: first.textDecoration || 'none',
      letterSpacing: Number(first.letterSpacing) || 0,
      baseLetterSpacing: Number(first.autoFitBaseLetterSpacing ?? first.letterSpacing) || 0,
      verticalAlign: first.verticalAlign || 'middle',
      baselineOffset: Number.isFinite(Number(first.baselineOffset))
        ? Number(first.baselineOffset) : getVerticalBaselineOffset(first, first.verticalAlign),
      textAlign: first.textAlign || 'left',
      fontSize: Number(first.fontSize) || 10,
      baseFontSize: Number(first.autoFitBaseFontSize || first.fontSize) || 10,
      fontFamily: getCurrentFontCandidate(first),
      color: first.color || '#111111'
    };
    editingSelectionRangeRef.current = { id: first.id, range: null };
    setEditingMovableText({ ...initial, ...fitMovableTextToBox(initial.value, initial, first) });
    return entries.map((entry) => entry.id);
  };

  // Preview-font resolution is visual metadata only. It must not add an undo
  // entry or modify the replacement itself; export uses fontCandidates.
  const updateMovableTextPreviewFont = (id, previewFont) => {
    if (!id || !previewFont?.fontFamily) return;
    const hasResolvedSelection = Object.prototype.hasOwnProperty.call(previewFont, 'selectionValue');
    const resolvedSelection = hasResolvedSelection ? String(previewFont.selectionValue || '') : null;
    const hasResolvedOriginalFamily = Object.prototype.hasOwnProperty.call(previewFont, 'originalFamily');
    const resolveItemPreview = (item, text = String(item.displayText ?? item.text ?? '')) => {
      const target = { ...item, renderFontFamily: previewFont.fontFamily };
      const baseFontSize = Number(item.autoFitBaseFontSize || item.fontSize) || 10;
      const baseLetterSpacing = Number(item.autoFitBaseLetterSpacing ?? item.letterSpacing) || 0;
      const settings = {
        fontSize: Number(item.fontSize) || baseFontSize,
        baseFontSize,
        letterSpacing: baseLetterSpacing,
        baseLetterSpacing,
        fontRuns: item.fontRuns || [],
        fontWeight: item.fontWeight || 'normal',
        fontStyle: item.fontStyle || 'normal',
        manualFontSize: item.manualFontSize === true,
        fontFamily: previewFont.selectionValue || item.selectedFontFamily || item.previewFontFamily || ''
      };
      const fitted = fitMovableTextToBox(text, settings, target);
      return {
        ...target,
        ...fitted,
        previewFontSource: previewFont.source || 'bundled',
        // A resolved preview font is only a rendering aid. Treating it as a
        // user-selected font makes PdfPage apply the first run's font to all
        // runs when the textbox is reopened.
        selectedFontFamily: item.selectedFontFamily || '',
        previewFontFamily: hasResolvedOriginalFamily
          ? String(previewFont.originalFamily || '') : (item.previewFontFamily || ''),
        autoFitBaseFontSize: baseFontSize,
        autoFitBaseLetterSpacing: baseLetterSpacing,
        // Keep a PDF-derived baseline fixed; otherwise recalculate it from
        // the new fitted size so the glyphs remain anchored in the source box.
        baselineOffset: item.baselineFromPdfLine && Number.isFinite(Number(item.baselineOffset))
          ? Number(item.baselineOffset)
          : getVerticalBaselineOffset({ ...target, ...fitted }, item.verticalAlign)
      };
    };
    setMovableTexts((current) => current.map((item) => (
      item.id === id ? resolveItemPreview(item) : item
    )));
    setEditingMovableText((current) => {
      if (current?.id !== id) return current;
      const target = movableTexts.find((item) => item.id === id);
      if (!target) return current;
      const previewTarget = resolveItemPreview({
        ...target,
        fontSize: current.manualFontSize ? current.fontSize : target.fontSize,
        manualFontSize: current.manualFontSize === true || target.manualFontSize === true
      });
      const baseFontSize = Number(current.baseFontSize || previewTarget.autoFitBaseFontSize) || 10;
      const baseLetterSpacing = Number(current.baseLetterSpacing ?? previewTarget.autoFitBaseLetterSpacing) || 0;
      const next = {
        ...current,
        fontFamily: hasResolvedSelection ? resolvedSelection : current.fontFamily,
        fontRunsRevision: current.fontRuns?.length > 0
          ? Number(current.fontRunsRevision || 0) + 1 : current.fontRunsRevision,
        fontSize: current.manualFontSize ? current.fontSize : baseFontSize,
        baseFontSize,
        letterSpacing: baseLetterSpacing,
        baseLetterSpacing
      };
      return {
        ...next,
        ...fitMovableTextToBox(next.value, next, previewTarget)
      };
    });
  };

  const moveMovableText = (id, currentRect) => {
    setMovableTexts((current) => current.map((item) => (
      item.id === id
        ? { ...item, currentRect, movedRect: currentRect, hasChanges: item.persistedToPdf ? true : item.hasChanges }
        : item
    )));
  };

  // Pointer movement updates the preview continuously. Add exactly one history
  // entry when the drag completes so one < press reverts one text move.
  const finishMoveMovableText = (id, currentRect) => {
    const next = movableTexts.map((item) => (
      item.id === id
        ? { ...item, currentRect, movedRect: currentRect, hasChanges: item.persistedToPdf ? true : item.hasChanges }
        : item
    ));
    setMovableTexts(next);
    commitPdfChange(userHighlight, appliedReplacePreview, next, id);
  };

  const resizeMovableText = (id, currentRect) => {
    setMovableTexts((current) => current.map((item) => (
      item.id === id ? resizeMovableTextItem(item, currentRect) : item
    )));
    setEditingMovableText((current) => {
      if (current?.id !== id) return current;
      const item = movableTexts.find((entry) => entry.id === id);
      if (!item) return current;
      return {
        ...current,
        ...fitMovableTextToBox(current.value, current, { ...item, currentRect, fitTextWidth: currentRect.width })
      };
    });
  };

  const finishResizeMovableText = (id, currentRect) => {
    setMovableTexts((current) => {
      const next = current.map((item) => (
        item.id === id ? resizeMovableTextItem(item, currentRect) : item
      ));
      commitPdfChange(userHighlight, appliedReplacePreview, next, id);
      return next;
    });
  };

  const selectMovableText = (id) => setSelectedMovableTextId(id);

  const beginEditMovableText = (id) => {
    const item = movableTexts.find((entry) => entry.id === id);
    if (!item) return;
    setSelectedMovableTextId(id);
    const baseFontSize = Number(item.autoFitBaseFontSize || item.fontSize) || 10;
    const baseLetterSpacing = Number(item.autoFitBaseLetterSpacing ?? item.letterSpacing) || 0;
    const initial = {
      id,
      value: String(item.displayText ?? item.text ?? ''),
      fontRuns: ensureEditableFontRuns(item, String(item.displayText ?? item.text ?? '')),
      manualFontSize: item.manualFontSize === true,
      fontWeight: item.fontWeight || 'normal',
      fontStyle: item.fontStyle || 'normal',
      textDecoration: item.textDecoration || 'none',
      letterSpacing: baseLetterSpacing,
      baseLetterSpacing,
      verticalAlign: item.verticalAlign || 'middle',
      baselineOffset: Number.isFinite(Number(item.baselineOffset))
        ? Number(item.baselineOffset) : getVerticalBaselineOffset(item, item.verticalAlign),
      textAlign: item.textAlign || 'left',
      fontSize: item.manualFontSize ? Number(item.fontSize) || baseFontSize : baseFontSize,
      baseFontSize,
      fontFamily: getCurrentFontCandidate({ ...item, fontRuns: ensureEditableFontRuns(item, String(item.displayText ?? item.text ?? '')) }),
      color: item.color || '#111111'
    };
    const fitted = fitMovableTextToBox(initial.value, initial, item);
    editingSelectionRangeRef.current = { id, range: null };
    setEditingMovableText({ ...initial, ...fitted });
  };

  const updateEditingMovableText = (value, fontRuns = null) => {
    setEditingMovableText((current) => {
      if (!current) return current;
      const target = movableTexts.find((item) => item.id === current.id);
      const nextFontRuns = Array.isArray(fontRuns) ? fontRuns : current.fontRuns;
      const fitted = fitMovableTextToBox(value, { ...current, fontRuns: nextFontRuns },
        current.manualFontSize ? { ...target, manualFontSize: true } : target);
      return { ...current, value, fontRuns: nextFontRuns, ...fitted };
    });
  };

  const updateEditingTextSelection = (selectionRange) => {
    if (editingMovableText?.id) editingSelectionRangeRef.current = { id: editingMovableText.id, range: selectionRange };
    setEditingMovableText((current) => {
      if (!current) return current;
      let offset = 0;
      const selectedFamilies = new Set();
      const selectedSizes = [];
      const selectedWeights = new Set();
      const selectedStyles = new Set();
      const selectedDecorations = new Set();
      const isCaret = Number(selectionRange.end) === Number(selectionRange.start);
      const caretOffset = Number(selectionRange.start);
      const totalLength = (current.fontRuns || []).reduce((length, run) => length + String(run.text || '').length, 0);
      (current.fontRuns || []).forEach((run) => {
        const start = offset;
        const end = start + String(run.text || '').length;
        const containsCaret = isCaret && (
          (caretOffset >= start && caretOffset < end)
          || (caretOffset === totalLength && end === totalLength && end > start)
        );
        const intersectsRange = !isCaret && selectionRange.end > start && selectionRange.start < end;
        if (containsCaret || intersectsRange) {
          const runFont = getCurrentFontCandidate(run) || current.fontFamily || '';
          const displayedRunFont = resolveDisplayedFont(runFont, availableFonts);
          selectedFamilies.add(displayedRunFont.value || runFont);
          selectedWeights.add(run.fontWeight === 'bold' || Number(run.fontWeight) >= 600 ? 'bold' : 'normal');
          selectedStyles.add(run.fontStyle || 'normal');
          selectedDecorations.add(run.textDecoration || 'none');
          const baseSize = Math.max(1, Number(current.baseFontSize || current.fontSize) || 10);
          selectedSizes.push((Number(run.fontSize || baseSize) * (Number(current.fontSize) || baseSize)) / baseSize);
        }
        offset = end;
      });
      const selectedRangeFontSize = selectedSizes.length
        && selectedSizes.every((size) => Math.abs(size - selectedSizes[0]) < 0.05)
        ? Number(selectedSizes[0].toFixed(2)) : '';
      return {
        ...current,
        selectionRange,
        selectedRangeFontFamily: selectedFamilies.size === 1 ? [...selectedFamilies][0] : '',
        selectedRangeFontMixed: selectedFamilies.size > 1,
        selectedRangeFontSize,
        selectedRangeFontWeight: selectedWeights.size === 1 ? [...selectedWeights][0] : '',
        selectedRangeFontStyle: selectedStyles.size === 1 ? [...selectedStyles][0] : '',
        selectedRangeTextDecoration: selectedDecorations.size === 1 ? [...selectedDecorations][0] : ''
      };
    });
  };

  const updateEditingMovableTextStyle = (style) => {
    const current = editingMovableText;
    if (!current) return;
    const selectionRange = editingSelectionRangeRef.current.id === current.id
      ? editingSelectionRangeRef.current.range : current.selectionRange;
    const target = movableTexts.find((item) => item.id === current.id);
    const hasTextRange = Number(selectionRange?.end) > Number(selectionRange?.start);
    const inlineKeys = ['fontSize', 'fontWeight', 'fontStyle', 'textDecoration', 'color'];
    const inlineStyle = Object.fromEntries(Object.entries(style).filter(([key]) => inlineKeys.includes(key)));
    if (hasTextRange && current.fontRuns?.length > 0 && Object.keys(inlineStyle).length) {
      if (inlineStyle.fontSize === '') {
        setEditingMovableText({ ...current, selectedRangeFontSize: '' });
        return;
      }
      const fontSizeScale = (Number(current.fontSize) || 10) / Math.max(1, Number(current.baseFontSize || current.fontSize) || 10);
      const nextRuns = applyInlineStyleToRunRange(
        current.fontRuns, selectionRange, inlineStyle, fontSizeScale
      );
      if (!nextRuns) return;
      const manualFontSize = current.manualFontSize === true || inlineStyle.fontSize !== undefined;
      const fitted = manualFontSize
        ? { fontSize: Number(current.fontSize) || 10, letterSpacing: Number(current.letterSpacing) || 0 }
        : fitMovableTextToBox(current.value, { ...current, fontRuns: nextRuns }, target);
      const displayedSizes = [];
      let offset = 0;
      nextRuns.forEach((run) => {
        const start = offset;
        const end = start + String(run.text || '').length;
        if (selectionRange.end > start && selectionRange.start < end) {
          displayedSizes.push(Number(run.fontSize || current.baseFontSize)
            * (Number(fitted.fontSize) || 10) / Math.max(1, Number(current.baseFontSize) || 10));
        }
        offset = end;
      });
      const selectedRangeFontSize = displayedSizes.length
        && displayedSizes.every((size) => Math.abs(size - displayedSizes[0]) < 0.05)
        ? Number(displayedSizes[0].toFixed(2)) : '';
      setMovableTexts((items) => items.map((item) => item.id === current.id
        ? {
          ...item,
          fontRuns: nextRuns,
          fontSize: fitted.fontSize,
          letterSpacing: fitted.letterSpacing,
          manualFontSize,
          hasChanges: item.persistedToPdf ? true : item.hasChanges
        }
        : item));
      setEditingMovableText({
        ...current,
        selectionRange,
        fontRuns: nextRuns,
        ...fitted,
        manualFontSize,
        selectedRangeFontSize: inlineStyle.fontSize !== undefined ? selectedRangeFontSize : current.selectedRangeFontSize,
        selectedRangeFontWeight: inlineStyle.fontWeight !== undefined ? inlineStyle.fontWeight : current.selectedRangeFontWeight,
        selectedRangeFontStyle: inlineStyle.fontStyle !== undefined ? inlineStyle.fontStyle : current.selectedRangeFontStyle,
        selectedRangeTextDecoration: inlineStyle.textDecoration !== undefined
          ? inlineStyle.textDecoration : current.selectedRangeTextDecoration,
        fontRunsRevision: Number(current.fontRunsRevision || 0) + 1
      });
      return;
    }
    const next = { ...current, ...style };
    const wholeRunStyle = Object.fromEntries(Object.entries(style).filter(([key]) => (
      ['fontWeight', 'fontStyle', 'textDecoration', 'color'].includes(key)
    )));
    if (current.fontRuns?.length > 0 && Object.keys(wholeRunStyle).length) {
      next.fontRuns = current.fontRuns.map((run) => ({ ...run, ...wholeRunStyle }));
      next.fontRunsRevision = Number(current.fontRunsRevision || 0) + 1;
    }
    if (style.fontSize !== undefined && style.fontSize !== '') {
      next.fontSize = Number(style.fontSize);
      next.manualFontSize = true;
      next.fontRunsRevision = Number(current.fontRunsRevision || 0) + 1;
    }
    if (style.letterSpacing !== undefined) next.baseLetterSpacing = Number(style.letterSpacing) || 0;
    if (style.verticalAlign && target) {
      next.baselineOffset = getVerticalBaselineOffset(target, style.verticalAlign);
    }
    const fitted = fitMovableTextToBox(next.value, next,
      next.manualFontSize ? { ...target, manualFontSize: true } : target);
    setEditingMovableText({ ...next, ...fitted });
  };

  const changeEditingMovableTextFont = async (fontFamily) => {
    if (!editingMovableText) return;
    const editingId = editingMovableText.id;
    const target = movableTexts.find((item) => item.id === editingId);
    if (!target) return;
    const selectedRange = editingSelectionRangeRef.current.id === editingId
      ? editingSelectionRangeRef.current.range : editingMovableText.selectionRange;
    if (editingMovableText.fontRuns?.length > 0
      && Number(selectedRange?.end) > Number(selectedRange?.start)) {
      const rangeId = `font-range-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const nextRuns = applyFontFamilyToRunRange(
        editingMovableText.fontRuns, selectedRange, fontFamily, rangeId
      );
      if (!nextRuns) return;
      const fitted = fitMovableTextToBox(
        editingMovableText.value,
        { ...editingMovableText, fontRuns: nextRuns },
        target
      );
      setMovableTexts((current) => current.map((item) => item.id === editingId
        ? {
          ...item,
          fontRuns: nextRuns,
          selectedFontFamily: '',
          fontSize: fitted.fontSize,
          letterSpacing: fitted.letterSpacing,
          hasChanges: item.persistedToPdf ? true : item.hasChanges
        }
        : item));
      setEditingMovableText((current) => current?.id === editingId ? {
        ...current,
        selectionRange: selectedRange,
        fontRuns: nextRuns,
        ...fitted,
        selectedRangeFontFamily: fontFamily,
        selectedRangeFontMixed: false,
        fontRunsRevision: Number(current.fontRunsRevision || 0) + 1
      } : current);
      if (fontFamily) {
        const candidates = [fontFamily];
        const preferBold = nextRuns.some((run) => run.fontRangeId === rangeId
          && (run.fontWeight === 'bold' || Number(run.fontWeight) >= 600));
        try {
          const previewFont = await resolveReplacementPreviewFont(candidates, { preferBold });
          const previewRuns = nextRuns.map((run) => run.fontRangeId === rangeId
            ? { ...run, fontFamily: previewFont.fontFamily }
            : run);
          const previewFit = fitMovableTextToBox(
            editingMovableText.value,
            { ...editingMovableText, fontRuns: previewRuns },
            target
          );
          setMovableTexts((current) => current.map((item) => item.id === editingId
            ? {
              ...item,
              fontRuns: previewRuns,
              fontSize: previewFit.fontSize,
              letterSpacing: previewFit.letterSpacing
            }
            : item));
          setEditingMovableText((current) => current?.id === editingId ? {
            ...current,
            fontRuns: previewRuns,
            ...previewFit,
            fontRunsRevision: Number(current.fontRunsRevision || 0) + 1
          } : current);
        } catch (error) {
          console.warn('[PdfJsViewer] selected range font preview unavailable:', error);
        }
      }
      return;
    }
    const fontCandidates = fontFamily
      ? [fontFamily]
      : (target.originalFontCandidates || target.fontCandidates || []);
    const preferBoldFont = fontFamily ? false : (target.originalPreferBoldFont === true || target.preferBoldFont === true);
    // Persist the selected font candidate before resolving the browser
    // preview. The input can blur/commit while FontFace loading is pending;
    // without this immediate update that commit used the old source font for
    // PDF export even though the viewer later displayed the new preview.
    setMovableTexts((current) => current.map((item) => item.id === editingId ? {
      ...item,
      selectedFontFamily: fontFamily,
      fontCandidates,
      preferBoldFont
    } : item));
    setEditingMovableText((current) => {
      if (current?.id !== editingId) return current;
      const next = {
        ...current,
        fontFamily,
        fontRunsRevision: current.fontRuns?.length > 0
          ? Number(current.fontRunsRevision || 0) + 1 : current.fontRunsRevision
      };
      return { ...next, ...fitMovableTextToBox(next.value, next, target) };
    });
    try {
      const previewFont = await resolveReplacementPreviewFont(fontCandidates, { preferBold: preferBoldFont });
      updateMovableTextPreviewFont(editingId, {
        ...previewFont,
        selectionValue: previewFont.selectionValue || fontFamily,
        originalFamily: previewFont.originalFamily || fontFamily || target.previewFontFamily || ''
      });
    } catch (error) {
      console.warn('[PdfJsViewer] selected font preview unavailable:', error);
    }
  };

  const acknowledgeBatchReplacePage = (requestId, pageNumber) => {
    const activeRequest = batchReplaceRequest;
    if (!activeRequest || activeRequest.id !== requestId) return;
    const targetPages = [...new Set((activeRequest.targets || [])
      .map((target) => Number(target.pageNumber ?? target.page))
      .filter((page) => Number.isInteger(page) && page > 0))];
    const handledPages = batchHandledPagesRef.current.get(requestId) || new Set();
    handledPages.add(Number(pageNumber));
    batchHandledPagesRef.current.set(requestId, handledPages);
    if (targetPages.length && targetPages.every((page) => handledPages.has(page))) {
      batchHandledPagesRef.current.delete(requestId);
      setBatchReplaceRequest((current) => current?.id === requestId ? null : current);
    }
  };

  const cancelEditMovableText = () => {
    if (editingMovableText?.id) {
      setMovableTexts((current) => current.filter((item) => (
        item.id !== editingMovableText.id || item.type !== 'addedText'
        || String(item.displayText ?? item.text ?? '').trim()
      )));
    }
    editingSelectionRangeRef.current = { id: null, range: null };
    setEditingMovableText(null);
  };

  const commitEditMovableText = () => {
    if (!editingMovableText) return;
    const value = String(editingMovableText.value || '').trim();
    const committedFontRuns = normalizeFontRunsForText(editingMovableText.fontRuns, value);
    const target = movableTexts.find((item) => item.id === editingMovableText.id);
    if (target?.type === 'addedText' && !value) {
      setMovableTexts((current) => {
        const next = current.filter((item) => item.id !== target.id);
        if (String(target.displayText ?? target.text ?? '').trim()) {
          commitPdfChange(userHighlight, appliedReplacePreview, next, null);
        }
        return next;
      });
      setSelectedMovableTextId(null);
      editingSelectionRangeRef.current = { id: null, range: null };
      setEditingMovableText(null);
      return;
    }
    if (!target || !value) {
      setEditingMovableText(null);
      return;
    }
    setMovableTexts((current) => {
      // Use the latest queued text state so a just-selected font candidate is
      // never overwritten by this input's blur/commit handler.
      const next = current.map((item) => item.id === editingMovableText.id
        ? {
          ...item,
          displayText: value,
          text: value,
          editedText: value,
          fontRuns: committedFontRuns.length ? committedFontRuns : (item.fontRuns || []),
          hasChanges: item.persistedToPdf ? true : item.hasChanges,
          fontWeight: editingMovableText.fontWeight || item.fontWeight || 'normal',
          fontStyle: editingMovableText.fontStyle || item.fontStyle || 'normal',
          textDecoration: editingMovableText.textDecoration || item.textDecoration || 'none',
          letterSpacing: Number(editingMovableText.letterSpacing) || 0,
          verticalAlign: editingMovableText.verticalAlign || item.verticalAlign || 'middle',
          baselineOffset: Number.isFinite(Number(editingMovableText.baselineOffset))
            ? Number(editingMovableText.baselineOffset)
            : getVerticalBaselineOffset(item, editingMovableText.verticalAlign || item.verticalAlign),
          textAlign: editingMovableText.textAlign || item.textAlign || 'left',
          fontSize: Number(editingMovableText.fontSize) || item.fontSize || 10,
          manualFontSize: editingMovableText.manualFontSize === true,
          autoFitBaseFontSize: Number(editingMovableText.baseFontSize) || item.autoFitBaseFontSize || item.fontSize || 10,
          autoFitBaseLetterSpacing: Number(editingMovableText.baseLetterSpacing) || item.autoFitBaseLetterSpacing || 0,
          // Whole-box user font changes are persisted by changeEditingMovableTextFont.
          // The editing toolbar's current run/font is only a display value and
          // must not become a global override on commit.
          selectedFontFamily: item.selectedFontFamily || '',
          color: editingMovableText.color || item.color || '#111111'
        }
        : item);
      commitPdfChange(userHighlight, appliedReplacePreview, next, editingMovableText.id);
      return next;
    });
    setSelectedMovableTextId(editingMovableText.id);
    editingSelectionRangeRef.current = { id: null, range: null };
    setEditingMovableText(null);
  };

  const deleteMovableText = (id) => {
    const next = movableTexts.filter((item) => item.id !== id);
    setMovableTexts(next);
    setSelectedMovableTextId(null);
    if (editingMovableText?.id === id) setEditingMovableText(null);
    commitPdfChange(userHighlight, appliedReplacePreview, next, null);
  };

  const getActivePageNumber = () => {
    const viewer = viewerRef.current;
    if (!viewer) return currentPage || 1;
    const middle = viewer.getBoundingClientRect().top + viewer.clientHeight / 2;
    return Number(Object.entries(pageRefs.current).sort(([, first], [, second]) => (
      Math.abs(first.getBoundingClientRect().top - middle) - Math.abs(second.getBoundingClientRect().top - middle)
    ))[0]?.[0]) || currentPage || 1;
  };

  const addImageAttachment = async (event) => {
    const fileToAdd = event.target.files?.[0];
    event.target.value = '';
    if (!fileToAdd) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(fileToAdd.type)) {
      setDownloadFailed(true);
      setDownloadMessage('PNG, JPG/JPEG 또는 WebP 이미지만 첨부할 수 있습니다.');
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'));
      reader.readAsDataURL(fileToAdd);
    });
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('이미지를 열지 못했습니다.'));
      element.src = dataUrl;
    });
    let embeddedDataUrl = dataUrl;
    let mimeType = fileToAdd.type.toLowerCase();
    // pdf-lib embeds PNG/JPEG. Convert WebP to PNG before saving.
    if (mimeType === 'image/webp') {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      embeddedDataUrl = canvas.toDataURL('image/png');
      mimeType = 'image/png';
    }
    const pageNumber = getActivePageNumber();
    const page = pageRefs.current[pageNumber];
    const pageWidth = (page?.clientWidth || 600) / effectiveScale;
    const pageHeight = (page?.clientHeight || 800) / effectiveScale;
    const aspectRatio = image.naturalWidth / Math.max(image.naturalHeight, 1);
    const initialWidth = Math.min(pageWidth * 0.5, Math.max(72, image.naturalWidth / effectiveScale));
    const height = Math.min(pageHeight * 0.5, initialWidth / aspectRatio);
    const width = height * aspectRatio;
    const id = `pdf-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const attachment = {
      id, pageNumber, dataUrl: embeddedDataUrl, mimeType,
      aspectRatio,
      currentRect: { x: Math.max(12, (pageWidth - width) / 2), y: Math.max(12, (pageHeight - height) / 2), width, height },
      sourcePageWidth: pageWidth, sourcePageHeight: pageHeight
    };
    const next = [...imageAttachments, attachment];
    setImageAttachments(next);
    setSelectedImageId(id);
    setSelectedMovableTextId(null);
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, null, next, id);
  };

  const moveImageAttachment = (id, currentRect) => setImageAttachments((items) => items.map((item) => item.id === id ? { ...item, currentRect } : item));
  const finishImageAttachmentMove = (id, currentRect) => {
    const next = imageAttachments.map((item) => item.id === id ? { ...item, currentRect } : item);
    setImageAttachments(next);
    setSelectedImageId(id);
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, next, id);
  };
  const deleteImageAttachment = (id) => {
    const next = imageAttachments.filter((item) => item.id !== id);
    setImageAttachments(next);
    setSelectedImageId(null);
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, next, null);
  };

  const addTable = (item) => {
    const width = Math.min(item.sourcePageWidth, Math.max(120, item.currentRect.width));
    const height = Math.min(item.sourcePageHeight, Math.max(66, item.currentRect.height));
    const table = {
      ...item,
      currentRect: {
        x: Math.max(0, Math.min(item.currentRect.x, item.sourcePageWidth - width)),
        y: Math.max(0, Math.min(item.currentRect.y, item.sourcePageHeight - height)),
        width, height
      },
      id: `pdf-table-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      rows: 3, columns: 3, cells: Array(9).fill(''), cellStyles: Array(9).fill(null),
      rowHeights: Array(3).fill(1 / 3), columnWidths: Array(3).fill(1 / 3), spans: [],
      fontSize: 10, borderWidth: 1, borderColor: '#000000', headerFill: '#ffffff',
      persistedToPdf: false
    };
    const next = [...tables, table];
    setTables(next);
    setSelectedTableId(null);
    setSelectedTableCell(null);
    setTableAddMode(false);
    setAreaTextReplaceMode(true);
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, imageAttachments, selectedImageId, next, null);
  };
  const updateTable = (id, changes, commit = false) => {
    const next = tables.map((table) => table.id === id ? { ...table, ...changes, hasChanges: Object.keys(changes).length ? true : table.hasChanges } : table);
    setTables(next);
    if (commit) commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, imageAttachments, selectedImageId, next, id);
  };
  const resizeTableGrid = (table, rows, columns) => {
    const nextRows = Math.max(1, Math.min(30, Number(rows) || 1));
    const nextColumns = Math.max(1, Math.min(20, Number(columns) || 1));
    const cells = Array.from({ length: nextRows * nextColumns }, (_, index) => {
      const row = Math.floor(index / nextColumns);
      const column = index % nextColumns;
      return table.cells[row * table.columns + column] || '';
    });
    const cellStyles = Array.from({ length: nextRows * nextColumns }, (_, index) => {
      const row = Math.floor(index / nextColumns);
      const column = index % nextColumns;
      return row < table.rows && column < table.columns ? table.cellStyles?.[row * table.columns + column] || null : null;
    });
    const width = Math.min(table.sourcePageWidth, Math.max(table.currentRect.width, nextColumns * 40));
    const height = Math.min(table.sourcePageHeight, Math.max(table.currentRect.height, nextRows * 22));
    const currentRect = { ...table.currentRect,
      x: Math.min(table.currentRect.x, table.sourcePageWidth - width),
      y: Math.min(table.currentRect.y, table.sourcePageHeight - height),
      width, height };
    updateTable(table.id, { rows: nextRows, columns: nextColumns, cells, cellStyles,
      rowHeights: tableSizes(table.rowHeights, table.rows).slice(0, nextRows),
      columnWidths: tableSizes(table.columnWidths, table.columns).slice(0, nextColumns),
      spans: (table.spans || []).filter((span) => span.row + span.rowSpan <= nextRows && span.column + span.colSpan <= nextColumns), currentRect }, true);
  };
  const deleteTable = (id) => {
    const next = tables.filter((table) => table.id !== id);
    setTables(next);
    setSelectedTableId(null);
    setSelectedTableCell(null);
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, imageAttachments, selectedImageId, next, null);
  };

  const rememberTableCopy = (table) => {
    const text = tableToTsv(table);
    copiedPdfTable = { table: JSON.parse(JSON.stringify(table)), text, pastes: 0 };
    return text;
  };

  const copyTable = async (id) => {
    const table = tables.find((entry) => entry.id === id);
    if (!table) return;
    const text = rememberTableCopy(table);
    try {
      if (window.docPilotClipboard?.writeText) await window.docPilotClipboard.writeText(text);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('Clipboard API unavailable');
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
  };

  const pasteCopiedTable = () => {
    if (!copiedPdfTable) return;
    const id = `pdf-table-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    copiedPdfTable.pastes += 1;
    const table = duplicateTable(copiedPdfTable.table, id, 24 * copiedPdfTable.pastes);
    table.pageNumber = pageNumbers.includes(table.pageNumber) ? table.pageNumber : currentPage;
    const next = [...tables, table];
    setTables(next);
    setSelectedTableId(id);
    setSelectedTableCell({ tableId: id, anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } });
    commitPdfChange(userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, imageAttachments, selectedImageId, next, id);
  };

  useEffect(() => {
    if (!isEditMode) return undefined;
    const onCopy = (event) => {
      const table = tables.find((entry) => entry.id === selectedTableId);
      if (!table || !event.clipboardData) return;
      const target = event.target;
      if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
        && target.selectionStart != null && target.selectionStart !== target.selectionEnd) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', rememberTableCopy(table));
    };
    const onPaste = (event) => {
      if (!copiedPdfTable || !(event.target instanceof Element)
        || (!event.target.closest('.pdf-viewer-shell') && !selectedTableId)) return;
      const text = event.clipboardData?.getData('text/plain')?.replace(/\r\n/g, '\n').replace(/\n$/, '');
      if (text !== copiedPdfTable.text) return;
      event.preventDefault();
      event.stopPropagation();
      pasteCopiedTable();
    };
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('paste', onPaste, true);
    return () => {
      document.removeEventListener('copy', onCopy, true);
      document.removeEventListener('paste', onPaste, true);
    };
  }, [isEditMode, selectedTableId, tables, currentPage, pageNumbers, userHighlight, appliedReplacePreview, movableTexts, selectedMovableTextId, imageAttachments, selectedImageId]);

  const downloadAsPdf = async () => {
    if (downloadStatus !== 'idle') return;
    setDownloadStatus('pdf-running');
    setDownloadMessage('');
    setDownloadFailed(false);
    try {
      // Review selections from an instant replacement already exist in the
      // reloaded PDF. They are UI affordances only until edited or moved.
      const pendingMovableTexts = movableTexts.filter((item) => !item.persistedToPdf || item.hasChanges);
      const highlights = Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]')).flatMap((pageElement) => {
        const pageWidth = pageElement.clientWidth || pageElement.getBoundingClientRect().width;
        const pageHeight = pageElement.clientHeight || pageElement.getBoundingClientRect().height;
        const pageNumber = Number(pageElement.dataset.pageNumber);
        return Array.from(pageElement.querySelectorAll('.highlight-box')).map((box) => ({
          pageNumber,
          sourcePageWidth: pageWidth,
          sourcePageHeight: pageHeight,
          left: Number.parseFloat(box.style.left),
          top: Number.parseFloat(box.style.top),
          width: Number.parseFloat(box.style.width),
          height: Number.parseFloat(box.style.height),
          color: window.getComputedStyle(box).backgroundColor
        }));
      });
      const tablesChanged = JSON.stringify(tables) !== JSON.stringify(persistedTablesRef.current);
      if (appliedReplacePreview?.originalText || pendingMovableTexts.length > 0 || highlights.length > 0 || imageAttachments.length > 0 || tablesChanged) {
        const result = await onVisualConvert?.({ replacement: appliedReplacePreview, movableTexts: pendingMovableTexts, highlights, images: imageAttachments, tables, tablesChanged });
        if (result?.movableTextCount) {
          console.debug('[PdfJsViewer] PDF text move save results', result.textMoveResults?.map((item) => ({
            displayText: item.displayText,
            pageNumber: item.pageNumber,
            directDeleteAttempted: item.directDeleteAttempted,
            directDeleteSucceeded: item.directDeleteSucceeded,
            deleteMode: item.deleteMode,
            fallbackUsed: item.fallbackUsed,
            fallbackReason: item.reason,
            matchedCommandCount: item.matchedCommandCount,
            commandRange: item.commandRange
          })));
          const localFontLabel = result.replacementFontSource === 'local'
            ? ` · PC 원본 계열 글꼴 적용 ${result.localFontAppliedCount || 0}건${result.replacementFontFamily ? ` (${result.replacementFontFamily})` : ''}`
            : '';
          setDownloadMessage(`PDF 저장 완료 · 원본 텍스트 제거 ${result.directEditCount}건 · 배경색 덮기 ${result.fallbackCount}건 · 직접 제거 미확인 ${result.noCoverUnresolvedCount || 0}건 · PDF 내부 원본 글꼴 재사용 ${result.fontPreservedCount}건${localFontLabel}`);
        }
        if (tablesChanged && !result?.movableTextCount) setDownloadMessage(`PDF 저장 완료 · 표 ${result?.tableCount ?? tables.length}개 반영`);
      } else {
        const url = URL.createObjectURL(file);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setDownloadStatus('idle');
    } catch (error) {
      setDownloadFailed(true);
      setDownloadStatus('idle');
      setDownloadMessage(`PDF 다운로드에 실패했습니다. ${error?.message || ''}`.trim());
    }
  };

  const clearAppliedHighlights = () => {
    const clearedHighlight = { keyword: '', color: 'yellow', matchMode: 'contains', selectedTargets: [] };
    setUserHighlight(clearedHighlight);
    setUserHighlights([]);
    commitPdfChange(clearedHighlight, appliedReplacePreview);
    setDownloadMessage('하이라이트를 제거했습니다.');
    setDownloadFailed(false);
    return true;
  };

  const hasAppliedHighlights = Array.isArray(userHighlight.selectedTargets)
    ? userHighlight.selectedTargets.length > 0
    : Boolean(userHighlight.keyword);

  console.log('[PdfJsViewer] file:', file);

  const ensurePdfTextPages = async () => {
    if (pagesTextRef.current.length > 0) {
      return pagesTextRef.current;
    }

    if (!pdfDocumentRef.current) {
      return [];
    }

    const pages = await extractAllPdfText(pdfDocumentRef.current);
    pagesTextRef.current = pages;
    return pages;
  };

  const scrollToPdfSearchResult = (result) => {
    const target = result?.raw || result || {};
    const pageNumber = Number(target.pageNumber ?? target.page);

    if (!Number.isFinite(pageNumber)) {
      console.warn('[PdfJsViewer] invalid search result target:', result);
      return false;
    }

    const pageElement = pageRefs.current[pageNumber];
    if (!pageElement) {
      console.warn('[PdfJsViewer] search target page not rendered:', pageNumber);
      return false;
    }

    const viewerElement = viewerRef.current;
    if (viewerElement) {
      const keyword = String(target.keyword ?? target.matchedText ?? target.originalText ?? '').trim();
      const targetBoxes = keyword
        ? createHighlightBoxesFromTextLayer(pageElement, keyword, {
          matchMode: 'contains',
          lineNumber: Number(target.lineNumber ?? target.line),
          matchIndex: Number(target.matchIndex),
          lineText: target.lineText ?? target.fullText ?? target.text
        })
        : [];
      const targetBox = targetBoxes[0];
      const targetY = target.y != null && Number.isFinite(Number(target.y))
        ? Number(target.y)
        : targetBox
          ? targetBox.y + targetBox.height / 2
          : pageElement.clientHeight / 4;
      const targetTop = pageElement.offsetTop + targetY - viewerElement.clientHeight / 3;
      viewerElement.scrollTo({
        top: Math.max(targetTop, 0),
        behavior: 'smooth'
      });
      return true;
    }

    pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  };

  useImperativeHandle(ref, () => ({
    async getDocumentText() {
      try {
        const pages = await ensurePdfTextPages();
        return formatPdfPagesText(pages);
      } catch (error) {
        console.warn('[PdfJsViewer] document text extraction failed:', error);
        return '';
      }
    },
    async searchDocument(keyword, options) {
      const pages = await ensurePdfTextPages();
      const documentText = pages.map((page) => ({
        page: page.pageNumber,
        lines: page.lines.map((line) => line.text)
      }));
      const sourceResults = searchKeywordInDocument(documentText, keyword, options);
      const replacementResults = getReplacementSearchResults(keyword, options, movableTexts);
      return filterMovedSourceSearchResults(
        [...sourceResults, ...replacementResults], movableTexts
      );
    },
    getPdfHighlights() {
      return Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]')).flatMap((pageElement) => {
        const pageWidth = pageElement.clientWidth || pageElement.getBoundingClientRect().width;
        const pageHeight = pageElement.clientHeight || pageElement.getBoundingClientRect().height;
        const pageNumber = Number(pageElement.dataset.pageNumber);
        return Array.from(pageElement.querySelectorAll('.highlight-box')).map((box) => ({
          pageNumber,
          sourcePageWidth: pageWidth,
          sourcePageHeight: pageHeight,
          left: Number.parseFloat(box.style.left),
          top: Number.parseFloat(box.style.top),
          width: Number.parseFloat(box.style.width),
          height: Number.parseFloat(box.style.height),
          color: window.getComputedStyle(box).backgroundColor
        }));
      });
    },
    getMovableTexts() {
      return movableTexts;
    },
    getInstantReplacementReviewItems() {
      return collectInstantReplacementReviewItems(scale);
    },
    setPersistedReplacementReviewItems(items) {
      const next = (Array.isArray(items) ? items : []).map((item) => ({
        ...item,
        persistedToPdf: true,
        hasChanges: false,
        coverRects: [],
        sourceSelection: null
      }));
      setMovableTexts((current) => [...current, ...next]);
      return next.length;
    },
    scrollToSearchResult(result) {
      return scrollToPdfSearchResult(result);
    },
    clearSearchSelection() {
      // PDF 검색은 별도의 검색 선택 DOM을 만들지 않으므로 초기화할 항목이 없습니다.
    },
    async highlightText(keyword, options = {}) {
      const normalizedKeyword = String(keyword || '').trim();
      const color = ['yellow', 'green', 'blue', 'pink'].includes(options?.color)
        ? options.color
        : 'yellow';
      const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';

      if (!normalizedKeyword) {
        setUserHighlight({ keyword: '', color, matchMode });
        return { count: 0, results: [] };
      }

      const pages = await ensurePdfTextPages();
      const documentText = pages.map((page) => ({
        page: page.pageNumber,
        lines: page.lines.map((line) => line.text)
      }));
      const allResults = searchKeywordInDocument(
        documentText,
        normalizedKeyword,
        { matchMode }
      ).map((result, index) => ({
        ...result,
        id: result.id || `pdf-highlight-${result.pageNumber}-${result.lineNumber}-${index}`,
        color
      }));
      const replacementResults = getReplacementSearchResults(
        normalizedKeyword,
        { matchMode },
        movableTexts
      );
      const allSearchResults = [...allResults, ...replacementResults];
      const selectedTargets = Array.isArray(options?.selectedTargets) ? options.selectedTargets : null;
      const results = selectedTargets
        ? allSearchResults.flatMap((result) => {
          const selectedTarget = selectedTargets.find((target) => {
            const raw = target?.raw || target || {};
            return Number(raw.pageNumber ?? raw.page) === result.pageNumber
              && Number(raw.lineNumber ?? raw.line) === result.lineNumber
              && Number(raw.matchIndex) === result.matchIndex;
          });
          if (!selectedTarget) return [];
          const targetColor = selectedTarget?.color;
          return [{
            ...result,
            color: ['yellow', 'green', 'blue', 'pink'].includes(targetColor) ? targetColor : color
          }];
        })
        : allSearchResults;

      const nextHighlight = {
        keyword: normalizedKeyword,
        color,
        matchMode,
        selectedTargets: results,
        replacementTargets: results.filter((result) => result.isReplacement)
      };
      setUserHighlight(nextHighlight);
      setUserHighlights((current) => [...current, nextHighlight]);
      commitPdfChange({ keyword: normalizedKeyword, color, matchMode, selectedTargets: results }, appliedReplacePreview);
      return { count: results.length, results };
    },
    async replaceText(originalText, newText, options = {}) {
      const pages = await ensurePdfTextPages();
      const matchMode = options.matchMode === 'exact' ? 'exact' : 'contains';
      const matches = searchKeywordInDocument(pages.map((page) => ({
        page: page.pageNumber, lines: page.lines.map((line) => line.text)
      })), originalText, { matchMode });
      const pageMatchOrdinals = new Map();
      const positionedMatches = matches.map((match) => {
        const pageNumber = Number(match.pageNumber ?? match.page);
        const pageMatchOrdinal = pageMatchOrdinals.get(pageNumber) || 0;
        pageMatchOrdinals.set(pageNumber, pageMatchOrdinal + 1);
        return { ...match, pageMatchOrdinal };
      });
      const visibleSourceMatches = filterMovedSourceSearchResults(positionedMatches, movableTexts);
      const selectedTargets = Array.isArray(options.selectedTargets) ? options.selectedTargets : null;
      const sourceResults = selectedTargets
        ? visibleSourceMatches.filter((match) => selectedTargets.some((target) => {
          const raw = target.raw || target;
          return raw.type !== 'pdf-replacement'
            && Number(raw.pageNumber ?? raw.page) === match.pageNumber
            && Number(raw.lineNumber ?? raw.line) === match.lineNumber
            && Number(raw.matchIndex) === match.matchIndex;
      }))
        : visibleSourceMatches;
      const replacementMatches = getReplacementSearchResults(originalText, { matchMode }, movableTexts);
      const replacementResults = selectedTargets
        ? replacementMatches.filter((match) => selectedTargets.some((target) => {
          const raw = target.raw || target;
          return raw.type === 'pdf-replacement'
            && raw.replacementId === match.replacementId
            && Number(raw.matchIndex) === match.matchIndex;
        }))
        : replacementMatches;

      if (replacementResults.length) {
        const replacementEdits = new Map();
        replacementResults.forEach((match) => {
          const edits = replacementEdits.get(match.replacementId) || [];
          edits.push(match);
          replacementEdits.set(match.replacementId, edits);
        });
        const next = movableTexts.map((item) => {
          const edits = replacementEdits.get(item.id);
          if (!edits?.length) return item;
          let value = getReplacementSearchText(item);
          edits.sort((a, b) => Number(b.startIndex) - Number(a.startIndex)).forEach((match) => {
            const start = Number(match.startIndex);
            // Search results expand matchedText to its whole word for display;
            // replacement itself must consume only the requested keyword.
            const end = start + String(originalText).length;
            if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= value.length) {
              value = `${value.slice(0, start)}${newText}${value.slice(end)}`;
            }
          });
          const baseFontSize = Number(item.autoFitBaseFontSize || item.fontSize) || 10;
          const baseLetterSpacing = Number(item.autoFitBaseLetterSpacing ?? item.letterSpacing) || 0;
          const fitted = fitMovableTextToBox(value, {
            fontSize: baseFontSize, baseFontSize,
            letterSpacing: baseLetterSpacing, baseLetterSpacing,
            fontWeight: item.fontWeight, fontStyle: item.fontStyle,
            fontFamily: item.selectedFontFamily || item.previewFontFamily || ''
          }, item);
          return {
            ...item,
            displayText: value,
            text: value,
            editedText: value,
            ...fitted,
            autoFitBaseFontSize: baseFontSize,
            autoFitBaseLetterSpacing: baseLetterSpacing,
            baselineOffset: Number.isFinite(Number(item.baselineOffset))
              ? Number(item.baselineOffset)
              : getVerticalBaselineOffset({ ...item, fontSize: fitted.fontSize }, item.verticalAlign),
            hasChanges: item.persistedToPdf ? true : item.hasChanges
          };
        });
        setMovableTexts(next);
        commitPdfChange(userHighlight, appliedReplacePreview, next, replacementResults[0]?.replacementId || null);
      }

      if (sourceResults.length) {
        // Resolve each hit to a browser Range in PdfPage. This reuses the
        // manual drag-selection geometry instead of the line preview path.
        setViewMode('scroll');
        setAppliedReplacePreview(null);
        const requestId = `batch-range-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        batchHandledPagesRef.current.delete(requestId);
        setBatchReplaceRequest({
          id: requestId,
          originalText,
          newText,
          targets: sourceResults
        });
        return {
          count: sourceResults.length + replacementResults.length,
          replaceCount: sourceResults.length + replacementResults.length,
          results: [...sourceResults, ...replacementResults]
        };

        const nextReplace = { originalText, newText, matchMode, selectedTargets: results };
        // Search results do not carry browser Range geometry. Render the
        // preview first, then promote its exact rectangles to the same
        // movable-text objects used by a manual "텍스트 교체" selection.
        setViewMode('scroll');
        setAppliedReplacePreview(nextReplace);
        let previewItems = [];
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          previewItems = collectInstantReplacementReviewItems(scale);
          if (previewItems.length >= results.length) break;
        }
        if (previewItems.length < results.length) {
          setAppliedReplacePreview(null);
          throw new Error(`검색된 ${results.length}건 중 ${previewItems.length}건의 교체 위치만 준비되었습니다. 문서 화면이 모두 표시된 뒤 다시 적용해주세요.`);
        }

        const batchItems = previewItems.map((item, index) => ({
          ...item,
          id: `batch-replace-${item.id}-${index}`,
          // The source text is retained only to remove/hide the old glyphs
          // on export. The object itself always displays and edits newText.
          sourceText: item.previousSourceText || originalText,
          originalText: item.previousSourceText || originalText,
          originalUnicodeText: item.previousSourceText || originalText,
          previousSourceText: item.previousSourceText || originalText,
          persistedToPdf: false,
          hasChanges: false,
          coverRects: [item.originalRect],
          allowMove: false,
          sourceSelection: null
        }));
        setAppliedReplacePreview(null);
        setMovableTexts((current) => {
          const next = [...current, ...batchItems];
          commitPdfChange(userHighlight, null, next, batchItems[0]?.id || null);
          return next;
        });
        setSelectedMovableTextId(batchItems[0]?.id || null);
        setEditingMovableText(null);
      }
      return {
        count: sourceResults.length + replacementResults.length,
        replaceCount: sourceResults.length + replacementResults.length,
        results: [...sourceResults, ...replacementResults]
      };
    },
    scrollToReplaceResult(result) {
      return scrollToPdfSearchResult(result);
    },
    clearHighlights() {
      return clearAppliedHighlights();
    },
    undoDocumentChange() {
      return undoDocumentChange();
    },
    redoDocumentChange() {
      return redoDocumentChange();
    },
    resetAllDocumentChanges() {
      return resetAllDocumentChanges();
    },
    downloadAsPdf,
    scrollToHighlightResult(result) {
      return scrollToPdfSearchResult(result);
    }
  }));

  useEffect(() => {
    setAppliedReplacePreview(replacePreview?.mode === 'review' ? null : replacePreview);
    setVisualConvertStatus('idle');
    setVisualConvertMessage('');
  }, [file, replacePreview]);

  useEffect(() => {
    if (replacePreview?.mode !== 'review' || !pdfDocument || !Array.isArray(replacePreview.items)) return;
    const reviewItems = replacePreview.items.map((item) => ({ ...item, coverRects: [] }));
    if (!reviewItems.length) return;
    setMovableTexts(reviewItems);
    setSelectedMovableTextId(reviewItems[0].id);
    setEditingMovableText(null);
    setTextMoveMode(true);
    commitPdfChange(userHighlight, null, reviewItems, reviewItems[0].id);
  }, [pdfDocument, replacePreview]);

  const handleVisualConvert = async () => {
    if ((!appliedReplacePreview?.originalText || appliedReplacePreview?.newText == null) && movableTexts.length === 0) return;

    setVisualConvertStatus('running');
    setVisualConvertMessage('');
    try {
      const result = await onVisualConvert?.({ replacement: appliedReplacePreview, movableTexts });
      setVisualConvertStatus('success');
      setVisualConvertMessage(`${result?.replaceCount ?? 0}건 변환 완료`);
    } catch (error) {
      console.error('[PdfJsViewer] visual PDF conversion failed:', error);
      setVisualConvertStatus('error');
      setVisualConvertMessage(error?.message || '변환 파일을 생성하지 못했습니다.');
    }
  };

  useEffect(() => {
    console.log('[PdfJsViewer] highlightKeyword:', highlightKeyword);
    if (highlightKeyword !== undefined && highlightKeyword !== null) {
      setUserHighlight((current) => ({
        ...current,
        keyword: String(highlightKeyword || '')
      }));
    }
  }, [highlightKeyword]);

  useEffect(() => {
    console.log('[PdfJsViewer] selectedSearchResult:', selectedSearchResult);
  }, [selectedSearchResult]);

  useEffect(() => {
    let cancelled = false;
    let activeLoadingTask = null;

    async function loadPdf() {
      pagesTextRef.current = [];
      pdfDocumentRef.current = null;
      historyRef.current = {
        snapshots: [{
          highlight: { keyword: String(highlightKeyword || ''), color: 'yellow', matchMode: 'contains' },
          replace: replacePreview?.mode === 'review' ? null : replacePreview,
          movableTexts: [],
          selectedMovableTextId: null,
          imageAttachments: [],
          selectedImageId: null
        }],
        index: 0
      };
      updateHistoryState();
      setPdfDocument(null);
      setPageNumbers([]);
      setCurrentPage(1);
      setViewMode('scroll');
      setTextMoveMode(false);
      setTextAddMode(false);
      setMovableTexts([]);
      setImageAttachments([]);
      setTables([]);
      setSelectedTableId(null);
      persistedTablesRef.current = [];
      setBatchReplaceRequest(null);
      setSelectedMovableTextId(null);
      setSelectedImageId(null);
      setEditingMovableText(null);
      setErrorMessage('');
      setDownloadMessage('');
      setDownloadFailed(false);

      if (!file || !isPdfFile(file)) {
        setPdfDocument(null);
        setPageNumbers([]);
        setErrorMessage('');
        return;
      }

      try {
        console.log('[PdfJsViewer] start render:', file?.name);
        const arrayBuffer = await file.arrayBuffer();
        if (cancelled) return;
        console.log('[PdfJsViewer] arrayBuffer size:', arrayBuffer.byteLength);
        const { loadingTask, pdf } = await loadPdfDocument(arrayBuffer, {
          onLoadingTask: (task) => { activeLoadingTask = task; }
        });
        console.log('[PdfJsViewer] pdf loaded pages:', pdf.numPages);

        if (cancelled) {
          if (typeof loadingTask.destroy === 'function') await loadingTask.destroy();
          return;
        }

        const embeddedTables = await import('../services/pdfTableService').then(({ readPdfTables }) => readPdfTables(file)).catch((error) => {
          console.warn('[PdfJsViewer] saved table metadata could not be loaded:', error);
          return [];
        });
        if (cancelled) return;
        persistedTablesRef.current = embeddedTables;
        setTables(embeddedTables);
        historyRef.current.snapshots[0] = {
          ...historyRef.current.snapshots[0], tables: embeddedTables, selectedTableId: null
        };

        pdfDocumentRef.current = pdf;
        setPdfDocument(pdf);
        setPageNumbers(Array.from({ length: pdf.numPages }, (_, index) => index + 1));
        setErrorMessage('');

        extractAllPdfText(pdf)
          .then((pages) => {
            if (!cancelled && pdfDocumentRef.current === pdf) {
              pagesTextRef.current = pages;
              console.log('[PdfJsViewer] document text cached:', {
                pages: pages.length,
                textLength: formatPdfPagesText(pages).length
              });
            }
          })
          .catch((error) => {
            console.warn('[PdfJsViewer] background text extraction failed:', error);
          });
      } catch (error) {
        if (error?.name === 'RenderingCancelledException') {
          return;
        }

        console.error('[PdfJsViewer] Failed to load PDF document', error);

        if (!cancelled) {
          pdfDocumentRef.current = null;
          pagesTextRef.current = [];
          setPdfDocument(null);
          setPageNumbers([]);
          setErrorMessage(error?.name === 'PasswordException'
            ? '암호로 보호된 PDF입니다. 암호를 해제한 파일을 다시 선택해주세요.'
            : 'PDF를 열 수 없습니다. 파일이 손상되지 않았는지 확인한 뒤 다시 선택해주세요.');
        }
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
      pdfDocumentRef.current = null;
      pagesTextRef.current = [];
      setPdfDocument(null);
      setPageNumbers([]);
      pageRefs.current = {};

      if (typeof activeLoadingTask?.destroy === 'function') {
        activeLoadingTask.destroy().catch((error) => {
          console.warn('[PdfJsViewer] PDF cleanup failed:', error);
        });
      }
    };
  }, [file]);

  useEffect(() => {
    if (!selectedSearchResult) {
      return;
    }

    const result = selectedSearchResult;
    const pageNumber = Number(result.pageNumber ?? result.page);
    const pageElement = pageRefs.current[pageNumber];

    console.log('[PdfJsViewer] target page element:', pageElement);
    console.log('[PdfJsViewer] scroll target:', {
      page: pageNumber,
      x: result.x,
      y: result.y
    });

    if (!pageElement) {
      return;
    }

    const viewerElement = viewerRef.current;

    scrollToPdfSearchResult(result);
  }, [selectedSearchResult, scale, pageNumbers]);

  if (errorMessage) {
    return <div className="pdf-loading" role="alert">{errorMessage}</div>;
  }

  if (!pdfDocument) {
    return <div className="pdf-loading">PDF 미리보기를 준비 중입니다...</div>;
  }

  return (
    <div
      className={`pdf-viewer-shell pdf-viewer-${pageOrientation}`}
      data-page-ratio={pdfPageSize.width && pdfPageSize.height ? (pdfPageSize.width / pdfPageSize.height).toFixed(4) : undefined}
    >
      <div className="pdf-view-mode-controls document-toolbar" aria-label="PDF 보기 방식">
        <div className="pdf-view-mode-toggle-group">
          {pageNumbers.length > 1 ? (
            <div className="pdf-view-mode-toggle" role="group" aria-label="보기 방식 선택">
              <button type="button" className={viewMode === 'scroll' ? 'active' : ''} onClick={() => setViewMode('scroll')} aria-pressed={viewMode === 'scroll'}>스크롤</button>
              <button type="button" className={viewMode === 'page' ? 'active' : ''} onClick={() => setViewMode('page')} aria-pressed={viewMode === 'page'}>페이지 이동</button>
            </div>
          ) : null}
          <div className="pdf-edit-mode-toggle" role="group" aria-label="문서 모드 선택">
            <button type="button" className={!isEditMode ? 'active' : ''} onClick={() => onEditModeChange?.(false)} aria-pressed={!isEditMode}>뷰어</button>
            <button type="button" className={isEditMode ? 'active' : ''} onClick={() => onEditModeChange?.(true)} aria-pressed={isEditMode}>편집</button>
          </div>
        </div>
        {pageNumbers.length > 1 && viewMode === 'page' ? (
          <div className="pdf-page-navigation" role="group" aria-label="페이지 이동">
            <button type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage === 1}>이전</button>
            <span aria-live="polite">{currentPage} / {pageNumbers.length}</span>
            <button type="button" onClick={() => setCurrentPage((page) => Math.min(pageNumbers.length, page + 1))} disabled={currentPage === pageNumbers.length}>다음</button>
          </div>
        ) : null}
        <div className="pdf-document-history" role="group" aria-label="문서 변경 이력">
          <button type="button" onClick={undoDocumentChange} disabled={!isEditMode || !historyState.canUndo} aria-label="적용 전으로 되돌리기">&lt;</button>
          <button type="button" onClick={redoDocumentChange} disabled={!isEditMode || !historyState.canRedo} aria-label="다시 적용하기">&gt;</button>
          <button type="button" className="pdf-reset-all-button" onClick={resetAllDocumentChanges} disabled={!isEditMode || (!historyState.canReset && movableTexts.length === 0 && imageAttachments.length === 0 && JSON.stringify(tables) === JSON.stringify(persistedTablesRef.current))}>전체 초기화</button>
          <button
            type="button"
            className={`pdf-text-move-button ${textMoveMode ? 'active' : ''}`}
            onClick={() => {
              if (editingMovableText) commitEditMovableText();
              const next = !textMoveMode;
              setTextMoveMode(next);
              setTextAddMode(false);
              setTableAddMode(false);
              setTextReplaceMode(false);
              setAreaTextReplaceMode(!next);
              setSelectedMovableTextId(null);
              setEditingMovableText(null);
            }}
            disabled={!isEditMode}
            aria-pressed={textMoveMode}
            title={textMoveMode ? 'PDF 텍스트 이동을 종료합니다.' : 'PDF 본문에서 한 줄의 텍스트를 선택해 이동합니다.'}
          >
            텍스트 이동
          </button>
          <button
            type="button"
            className={`pdf-text-move-button ${textAddMode ? 'active' : ''}`}
            onClick={() => {
              if (editingMovableText) commitEditMovableText();
              const next = !textAddMode;
              setTextAddMode(next);
              setTextMoveMode(false);
              setTableAddMode(false);
              setTextReplaceMode(false);
              setAreaTextReplaceMode(!next);
              setSelectedMovableTextId(null);
              setEditingMovableText(null);
            }}
            disabled={!isEditMode}
            aria-pressed={textAddMode}
            title={textAddMode ? '텍스트 추가를 종료합니다.' : 'PDF에서 영역을 지정해 새 텍스트 상자를 만듭니다.'}
          >
            텍스트 추가
          </button>
          <button
            type="button"
            className={`pdf-text-move-button ${tableAddMode ? 'active' : ''}`}
            disabled={!isEditMode}
            aria-pressed={tableAddMode}
            title="PDF에서 드래그해 표 영역을 지정합니다."
            onClick={() => {
              if (editingMovableText) commitEditMovableText();
              const next = !tableAddMode;
              setTableAddMode(next);
              setTextAddMode(false);
              setTextMoveMode(false);
              setTextReplaceMode(false);
              setAreaTextReplaceMode(!next);
              setSelectedMovableTextId(null);
              setSelectedImageId(null);
            }}
          >표 추가</button>
          <button type="button" className="pdf-text-move-button" disabled={!isEditMode} onClick={() => imageInputRef.current?.click()} title="현재 보고 있는 PDF 페이지에 이미지를 첨부합니다.">이미지 첨부</button>
          <input ref={imageInputRef} className="pdf-image-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={addImageAttachment} />
        </div>
        {toolbarActions}
        <div className="viewer-download-actions">
          {hasAppliedHighlights ? (
            <button
              type="button"
              className="viewer-highlight-clear-button"
              onClick={clearAppliedHighlights}
              disabled={downloadStatus !== 'idle'}
            >
              하이라이트 제거
            </button>
          ) : null}
          <span className="viewer-download-label">다운로드</span>
          <button
            type="button"
            className="viewer-download-button pdf"
            onClick={downloadAsPdf}
            disabled={downloadStatus !== 'idle'}
            aria-label="PDF 다운로드"
          >
            {downloadStatus === 'pdf-running' ? 'PDF 변환 중...' : 'PDF'}
          </button>
        </div>
      </div>
      {downloadMessage ? <div className={`pdf-visual-convert-message${downloadFailed ? ' is-error' : ''}`} role={downloadFailed ? 'alert' : 'status'}>{downloadMessage}</div> : null}
      {isEditMode ? <TextEditFormatToolbar
        editing={editingMovableText}
        onChange={updateEditingMovableTextStyle}
        onCommit={commitEditMovableText}
        fonts={availableFonts}
        onFontChange={changeEditingMovableTextFont}
        onBeforeFormat={updateEditingTextSelection}
      /> : null}
      {isEditMode && tables.find((table) => table.id === selectedTableId) ? (() => {
        const table = tables.find((entry) => entry.id === selectedTableId);
        return <PdfTableToolbar table={table} selection={selectedTableCell}
          onChange={(changes) => updateTable(table.id, changes, true)}
          onResizeGrid={(rows, columns) => resizeTableGrid(table, rows, columns)}
          onCopy={() => copyTable(table.id)}
          onDelete={() => deleteTable(table.id)} />;
      })() : null}
      <div ref={viewerRef} className="document-body-scroll pdf-viewer pdf-viewer-scroll">
        <div className="pdf-viewer-stack">
          {pageNumbers.map((pageNumber) => (
            <div key={`${pageNumber}-${effectiveScale}`} hidden={viewMode === 'page' && currentPage !== pageNumber}>
              <PdfPage
                pdf={pdfDocument}
                pageNumber={pageNumber}
                scale={effectiveScale}
                highlightKeyword={userHighlight.keyword}
                highlightOptions={userHighlight}
                highlightEntries={userHighlights}
                findResult={selectedSearchResult}
                replacePreview={appliedReplacePreview}
                batchReplaceRequest={batchReplaceRequest}
                onBatchReplaceHandled={acknowledgeBatchReplacePage}
                textMoveMode={textMoveMode}
                textAddMode={textAddMode}
                tableAddMode={tableAddMode}
                textReplaceMode={textReplaceMode}
                areaTextReplaceMode={isEditMode && areaTextReplaceMode}
                editingEnabled={isEditMode}
                movableTexts={movableTexts.filter((item) => item.pageNumber === pageNumber)}
                imageAttachments={imageAttachments.filter((item) => item.pageNumber === pageNumber)}
                tables={tables.filter((item) => item.pageNumber === pageNumber)}
                removedTables={persistedTablesRef.current.filter((item) => item.pageNumber === pageNumber && !tables.some((table) => table.id === item.id))}
                selectedTableId={selectedTableId}
                selectedTableCell={selectedTableCell}
                onSelectTableCell={(tableId, row, column, shiftKey) => setSelectedTableCell((previous) => ({
                  tableId, anchor: shiftKey && previous?.tableId === tableId ? previous.anchor : { row, column }, focus: { row, column }
                }))}
                onCreateTable={addTable}
                onSelectTable={setSelectedTableId}
                onUpdateTable={updateTable}
                onDeleteTable={deleteTable}
                onCopyTable={copyTable}
                selectedMovableTextId={selectedMovableTextId}
                editingMovableText={editingMovableText}
                onCreateMovableText={addMovableText}
                onCreateMovableTexts={addMovableTexts}
                onUpdateMovableTextPreviewFont={updateMovableTextPreviewFont}
                onMoveMovableText={moveMovableText}
                onMoveMovableTextEnd={finishMoveMovableText}
                onResizeMovableText={resizeMovableText}
                onResizeMovableTextEnd={finishResizeMovableText}
                onSelectMovableText={selectMovableText}
                onBeginEditMovableText={beginEditMovableText}
                onChangeEditMovableText={updateEditingMovableText}
                onChangeEditMovableTextStyle={updateEditingMovableTextStyle}
                onEditSelectionChange={updateEditingTextSelection}
                onCommitEditMovableText={commitEditMovableText}
                onCancelEditMovableText={cancelEditMovableText}
                onDeleteMovableText={deleteMovableText}
                selectedImageId={selectedImageId}
                onSelectImage={setSelectedImageId}
                onMoveImage={moveImageAttachment}
                onMoveImageEnd={finishImageAttachmentMove}
                onDeleteImage={deleteImageAttachment}
                onPageReady={(element) => {
                  if (element) pageRefs.current[pageNumber] = element;
                  else delete pageRefs.current[pageNumber];
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

export default PdfJsViewer;
