import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { convertDocxDomToPdf } from '../services/docxPdfConvertService';
import { makeDocxPageBreakPreview, makeEditedDocx, readDocxParagraphs, readDocxTables } from '../services/docxDirectEditService';
import { makeDocxFileWithHighlights } from '../services/docxHighlightService';
import TextAlignmentIcon from './TextAlignmentIcon';
import DocxTableBorderEditor from './DocxTableBorderEditor';
import { applyWordTableBorders, readWordCellBorder } from '../services/docxTableBorderModel';
import './WordViewer.css';

const SEARCH_BLOCK_SELECTOR = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre';
const SEARCH_EXCLUDED_SELECTOR = [
  '[data-docx-measure-root="true"]',
  '[data-docx-page-boundary-layer="true"]',
  '[data-docx-page-ui="true"]',
  'script',
  'style'
].join(', ');

const DOCX_HIGHLIGHT_COLORS = {
  yellow: 'rgba(255, 235, 59, 0.45)',
  green: 'rgba(34, 197, 94, 0.30)',
  blue: 'rgba(59, 130, 246, 0.30)',
  pink: 'rgba(236, 72, 153, 0.30)'
};
const DOCX_PAGE_BREAK_SELECTOR = 'hr.docx-page-break';

function cssColorToHex(value, fallback = '#ffffff') {
  const hex = String(value || '').match(/^#[\da-f]{6}$/i);
  if (hex) return hex[0].toLowerCase();
  const rgb = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return rgb ? `#${rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}` : fallback;
}

function isSearchExcluded(element) {
  return Boolean(element?.closest?.(SEARCH_EXCLUDED_SELECTOR));
}

function getSearchBlocks(root) {
  if (!root) {
    return [];
  }

  const primaryBlocks = Array.from(root.querySelectorAll(SEARCH_BLOCK_SELECTOR)).filter((element) => {
    // A table cell often contains one or more paragraph elements. Searching both
    // the cell and its paragraphs reports the same text twice, so retain only the
    // innermost meaningful block.
    return !Array.from(element.querySelectorAll(SEARCH_BLOCK_SELECTOR)).some(
      (child) => child !== element && child.textContent?.trim() && !isSearchExcluded(child)
    );
  });
  const fallbackDivs = Array.from(root.querySelectorAll('div')).filter(
    (element) => !element.querySelector(SEARCH_BLOCK_SELECTOR)
  );

  const unique = [];
  const seen = new Set();

  [...primaryBlocks, ...fallbackDivs].forEach((element) => {
    if (!element?.textContent?.trim() || isSearchExcluded(element) || seen.has(element)) {
      return;
    }
    seen.add(element);
    unique.push(element);
  });

  return unique;
}

function isWordSeparator(char) {
  return char == null || char === ' ' || char === '\n' || char === '\t';
}

function getMatchWordBounds(text, matchIndex, keywordLength) {
  let startIndex = matchIndex;
  let endIndex = matchIndex + keywordLength;

  while (startIndex > 0 && !isWordSeparator(text[startIndex - 1])) {
    startIndex -= 1;
  }
  while (endIndex < text.length && !isWordSeparator(text[endIndex])) {
    endIndex += 1;
  }

  return { startIndex, endIndex };
}

function findKeywordMatchIndexes(text, keyword, matchMode = 'contains') {
  const sourceText = String(text || '');
  const targetText = String(keyword || '');
  const source = sourceText.toLowerCase();
  const target = targetText.toLowerCase();
  const indexes = [];

  if (!target) {
    return indexes;
  }

  let startIndex = 0;
  while (startIndex <= source.length - target.length) {
    const foundIndex = source.indexOf(target, startIndex);
    if (foundIndex === -1) {
      break;
    }

    const before = foundIndex > 0 ? sourceText[foundIndex - 1] : null;
    const afterIndex = foundIndex + targetText.length;
    const after = afterIndex < sourceText.length ? sourceText[afterIndex] : null;

    if (matchMode !== 'exact' || (isWordSeparator(before) && isWordSeparator(after))) {
      indexes.push(foundIndex);
    }

    startIndex = foundIndex + Math.max(target.length, 1);
  }

  return indexes;
}

function hasKeyword(text, keyword, matchMode) {
  return findKeywordMatchIndexes(text, keyword, matchMode).length > 0;
}

function getDocxBlockMetadata(root) {
  const metadata = new Map();
  const pageParagraphCounts = new Map();

  getSearchBlocks(root).forEach((element, blockIndex) => {
    const pageNumber = getDocxPageNumber(root, element);
    const paragraphNumber = (pageParagraphCounts.get(pageNumber) || 0) + 1;
    pageParagraphCounts.set(pageNumber, paragraphNumber);
    metadata.set(element, {
      pageNumber,
      paragraphNumber,
      blockIndex: blockIndex + 1
    });
  });

  return metadata;
}

function getEstimatedDocxPageNumber(root, block) {
  if (!root || !block) {
    return 1;
  }

  const rootRect = root.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  const relativeTop = Math.max(0, blockRect.top - rootRect.top);
  const estimatedPageHeight = Math.max(900, (root.clientWidth || 794) * (1123 / 794));
  return Math.max(1, Math.floor(relativeTop / estimatedPageHeight) + 1);
}

function getDocxPageNumber(root, block) {
  const virtualPage = block?.closest?.('[data-virtual-page-number]');
  if (virtualPage) {
    return Number(virtualPage.dataset.virtualPageNumber) || 1;
  }

  const sections = Array.from(root?.querySelectorAll?.('section.docx') ?? []);
  const section = block?.closest?.('section.docx');

  if (sections.length > 1 && section) {
    const sectionIndex = sections.indexOf(section);
    return sectionIndex >= 0 ? sectionIndex + 1 : 1;
  }

  return getEstimatedDocxPageNumber(root, block);
}

function getRenderedDocxText(root) {
  if (!root) {
    return '';
  }

  const text = root.innerText || root.textContent || '';
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function unwrapHighlightSpans(root) {
  if (!root) {
    return;
  }

  Array.from(root.querySelectorAll('.docx-highlight')).forEach((span) => {
    const parent = span.parentNode;
    if (!parent) {
      return;
    }

    parent.replaceChild(document.createTextNode(span.textContent || ''), span);
    parent.normalize();
  });
}

function clearSearchSelection(root) {
  if (!root) {
    return;
  }

  root.querySelectorAll('[data-docx-search-index]').forEach((element) => {
    element.removeAttribute('data-docx-search-index');
    element.classList.remove('docx-search-current');
  });
}

function serializeModifiedHtml(root) {
  if (!root) {
    return '';
  }

  const clone = root.cloneNode(true);
  unwrapHighlightSpans(clone);
  clone.querySelectorAll('.docx-image-resize-handle').forEach((handle) => handle.remove());
  clone.querySelectorAll('.docx-added-image.is-selected').forEach((image) => image.classList.remove('is-selected'));
  clone.querySelectorAll('.docx-table-cell-selected').forEach((cell) => cell.classList.remove('docx-table-cell-selected'));
  clone.querySelectorAll('[data-docx-search-index]').forEach((element) => {
    element.removeAttribute('data-docx-search-index');
    element.classList.remove('docx-search-current');
  });
  return clone.innerHTML;
}

function splitHtmlIntoPages(html) {
  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = document.body.firstElementChild;

  if (!root) {
    return [];
  }

  const pages = [];
  let currentPage = [];

  Array.from(root.childNodes).forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE && node.matches(DOCX_PAGE_BREAK_SELECTOR)) {
      pages.push(currentPage.map((child) => child.outerHTML || child.textContent || '').join(''));
      currentPage = [];
      return;
    }

    currentPage.push(node);
  });

  pages.push(currentPage.map((child) => child.outerHTML || child.textContent || '').join(''));
  // An empty string between two DOCX page breaks represents a real blank page.
  return pages.length > 0 ? pages : [''];
}

function normalizeFidelityPageLayout(container) {
  const sections = Array.from(container?.querySelectorAll?.('section.docx') || []);

  sections.forEach((section) => {
    // docx-preview exposes the DOCX page height as min-height. Fixing the
    // actual height keeps a nearly-full page from growing beyond its pgSz.
    if (section.style.minHeight) {
      section.style.height = section.style.minHeight;
    }
  });

  sections.slice(0, -1).forEach((section) => {
    const article = Array.from(section.children).find((element) => element.tagName === 'ARTICLE');
    const lastParagraph = article?.lastElementChild;
    const hasRenderableContent = lastParagraph?.textContent?.trim() || lastParagraph?.querySelector?.(
      'img, svg, canvas, table, object, embed, iframe'
    );

    // An explicit w:br[type="page"] is already consumed when docx-preview
    // creates the next section. Its empty carrier paragraph must not consume
    // another line plus paragraph-after spacing at the bottom of this page.
    if (lastParagraph?.tagName === 'P' && !hasRenderableContent) {
      lastParagraph.classList.add('docx-page-break-placeholder');
      lastParagraph.setAttribute('aria-hidden', 'true');
    }
  });

  sections.forEach((section) => {
    const articles = Array.from(section.children).filter((element) => element.tagName === 'ARTICLE');
    const lastArticle = articles.at(-1);
    const lastContent = Array.from(lastArticle?.children || []).filter((element) => (
      !element.classList.contains('docx-page-break-placeholder')
    )).at(-1);
    if (!articles.length || !lastContent) return;

    articles.forEach((article) => {
      article.style.transform = '';
      article.style.transformOrigin = '';
    });

    const sectionRect = section.getBoundingClientRect();
    const firstArticleRect = articles[0].getBoundingClientRect();
    const lastContentRect = lastContent.getBoundingClientRect();
    const renderedScale = section.offsetHeight ? sectionRect.height / section.offsetHeight : 1;
    const paddingBottom = Number.parseFloat(window.getComputedStyle(section).paddingBottom) || 0;
    const availableBottom = sectionRect.bottom - paddingBottom * renderedScale;
    const contentHeight = lastContentRect.bottom - firstArticleRect.top;
    const availableHeight = availableBottom - firstArticleRect.top;

    if (contentHeight > availableHeight + 1 && availableHeight > 0) {
      // Browser fallback-font metrics can add a few pixels per paragraph even
      // though Word keeps all content before the explicit page break. A small
      // vertical-only correction preserves line wrapping and page membership.
      const fitScale = Math.max(0.94, Math.min(1, availableHeight / contentHeight));
      articles.forEach((article) => {
        article.style.transformOrigin = 'top left';
        article.style.transform = `scaleY(${fitScale})`;
      });
      section.dataset.docxPageFitScale = fitScale.toFixed(4);
    } else {
      delete section.dataset.docxPageFitScale;
    }
  });
}

const WordViewer = forwardRef(function WordViewer({ previewModel, file, scale = 1, toolbarActions, downloadActions }, ref) {
  const {
    html,
    pageLayout,
    renderError,
    renderMode,
    messages = []
  } = previewModel || {};
  const viewerBodyRef = useRef(null);
  const docxContentRef = useRef(null);
  const scaleContentRef = useRef(null);
  const [docxSize, setDocxSize] = useState({ width: 0, height: 0 });
  const [baseFitScale, setBaseFitScale] = useState(1);
  const [fidelityRenderFailed, setFidelityRenderFailed] = useState(false);
  const [fidelityPageCount, setFidelityPageCount] = useState(0);
  const [viewMode, setViewMode] = useState('scroll');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [pageInputError, setPageInputError] = useState('');
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false, canReset: false });
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
  const historyRef = useRef({ snapshots: [], index: -1 });
  const imageInputRef = useRef(null);
  const activeParagraphRef = useRef(null);
  const selectionRef = useRef(null);
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [hasActiveParagraph, setHasActiveParagraph] = useState(false);
  const [fontName, setFontName] = useState('Arial');
  const [availableFonts, setAvailableFonts] = useState([]);
  const [fontSize, setFontSize] = useState('12');
  const [letterSpacing, setLetterSpacing] = useState('0');
  const [selectedImageId, setSelectedImageId] = useState(null);
  const [imageWidthDraft, setImageWidthDraft] = useState('');
  const [selectedTableCell, setSelectedTableCell] = useState(null);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tablePickerSize, setTablePickerSize] = useState({ rows: 2, columns: 2 });
  const [customTableRows, setCustomTableRows] = useState('3');
  const [customTableColumns, setCustomTableColumns] = useState('3');
  const tablePickerRef = useRef(null);
  const tableDragRef = useRef(null);
  const suppressTableClickRef = useRef(false);
  const [tableFill, setTableFill] = useState('#ffffff');
  const [tableBorderBrush, setTableBorderBrush] = useState({ style: 'solid', width: 1, color: '#000000' });
  const [borderPanelOpen, setBorderPanelOpen] = useState(false);
  const [, setBorderRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    window.docPilotFonts?.list?.()
      .then((fonts) => { if (!cancelled) setAvailableFonts(Array.isArray(fonts) ? fonts : []); })
      .catch(() => { if (!cancelled) setAvailableFonts([]); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    setSelectedImageId(null);
    setImageWidthDraft('');
    setSelectedTableCell(null);
    setTablePickerOpen(false);
    setBorderPanelOpen(false);
  }, [file]);
  useEffect(() => {
    if (!tablePickerOpen) return undefined;
    const dismiss = (event) => {
      if (!tablePickerRef.current?.contains(event.target)) setTablePickerOpen(false);
    };
    const escape = (event) => { if (event.key === 'Escape') setTablePickerOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [tablePickerOpen]);
  const shouldUseFidelityRenderer = renderMode === 'original-page-layout' && Boolean(file);
  const useFidelityRenderer = shouldUseFidelityRenderer && !fidelityRenderFailed;
  const pages = html ? splitHtmlIntoPages(html) : [];
  const pageCount = useFidelityRenderer ? fidelityPageCount : pages.length;
  const hasMultiplePages = pageCount > 1;
  const pageStyle = pageLayout ? {
    '--docx-page-width': `${pageLayout.width}px`,
    '--docx-page-height': `${pageLayout.height}px`,
    '--docx-page-padding': `${pageLayout.top}px ${pageLayout.right}px ${pageLayout.bottom}px ${pageLayout.left}px`
  } : undefined;
  const actualScale = baseFitScale * scale;

  useEffect(() => {
    setFidelityRenderFailed(false);
    setFidelityPageCount(0);
  }, [file, renderMode]);

  useEffect(() => {
    if (!shouldUseFidelityRenderer || fidelityRenderFailed || !docxContentRef.current) {
      return undefined;
    }

    let cancelled = false;
    const container = docxContentRef.current;
    container.replaceChildren();

    makeDocxPageBreakPreview(file).then((previewFile) => renderAsync(previewFile, container, container, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      experimental: true,
      useBase64URL: true
    })).then(async () => {
      if (cancelled) return;
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (cancelled) return;
      normalizeFidelityPageLayout(container);
      const renderedPages = Array.from(container.querySelectorAll('section.docx'));
      renderedPages.forEach((section, index) => {
        section.dataset.docxPageNumber = String(index + 1);
        section.setAttribute('aria-label', `DOCX ${index + 1}페이지`);
      });
      setFidelityPageCount(renderedPages.length);
      markEditableParagraphs(container);
    }).catch((error) => {
      console.error('[WordViewer] original-layout DOCX render failed:', error);
      if (!cancelled) setFidelityRenderFailed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [file, shouldUseFidelityRenderer, fidelityRenderFailed]);

  const markEditableParagraphs = async (root) => {
    if (!file || !root) return;
    try {
      const [source, sourceTables] = await Promise.all([readDocxParagraphs(file), readDocxTables(file)]);
      const rendered = Array.from(root.querySelectorAll('article p, article h1, article h2, article h3, .word-document p, .word-document h1, .word-document h2, .word-document h3'));
      let cursor = 0;
      rendered.forEach((element) => {
        const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
        const match = source.findIndex((item, index) => index >= cursor && item.text === text);
        if (match < 0) return;
        element.dataset.docxParagraphIndex = String(match);
        cursor = match + 1;
      });
      const renderedTables = Array.from(root.querySelectorAll('table')).filter((table) => !table.closest('[data-docx-measure-root="true"]'));
      let tableCursor = 0;
      renderedTables.forEach((table) => {
        const text = String(table.textContent || '').replace(/\s+/g, ' ').trim();
        const compact = (value) => String(value || '').replace(/\s+/g, '');
        const match = sourceTables.findIndex((entry, index) => index >= tableCursor && compact(entry.text) === compact(text));
        const index = match >= 0 ? match : renderedTables.length === sourceTables.length && tableCursor < sourceTables.length ? tableCursor : -1;
        if (index < 0) return;
        table.dataset.docxTableIndex = String(index);
        table.dataset.docxTableId = `original-${index}`;
        tableCursor = index + 1;
      });
      const snapshot = captureDocumentSnapshot();
      historyRef.current = snapshot.length ? { snapshots: [snapshot], index: 0 } : { snapshots: [], index: -1 };
      updateHistoryState();
    } catch (error) {
      console.warn('[WordViewer] DOCX paragraph mapping failed:', error);
    }
  };

  useEffect(() => {
    if (!useFidelityRenderer && docxContentRef.current) markEditableParagraphs(docxContentRef.current);
  }, [file, html, useFidelityRenderer]);

  const captureDocumentSnapshot = () => Array.from(
    docxContentRef.current?.querySelectorAll('.word-document, section.docx') || []
  ).map((page) => {
    const clone = page.cloneNode(true);
    clone.querySelectorAll('.docx-added-image.is-selected').forEach((image) => image.classList.remove('is-selected'));
    clone.querySelectorAll('.docx-table-cell-selected').forEach((cell) => cell.classList.remove('docx-table-cell-selected'));
    return clone.innerHTML;
  });

  const updateHistoryState = () => {
    const { snapshots, index } = historyRef.current;
    setHistoryState({
      canUndo: index > 0,
      canRedo: index >= 0 && index < snapshots.length - 1,
      canReset: index > 0
    });
  };

  const ensureInitialHistorySnapshot = () => {
    if (historyRef.current.snapshots.length > 0) {
      return;
    }

    const snapshot = captureDocumentSnapshot();
    if (snapshot.length > 0) {
      historyRef.current = { snapshots: [snapshot], index: 0 };
      updateHistoryState();
    }
  };

  const commitDocumentChange = () => {
    ensureInitialHistorySnapshot();
    const snapshot = captureDocumentSnapshot();
    const { snapshots, index } = historyRef.current;
    const currentSnapshot = snapshots[index];

    if (!snapshot.length || (
      currentSnapshot?.length === snapshot.length
      && currentSnapshot.every((page, pageIndex) => page === snapshot[pageIndex])
    )) {
      return;
    }

    historyRef.current = {
      snapshots: [...snapshots.slice(0, index + 1), snapshot],
      index: index + 1
    };
    updateHistoryState();
  };

  const restoreDocumentSnapshot = (snapshot) => {
    const documentPages = Array.from(
      docxContentRef.current?.querySelectorAll('.word-document, section.docx') || []
    );
    if (!snapshot || documentPages.length !== snapshot.length) {
      return false;
    }

    documentPages.forEach((page, index) => {
      page.innerHTML = snapshot[index];
    });
    activeParagraphRef.current = null;
    selectionRef.current = null;
    setHasActiveParagraph(false);
    setSelectedImageId(null);
    setImageWidthDraft('');
    setSelectedTableCell(null);
    return true;
  };

  const undoDocumentChange = () => {
    const history = historyRef.current;
    if (history.index <= 0 || !restoreDocumentSnapshot(history.snapshots[history.index - 1])) {
      return false;
    }

    history.index -= 1;
    updateHistoryState();
    return true;
  };

  const redoDocumentChange = () => {
    const history = historyRef.current;
    if (history.index >= history.snapshots.length - 1 || !restoreDocumentSnapshot(history.snapshots[history.index + 1])) {
      return false;
    }

    history.index += 1;
    updateHistoryState();
    return true;
  };

  const resetAllDocumentChanges = () => {
    const history = historyRef.current;
    if (!history.snapshots[0] || !restoreDocumentSnapshot(history.snapshots[0])) {
      return false;
    }

    history.index = 0;
    updateHistoryState();
    return true;
  };

  useLayoutEffect(() => {
    const viewer = viewerBodyRef.current;
    const content = scaleContentRef.current;
    if (!viewer || !content) {
      return undefined;
    }

    const measure = () => {
      const documentRoot = content.querySelector('.docx-wrapper, .word-page-stack, section.docx') || content.firstElementChild;
      const width = documentRoot?.scrollWidth || content.scrollWidth;
      const height = documentRoot?.scrollHeight || content.scrollHeight;

      if (width > 0 && height > 0) {
        setDocxSize((current) => (
          current.width === width && current.height === height
            ? current
            : { width, height }
        ));
      }

      const viewerStyle = window.getComputedStyle(viewer);
      const horizontalPadding =
        Number.parseFloat(viewerStyle.paddingLeft || '0')
        + Number.parseFloat(viewerStyle.paddingRight || '0');
      const availableWidth = Math.max(0, viewer.clientWidth - horizontalPadding);
      const nextBaseFitScale = width > 0 && availableWidth > 0
        ? Math.min(1, availableWidth / width)
        : 1;

      setBaseFitScale((current) => (
        Math.abs(current - nextBaseFitScale) < 0.001 ? current : nextBaseFitScale
      ));
    };

    measure();
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(viewer);
    observer?.observe(content);
    window.addEventListener('resize', measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [html, pages.length, fidelityPageCount, useFidelityRenderer, viewMode, currentPage]);

  useLayoutEffect(() => {
    const snapshot = captureDocumentSnapshot();
    historyRef.current = snapshot.length > 0
      ? { snapshots: [snapshot], index: 0 }
      : { snapshots: [], index: -1 };
    updateHistoryState();
  }, [html, fidelityPageCount]);

  useEffect(() => {
    setCurrentPage((page) => Math.min(Math.max(page, 1), Math.max(pageCount, 1)));
  }, [pageCount]);

  useLayoutEffect(() => {
    if (!useFidelityRenderer || !docxContentRef.current) {
      return;
    }

    docxContentRef.current.querySelectorAll('section.docx').forEach((page, index) => {
      page.hidden = viewMode === 'page' && currentPage !== index + 1;
    });
  }, [currentPage, fidelityPageCount, useFidelityRenderer, viewMode]);

  useEffect(() => {
    if (!useFidelityRenderer || viewMode !== 'scroll' || fidelityPageCount < 2) return undefined;
    const scroller = viewerBodyRef.current;
    const sections = Array.from(docxContentRef.current?.querySelectorAll('section.docx') || []);
    if (!scroller || !sections.length) return undefined;
    const updateCurrentPage = () => {
      const top = scroller.getBoundingClientRect().top + 30;
      let nearestPage = 1;
      let nearestDistance = Infinity;
      sections.forEach((section, index) => {
        const distance = Math.abs(section.getBoundingClientRect().top - top);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestPage = index + 1;
        }
      });
      setCurrentPage((page) => page === nearestPage ? page : nearestPage);
    };
    updateCurrentPage();
    scroller.addEventListener('scroll', updateCurrentPage, { passive: true });
    return () => scroller.removeEventListener('scroll', updateCurrentPage);
  }, [fidelityPageCount, useFidelityRenderer, viewMode]);

  useEffect(() => {
    setPageInput(String(currentPage));
    setPageInputError('');
  }, [currentPage]);

  const handlePageInputChange = (event) => {
    const numericValue = event.target.value.replace(/\D/g, '');
    setPageInput(numericValue);
    setPageInputError('');
  };

  const handlePageInputSubmit = () => {
    const targetPage = Number(pageInput);
    if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > pageCount) {
      setPageInputError('현재 문서에 존재하지 않는 페이지입니다.');
      return;
    }

    setCurrentPage(targetPage);
  };

  const clearDocxHighlights = () => {
    unwrapHighlightSpans(docxContentRef.current);
  };

  const searchDocxText = (keyword, options = {}) => {
    const root = docxContentRef.current;
    const normalizedKeyword = String(keyword || '').trim();
    const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';

    if (!root || !normalizedKeyword) {
      return [];
    }

    clearSearchSelection(root);

    const results = [];
    const pageParagraphCounts = new Map();

    getSearchBlocks(root).forEach((element, blockIndex) => {
      const text = String(element.textContent || '').trim();
      const pageNumber = getDocxPageNumber(root, element);
      const paragraphNumber = (pageParagraphCounts.get(pageNumber) || 0) + 1;
      pageParagraphCounts.set(pageNumber, paragraphNumber);

      const matchIndexes = findKeywordMatchIndexes(text, normalizedKeyword, matchMode);
      if (matchIndexes.length === 0) {
        return;
      }

      element.dataset.docxSearchIndex = String(results.length);
      element.dataset.docxBlockIndex = String(blockIndex + 1);
      const seenWordRanges = new Set();
      matchIndexes.forEach((matchIndex, occurrenceIndex) => {
        const resultIndex = results.length;
        const { startIndex, endIndex } = getMatchWordBounds(text, matchIndex, normalizedKeyword.length);
        const rangeKey = `${startIndex}:${endIndex}`;
        if (seenWordRanges.has(rangeKey)) return;
        seenWordRanges.add(rangeKey);
        const matchedText = text.slice(startIndex, endIndex);
        results.push({
          id: `docx-${pageNumber}-${paragraphNumber}-${matchIndex}-${occurrenceIndex}`,
          type: 'docx',
          index: resultIndex,
          pageNumber,
          paragraphNumber,
          paragraphIndex: paragraphNumber,
          blockIndex: blockIndex + 1,
          text,
          lineText: text,
          originalText: matchedText,
          matchedText,
          keyword: normalizedKeyword,
          matchIndex,
          startIndex,
          endIndex,
          occurrenceIndex
        });
      });
    });

    return results;
  };

  const scrollToDocxSearchResult = (resultOrIndex) => {
    const root = docxContentRef.current;
    if (!root) {
      return false;
    }

    root.querySelectorAll('.docx-search-current').forEach((element) => {
      element.classList.remove('docx-search-current');
    });

    const target = typeof resultOrIndex === 'number' ? {} : (resultOrIndex?.raw || resultOrIndex || {});
    const resultIndex = typeof resultOrIndex === 'number'
      ? resultOrIndex
      : Number(resultOrIndex?.index ?? resultOrIndex?.raw?.index);

    if (!Number.isFinite(resultIndex)) {
      console.warn('[WordViewer] invalid search result target:', resultOrIndex);
      return false;
    }

    const element = root.querySelector(`[data-docx-search-index="${resultIndex}"]`)
      || (Number.isFinite(Number(target.blockIndex))
        ? root.querySelector(`[data-docx-block-index="${Number(target.blockIndex)}"]`)
        : null);
    if (!element) {
      console.warn('[WordViewer] search result element not found:', resultIndex);
      return false;
    }

    element.classList.add('docx-search-current');
    const targetPage = getDocxPageNumber(root, element);
    const scrollToTarget = () => element.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });

    if (viewMode === 'page' && targetPage !== currentPage) {
      setCurrentPage(targetPage);
      requestAnimationFrame(scrollToTarget);
    } else {
      scrollToTarget();
    }
    return true;
  };

  const highlightDocxText = (keyword, options = {}) => {
    const root = docxContentRef.current;
    const normalizedKeyword = String(keyword || '').trim();
    const color = ['yellow', 'green', 'blue', 'pink'].includes(options?.color)
      ? options.color
      : 'yellow';
    const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';
    const selectedTargets = Array.isArray(options?.selectedTargets) ? options.selectedTargets : null;

    if (!root || !normalizedKeyword) {
      return { count: 0, results: [] };
    }

    ensureInitialHistorySnapshot();
    if (options.append !== true) clearDocxHighlights();

    const blockMetadata = getDocxBlockMetadata(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = String(node.nodeValue || '');
        if (!text || findKeywordMatchIndexes(text, normalizedKeyword, matchMode).length === 0) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (
          !parent ||
          isSearchExcluded(parent) ||
          parent.closest('.docx-highlight')
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    const results = [];

    textNodes.forEach((node) => {
      const text = String(node.nodeValue || '');
      const matchIndexes = findKeywordMatchIndexes(text, normalizedKeyword, matchMode);
      if (matchIndexes.length === 0) {
        return;
      }

      const block = node.parentElement?.closest(SEARCH_BLOCK_SELECTOR);
      const metadata = blockMetadata.get(block) || {
        pageNumber: getDocxPageNumber(root, block || node.parentElement),
        paragraphNumber: undefined,
        blockIndex: undefined
      };

      const fullText = String(block?.textContent || text).trim();
      const fragment = document.createDocumentFragment();
      let cursor = 0;

      matchIndexes.forEach((matchIndex, occurrenceIndex) => {
        const selectedTarget = selectedTargets?.find((target) => {
          const raw = target?.raw || target || {};
          return Number(raw.blockIndex) === Number(metadata.blockIndex)
            && Number(raw.matchIndex) === matchIndex;
        });
        if (selectedTargets && !selectedTarget) return;
        const targetColor = ['yellow', 'green', 'blue', 'pink'].includes(selectedTarget?.color)
          ? selectedTarget.color
          : color;
        if (matchIndex > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, matchIndex)));
        }

        const id = `docx-highlight-${metadata.pageNumber}-${metadata.paragraphNumber || 0}-${results.length}`;
        const mark = document.createElement('span');
        mark.className = 'docx-highlight';
        mark.dataset.highlightColor = targetColor;
        mark.dataset.docxHighlightId = id;
        mark.style.backgroundColor = DOCX_HIGHLIGHT_COLORS[targetColor];
        mark.textContent = text.slice(matchIndex, matchIndex + normalizedKeyword.length);
        fragment.appendChild(mark);

        results.push({
          id,
          type: 'docx',
          index: results.length,
          pageNumber: metadata.pageNumber,
          paragraphNumber: metadata.paragraphNumber,
          blockIndex: metadata.blockIndex,
          text: fullText,
          originalText: text.slice(matchIndex, matchIndex + normalizedKeyword.length),
          matchedText: text.slice(matchIndex, matchIndex + normalizedKeyword.length),
          keyword: normalizedKeyword,
          color: targetColor,
          matchIndex,
          occurrenceIndex
        });

        cursor = matchIndex + normalizedKeyword.length;
      });

      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }

      node.parentNode?.replaceChild(fragment, node);
    });

    commitDocumentChange();
    return {
      count: results.length,
      results
    };
  };

  const scrollToDocxHighlightResult = (result) => {
    const root = docxContentRef.current;
    const target = result?.raw || result || {};
    const id = target.id;

    if (!root || !id) {
      console.warn('[WordViewer] invalid highlight result target:', result);
      return false;
    }

    root.querySelectorAll('.docx-highlight-current').forEach((element) => {
      element.classList.remove('docx-highlight-current');
    });

    const element = root.querySelector(`[data-docx-highlight-id="${id}"]`);
    if (!element) {
      console.warn('[WordViewer] highlight result element not found:', id);
      return false;
    }

    element.classList.add('docx-highlight-current');
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
    return true;
  };

  const replaceDocxText = (originalText, newText, options = {}) => {
    const root = docxContentRef.current;
    const target = String(originalText || '').trim();
    const replacement = String(newText ?? '');
    const matchMode = options?.matchMode === 'exact' ? 'exact' : 'contains';
    const selectedTargets = Array.isArray(options?.selectedTargets) ? options.selectedTargets : null;
    const selectedBlockIndexes = selectedTargets
      ? new Set(selectedTargets
        .map((selectedTarget) => Number(selectedTarget?.raw?.blockIndex ?? selectedTarget?.blockIndex))
        .filter(Number.isFinite))
      : null;

    if (!root || !target || (selectedTargets && selectedBlockIndexes.size === 0)) {
      return { count: 0, replaceCount: 0, results: [] };
    }

    ensureInitialHistorySnapshot();
    clearDocxHighlights();
    clearSearchSelection(root);

    const blockMetadata = getDocxBlockMetadata(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        const text = String(node.nodeValue || '');

        if (
          !parent ||
          isSearchExcluded(parent) ||
          findKeywordMatchIndexes(text, target, matchMode).length === 0
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    const results = [];

    textNodes.forEach((node) => {
      const before = String(node.nodeValue || '');
      const matchIndexes = findKeywordMatchIndexes(before, target, matchMode);
      if (matchIndexes.length === 0) return;

      const block = node.parentElement?.closest(SEARCH_BLOCK_SELECTOR);
      const metadata = blockMetadata.get(block) || {
        pageNumber: getDocxPageNumber(root, block || node.parentElement),
        paragraphNumber: undefined,
        blockIndex: undefined
      };
      if (selectedBlockIndexes && !selectedBlockIndexes.has(metadata.blockIndex)) {
        return;
      }
      const originalBlockText = String(block?.textContent || before).trim();

      let cursor = 0;
      let after = '';

      matchIndexes.forEach((matchIndex, occurrenceIndex) => {
        const isSelected = !selectedTargets || selectedTargets.some((selectedTarget) => {
          const raw = selectedTarget?.raw || selectedTarget;
          const selectedBlockIndex = Number(raw?.blockIndex);
          const selectedMatchIndex = Number(raw?.matchIndex);
          const selectedOccurrenceIndex = raw?.occurrenceIndex == null ? null : Number(raw.occurrenceIndex);
          return selectedBlockIndex === Number(metadata.blockIndex)
            && selectedMatchIndex === matchIndex
            && (selectedOccurrenceIndex == null || selectedOccurrenceIndex === occurrenceIndex);
        });

        if (!isSelected) {
          after += before.slice(cursor, matchIndex + target.length);
          cursor = matchIndex + target.length;
          return;
        }

        const { startIndex, endIndex } = getMatchWordBounds(before, matchIndex, target.length);
        const matchedText = before.slice(startIndex, endIndex);
        after += before.slice(cursor, matchIndex);
        after += replacement;
        results.push({
          id: `docx-replace-${metadata.pageNumber}-${metadata.paragraphNumber || 0}-${results.length}`,
          type: 'docx',
          pageNumber: metadata.pageNumber,
          paragraphNumber: metadata.paragraphNumber,
          blockIndex: metadata.blockIndex,
          originalText: matchedText,
          matchedText,
          replacedText: replacement,
          replacementText: matchedText.slice(0, matchIndex - startIndex)
            + replacement
            + matchedText.slice(matchIndex - startIndex + target.length),
          lineText: originalBlockText,
          keyword: target,
          newText: replacement,
          matchIndex,
          startIndex,
          endIndex,
          occurrenceIndex
        });
        cursor = matchIndex + target.length;
      });

      after += before.slice(cursor);
      node.nodeValue = after;
      const paragraph = node.parentElement?.closest('[data-docx-paragraph-index]');
      if (paragraph && after !== before) paragraph.dataset.docxDirty = 'true';
    });

    commitDocumentChange();
    return {
      count: results.length,
      replaceCount: results.length,
      results
    };
  };

  const rememberSelection = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !activeParagraphRef.current?.contains(selection.anchorNode)) return;
    selectionRef.current = selection.getRangeAt(0).cloneRange();
    const style = window.getComputedStyle(selection.anchorNode.nodeType === Node.TEXT_NODE
      ? selection.anchorNode.parentElement : selection.anchorNode);
    setFontName(style.fontFamily.split(',')[0].replace(/["']/g, '').trim() || 'Arial');
    setFontSize(String(Math.round(Number.parseFloat(style.fontSize) * 0.75 * 100) / 100 || 12));
    setLetterSpacing(String(Math.round((Number.parseFloat(style.letterSpacing) || 0) * 0.75 * 100) / 100));
  };

  const selectedImageParagraph = () => Array.from(docxContentRef.current?.querySelectorAll('.docx-added-image[data-docx-image-id]') || [])
    .find((element) => element.dataset.docxImageId === selectedImageId);

  useEffect(() => {
    docxContentRef.current?.querySelectorAll('.docx-added-image').forEach((element) => {
      element.classList.toggle('is-selected', editingEnabled && element.dataset.docxImageId === selectedImageId);
    });
  }, [editingEnabled, selectedImageId, html, fidelityPageCount]);

  const selectedTableElement = () => Array.from(docxContentRef.current?.querySelectorAll('table[data-docx-table-id]') || [])
    .find((element) => element.dataset.docxTableId === selectedTableCell?.tableId);
  const selectedCellElement = () => selectedTableElement()?.rows[selectedTableCell?.row]?.cells[selectedTableCell?.column];

  const selectedTableBounds = () => {
    const anchor = selectedTableCell?.anchor || selectedTableCell;
    return anchor && selectedTableCell ? {
      minRow: Math.min(anchor.row, selectedTableCell.row), maxRow: Math.max(anchor.row, selectedTableCell.row),
      minColumn: Math.min(anchor.column, selectedTableCell.column), maxColumn: Math.max(anchor.column, selectedTableCell.column)
    } : null;
  };

  useEffect(() => {
    const move = (event) => {
      const drag = tableDragRef.current;
      if (!drag) return;
      const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('td, th');
      if (!cell || cell.closest('table')?.dataset.docxTableId !== drag.tableId) return;
      const row = cell.parentElement?.rowIndex ?? -1;
      const column = cell.cellIndex;
      if (row === drag.row && column === drag.column) return;
      drag.crossed = true;
      drag.row = row;
      drag.column = column;
      window.getSelection()?.removeAllRanges();
      setSelectedTableCell({ tableId: drag.tableId, row, column, anchor: drag.anchor });
    };
    const end = () => {
      if (tableDragRef.current) {
        suppressTableClickRef.current = {
          tableId: tableDragRef.current.tableId,
          crossed: tableDragRef.current.crossed
        };
        window.setTimeout(() => { suppressTableClickRef.current = null; }, 0);
      }
      tableDragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
  }, []);

  const handleTableCellPointerDown = (event) => {
    const cell = event.target.closest?.('td, th');
    const table = cell?.closest('table[data-docx-table-id]');
    if (!editingEnabled || event.button !== 0 || !table || !docxContentRef.current?.contains(table)) return;
    const row = cell.parentElement?.rowIndex ?? -1;
    const column = cell.cellIndex;
    const anchor = event.shiftKey && selectedTableCell?.tableId === table.dataset.docxTableId
      ? selectedTableCell.anchor || { row: selectedTableCell.row, column: selectedTableCell.column }
      : { row, column };
    setSelectedTableCell({ tableId: table.dataset.docxTableId, row, column, anchor });
    tableDragRef.current = { tableId: table.dataset.docxTableId, row, column, anchor, crossed: false };
  };

  useEffect(() => {
    docxContentRef.current?.querySelectorAll('.docx-table-cell-selected').forEach((cell) => cell.classList.remove('docx-table-cell-selected'));
    const table = selectedTableElement();
    const bounds = selectedTableBounds();
    if (editingEnabled && table && bounds) Array.from(table.rows).forEach((row, rowIndex) => {
      Array.from(row.cells).forEach((cell, columnIndex) => {
        if (rowIndex >= bounds.minRow && rowIndex <= bounds.maxRow
          && columnIndex >= bounds.minColumn && columnIndex <= bounds.maxColumn) cell.classList.add('docx-table-cell-selected');
      });
    });
  }, [editingEnabled, selectedTableCell, html, fidelityPageCount]);

  const updateTableCellStyle = (change) => {
    const table = selectedTableElement();
    const bounds = selectedTableBounds();
    if (!table || !bounds) return;
    Array.from(table.rows).forEach((row, rowIndex) => Array.from(row.cells).forEach((cell, columnIndex) => {
      if (rowIndex < bounds.minRow || rowIndex > bounds.maxRow || columnIndex < bounds.minColumn || columnIndex > bounds.maxColumn) return;
      if (change.fill) cell.style.backgroundColor = change.fill;
      cell.dataset.docxCellStyleDirty = 'true';
    }));
    if (change.fill) setTableFill(change.fill);
    table.dataset.docxTableDirty = 'true';
    commitDocumentChange();
  };

  const updateTableBorders = (line) => {
    const table = selectedTableElement();
    const bounds = selectedTableBounds();
    if (!table || !bounds || !applyWordTableBorders(table, bounds, line, tableBorderBrush)) return;
    setBorderRevision((revision) => revision + 1);
    commitDocumentChange();
  };

  const editTableStructure = (type) => {
    const table = selectedTableElement();
    if (!table || !selectedTableCell) return;
    const rows = Array.from(table.rows);
    const regular = rows.length && rows.every((row) => row.cells.length === rows[0].cells.length
      && Array.from(row.cells).every((cell) => cell.rowSpan === 1 && cell.colSpan === 1 && !cell.querySelector('table')));
    if (!regular) return;
    const { row, column } = selectedTableCell;
    const blankCell = (cell) => {
      cell.innerHTML = '<p><br></p>';
      cell.dataset.docxNewCell = 'true';
      cell.removeAttribute('contenteditable');
      cell.classList.remove('docx-table-cell-selected');
    };
    let position;
    if (type === 'insertRow') {
      position = row + 1;
      const added = rows[row].cloneNode(true);
      Array.from(added.cells).forEach(blankCell);
      rows[row].after(added);
    } else if (type === 'deleteRow') {
      if (rows.length <= 1) return;
      position = row;
      rows[row].remove();
    } else if (type === 'insertColumn') {
      position = column + 1;
      rows.forEach((entry) => {
        const added = entry.cells[column].cloneNode(true);
        blankCell(added);
        entry.cells[column].after(added);
      });
    } else if (type === 'deleteColumn') {
      if (rows[0].cells.length <= 1) return;
      position = column;
      rows.forEach((entry) => entry.cells[column]?.remove());
    } else if (type === 'mergeRange') {
      const bounds = selectedTableBounds();
      if (!bounds || bounds.minRow === bounds.maxRow && bounds.minColumn === bounds.maxColumn) return;
      position = bounds.minColumn;
      const first = rows[bounds.minRow].cells[bounds.minColumn];
      const parts = [];
      for (let rowIndex = bounds.minRow; rowIndex <= bounds.maxRow; rowIndex += 1) {
        for (let columnIndex = bounds.minColumn; columnIndex <= bounds.maxColumn; columnIndex += 1) {
          const value = rows[rowIndex].cells[columnIndex]?.textContent?.trim();
          if (value) parts.push(value);
        }
      }
      first.innerHTML = '<p></p>';
      first.querySelector('p').textContent = parts.join(' ');
      first.dataset.docxNewCell = 'true';
      for (let rowIndex = bounds.minRow; rowIndex <= bounds.maxRow; rowIndex += 1) {
        for (let columnIndex = bounds.maxColumn; columnIndex >= bounds.minColumn; columnIndex -= 1) {
          if (rowIndex !== bounds.minRow || columnIndex !== bounds.minColumn) rows[rowIndex].cells[columnIndex].remove();
        }
      }
      first.colSpan = bounds.maxColumn - bounds.minColumn + 1;
      first.rowSpan = bounds.maxRow - bounds.minRow + 1;
      setSelectedTableCell({ tableId: selectedTableCell.tableId, row: bounds.minRow, column: bounds.minColumn,
        anchor: { row: bounds.minRow, column: bounds.minColumn } });
      table.dataset.docxTableDirty = 'true';
      if (table.dataset.docxAddedTable !== 'true') {
        const operations = JSON.parse(table.dataset.docxTableOperations || '[]');
        operations.push({ type, row: bounds.minRow, position: bounds.minColumn,
          endRow: bounds.maxRow, endColumn: bounds.maxColumn });
        table.dataset.docxTableOperations = JSON.stringify(operations);
      }
      commitDocumentChange();
      return;
    } else if (type === 'mergeRight') {
      if (column + 1 >= rows[row].cells.length) return;
      position = column;
      const first = rows[row].cells[column];
      const second = rows[row].cells[column + 1];
      while (second.firstChild) first.appendChild(second.firstChild);
      first.colSpan = 2;
      second.remove();
    } else return;
    if (table.dataset.docxAddedTable !== 'true') {
      const operations = JSON.parse(table.dataset.docxTableOperations || '[]');
      operations.push({ type, position, row });
      table.dataset.docxTableOperations = JSON.stringify(operations);
    }
    table.dataset.docxTableDirty = 'true';
    const nextRow = type === 'deleteRow' ? Math.min(row, table.rows.length - 1) : type === 'insertRow' ? row + 1 : row;
    const nextColumn = type === 'deleteColumn' ? Math.min(column, table.rows[nextRow].cells.length - 1) : type === 'insertColumn' ? column + 1 : column;
    setSelectedTableCell({ tableId: selectedTableCell.tableId, row: nextRow, column: nextColumn });
    commitDocumentChange();
  };

  const handleContentClick = (event) => {
    const finishedTableGesture = suppressTableClickRef.current;
    suppressTableClickRef.current = null;
    if (finishedTableGesture && (finishedTableGesture.crossed
      || event.target.closest?.('table[data-docx-table-id]')?.dataset.docxTableId !== finishedTableGesture.tableId)) return;
    const imageParagraph = event.target.closest?.('.docx-added-image[data-docx-image-id]');
    if (editingEnabled && imageParagraph && docxContentRef.current?.contains(imageParagraph)) {
      setSelectedImageId(imageParagraph.dataset.docxImageId);
      setImageWidthDraft(String(Math.round(Number.parseFloat(imageParagraph.querySelector('img')?.style.width) || 0)));
      return;
    }
    setSelectedImageId(null);
    const table = event.target.closest?.('table[data-docx-table-id]');
    if (editingEnabled && table && docxContentRef.current?.contains(table)) {
      const clickedCell = event.target.closest?.('td, th');
      const cell = clickedCell || table.rows[0]?.cells[0];
      if (!cell) return;
      const row = cell.parentElement?.rowIndex ?? Array.from(table.rows).indexOf(cell.parentElement);
      const column = cell.cellIndex;
      setSelectedTableCell((previous) => previous?.tableId === table.dataset.docxTableId
        && previous.row === row && previous.column === column ? previous
        : { tableId: table.dataset.docxTableId, row, column, anchor: { row, column } });
      setTableFill(cssColorToHex(window.getComputedStyle(cell).backgroundColor));
      const currentBorder = readWordCellBorder(cell, 'top');
      setTableBorderBrush({ style: currentBorder.style === 'none' ? 'solid' : currentBorder.style,
        width: currentBorder.width, color: cssColorToHex(currentBorder.color, '#000000') });
      if (!clickedCell) return;
      if (!event.target.closest('[data-docx-paragraph-index]')) {
        let paragraph = cell.querySelector('p');
        if (!paragraph) { paragraph = document.createElement('p'); cell.appendChild(paragraph); }
        if (activeParagraphRef.current && activeParagraphRef.current !== paragraph) {
          activeParagraphRef.current.removeAttribute('contenteditable');
          commitDocumentChange();
        }
        paragraph.setAttribute('contenteditable', 'true');
        activeParagraphRef.current = paragraph;
        setHasActiveParagraph(true);
        paragraph.focus({ preventScroll: true });
        return;
      }
      activateParagraph(event);
      return;
    }
    if (editingEnabled && event.target.closest?.('table')) return;
    setSelectedTableCell(null);
    setBorderPanelOpen(false);
    if (editingEnabled && !event.target.closest?.('p, h1, h2, h3, h4, h5, h6, table, img, header, footer, .docx-added-image')) {
      const page = event.target.closest?.('section.docx, .word-document');
      if (page && docxContentRef.current?.contains(page)) {
        const pageRect = page.getBoundingClientRect();
        const candidates = Array.from(page.querySelectorAll('[data-docx-paragraph-index], [data-docx-added-paragraph]'))
          .filter((element) => !element.closest('table, header, footer, .docx-header, .docx-footer'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom >= pageRect.top && rect.top <= pageRect.bottom;
          });
        const nearest = candidates.sort((left, right) => {
          const distance = (element) => {
            const rect = element.getBoundingClientRect();
            return Math.abs(event.clientY - Math.max(rect.top, Math.min(event.clientY, rect.bottom)));
          };
          return distance(left) - distance(right);
        })[0];
        if (nearest) activateParagraph({ target: nearest, clientX: event.clientX, clientY: event.clientY });
        else insertParagraphInBlankSpace(page);
        return;
      }
    }
    activateParagraph(event);
  };

  const handleDocumentInput = (event) => {
    if (event.target.closest('[data-docx-added-paragraph]')) return;
    const paragraph = event.target.closest('[data-docx-paragraph-index]');
    if (paragraph) { paragraph.dataset.docxDirty = 'true'; return; }
    const cell = event.target.closest('td, th');
    const table = cell?.closest('table[data-docx-table-id]');
    if (cell && table) {
      cell.dataset.docxNewCell = 'true';
      table.dataset.docxTableDirty = 'true';
    }
  };

  const applySelectedImageWidth = () => {
    const paragraph = selectedImageParagraph();
    const image = paragraph?.querySelector('img');
    if (!image) return;
    const currentWidth = Number.parseFloat(image.style.width) || image.naturalWidth || 1;
    const currentHeight = Number.parseFloat(image.style.height) || image.naturalHeight || 1;
    const width = Math.max(32, Math.min(560, Number(imageWidthDraft) || currentWidth));
    image.style.width = `${width}px`;
    image.style.height = `${Math.round(currentHeight * width / currentWidth)}px`;
    setImageWidthDraft(String(Math.round(width)));
    commitDocumentChange();
  };

  const deleteSelectedImage = () => {
    const paragraph = selectedImageParagraph();
    if (!paragraph) return;
    paragraph.remove();
    setSelectedImageId(null);
    setImageWidthDraft('');
    commitDocumentChange();
  };

  const handleImageResizePointerDown = (event) => {
    const handle = event.target.closest?.('.docx-image-resize-handle');
    if (!editingEnabled || !handle || event.button !== 0) return;
    const paragraph = handle.closest('.docx-added-image[data-docx-image-id]');
    const image = paragraph?.querySelector('img');
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = Number.parseFloat(image.style.width) || image.naturalWidth || 1;
    const startHeight = Number.parseFloat(image.style.height) || image.naturalHeight || 1;
    setSelectedImageId(paragraph.dataset.docxImageId);
    const move = (pointerEvent) => {
      const width = Math.max(32, Math.min(560, startWidth + (pointerEvent.clientX - startX) / Math.max(actualScale, 0.1)));
      image.style.width = `${Math.round(width)}px`;
      image.style.height = `${Math.round(startHeight * width / startWidth)}px`;
      setImageWidthDraft(String(Math.round(width)));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      commitDocumentChange();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  };

  const activateParagraph = (event) => {
    if (!editingEnabled) return;
    const paragraph = event.target.closest('[data-docx-paragraph-index], [data-docx-added-paragraph]');
    if (!paragraph || !docxContentRef.current?.contains(paragraph)) return;
    if (activeParagraphRef.current && activeParagraphRef.current !== paragraph) {
      activeParagraphRef.current.removeAttribute('contenteditable');
      commitDocumentChange();
    }
    paragraph.setAttribute('contenteditable', 'true');
    paragraph.spellcheck = false;
    activeParagraphRef.current = paragraph;
    setHasActiveParagraph(true);
    const clickRange = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    paragraph.focus({ preventScroll: true });
    if (clickRange && paragraph.contains(clickRange.startContainer)) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(clickRange);
    }
    requestAnimationFrame(rememberSelection);
  };

  const insertParagraphInBlankSpace = (page) => {
    const paragraphs = Array.from(page.querySelectorAll('[data-docx-paragraph-index]'))
      .filter((element) => !element.closest('table, header, footer, .docx-header, .docx-footer'));
    const lastParagraph = paragraphs.at(-1);
    const added = Array.from(page.querySelectorAll('[data-docx-added-paragraph="true"]')).at(-1);
    const paragraph = document.createElement('p');
    paragraph.className = 'docx-added-paragraph';
    paragraph.dataset.docxAddedParagraph = 'true';
    paragraph.dataset.docxInsertAfter = added?.dataset.docxInsertAfter
      ?? lastParagraph?.dataset.docxParagraphIndex ?? '-1';
    paragraph.innerHTML = '<br>';
    paragraph.setAttribute('contenteditable', 'true');
    paragraph.spellcheck = false;
    if (activeParagraphRef.current && activeParagraphRef.current !== paragraph) {
      activeParagraphRef.current.removeAttribute('contenteditable');
      commitDocumentChange();
    }
    const after = added || lastParagraph;
    if (after) after.after(paragraph);
    else page.appendChild(paragraph);
    activeParagraphRef.current = paragraph;
    setHasActiveParagraph(true);
    setSelectedTableCell(null);
    paragraph.focus({ preventScroll: true });
    commitDocumentChange();
  };

  const applyFormat = (command, value) => {
    const paragraph = activeParagraphRef.current;
    if (!paragraph) return;
    paragraph.focus();
    const selection = window.getSelection();
    if (selectionRef.current) {
      selection.removeAllRanges();
      selection.addRange(selectionRef.current);
    }
    if (command === 'fontSizePt') {
      const points = Math.max(1, Math.min(200, Number(value) || 12));
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      if (range && !range.collapsed) {
        const span = document.createElement('span');
        span.style.fontSize = `${points}pt`;
        span.appendChild(range.extractContents());
        range.insertNode(span);
        selection.selectAllChildren(span);
      } else {
        paragraph.style.fontSize = `${points}pt`;
      }
    } else if (command === 'letterSpacingPt') {
      const points = Math.max(-3, Math.min(10, Number(value) || 0));
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      if (!range || range.collapsed || !paragraph.contains(range.commonAncestorContainer)) return;
      const span = document.createElement('span');
      span.style.letterSpacing = `${points}pt`;
      span.appendChild(range.extractContents());
      range.insertNode(span);
      selection.selectAllChildren(span);
      setLetterSpacing(String(points));
    } else if (command === 'textAlign') {
      paragraph.style.textAlign = value;
    } else {
      document.execCommand(command, false, value);
    }
    paragraph.dataset.docxDirty = 'true';
    rememberSelection();
    commitDocumentChange();
  };

  const insertImage = async (imageFile) => {
    const paragraph = activeParagraphRef.current;
    if (!paragraph || !/^image\/(png|jpeg|gif)$/.test(imageFile?.type || '')) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(imageFile);
    });
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const width = Math.min(image.naturalWidth, 560);
    const height = Math.round(image.naturalHeight * width / image.naturalWidth);
    const imageParagraph = document.createElement('p');
    imageParagraph.className = 'docx-added-image';
    imageParagraph.dataset.docxInsertAfter = paragraph.dataset.docxParagraphIndex;
    imageParagraph.dataset.docxImageId = `docx-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = imageFile.name;
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
    imageParagraph.appendChild(img);
    const resizeHandle = document.createElement('span');
    resizeHandle.className = 'docx-image-resize-handle';
    resizeHandle.setAttribute('role', 'button');
    resizeHandle.setAttribute('aria-label', '이미지 크기 조절');
    imageParagraph.appendChild(resizeHandle);
    let insertAfter = paragraph;
    while (insertAfter.nextElementSibling?.dataset.docxInsertAfter === paragraph.dataset.docxParagraphIndex) {
      insertAfter = insertAfter.nextElementSibling;
    }
    insertAfter.after(imageParagraph);
    setSelectedImageId(imageParagraph.dataset.docxImageId);
    setImageWidthDraft(String(Math.round(width)));
    commitDocumentChange();
  };

  const insertTable = (requestedRows, requestedColumns) => {
    const root = docxContentRef.current;
    const active = activeParagraphRef.current;
    const page = Array.from(root?.querySelectorAll('.word-document, section.docx') || [])[currentPage - 1]
      || root?.querySelector('.word-document, section.docx');
    const selectedTable = selectedTableElement();
    const viewport = viewerBodyRef.current?.getBoundingClientRect();
    const candidates = Array.from(page?.querySelectorAll('[data-docx-paragraph-index], [data-docx-added-paragraph]') || [])
      .filter((element) => !element.closest('table, header, footer, .docx-header, .docx-footer'));
    const visible = candidates.filter((element) => {
      const rect = element.getBoundingClientRect();
      return viewport && rect.bottom >= viewport.top && rect.top <= viewport.bottom;
    });
    const paragraph = selectedTable ? null
      : (active?.dataset.docxParagraphIndex !== undefined || active?.dataset.docxAddedParagraph === 'true') && !active.closest('table')
        ? active : (visible.at(-1) || candidates.at(-1));
    if (!editingEnabled || !root) return;
    const rowCount = Math.max(1, Math.min(30, Math.floor(Number(requestedRows) || 2)));
    const columnCount = Math.max(1, Math.min(20, Math.floor(Number(requestedColumns) || 2)));
    const table = document.createElement('table');
    table.className = 'docx-added-table';
    table.dataset.docxAddedTable = 'true';
    table.dataset.docxTableId = `added-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    table.dataset.docxInsertAfter = paragraph?.dataset.docxParagraphIndex
      ?? paragraph?.dataset.docxInsertAfter ?? selectedTable?.dataset.docxInsertAfter ?? '-1';
    if (selectedTable?.dataset.docxTableIndex !== undefined || selectedTable?.dataset.docxInsertAfterTable !== undefined) {
      table.dataset.docxInsertAfterTable = selectedTable.dataset.docxTableIndex
        ?? selectedTable.dataset.docxInsertAfterTable;
    }
    table.dataset.docxTableDirty = 'true';
    const body = table.createTBody();
    for (let row = 0; row < rowCount; row += 1) {
      const tr = body.insertRow();
      for (let column = 0; column < columnCount; column += 1) {
        const cell = tr.insertCell();
        cell.dataset.docxNewCell = 'true';
        cell.style.border = '1px solid #000000';
        cell.style.backgroundColor = '#ffffff';
        cell.innerHTML = '<p><br></p>';
      }
    }
    if (paragraph || selectedTable) {
      let insertAfter = selectedTable || paragraph;
      while (insertAfter.nextElementSibling?.dataset.docxInsertAfter === table.dataset.docxInsertAfter
        && insertAfter.nextElementSibling?.dataset.docxInsertAfterTable === table.dataset.docxInsertAfterTable) {
        insertAfter = insertAfter.nextElementSibling;
      }
      insertAfter.after(table);
    } else (page || root).appendChild(table);
    setSelectedImageId(null);
    setTableFill('#ffffff');
    setTableBorderBrush({ style: 'solid', width: 1, color: '#000000' });
    setSelectedTableCell({ tableId: table.dataset.docxTableId, row: 0, column: 0, anchor: { row: 0, column: 0 } });
    setTablePickerOpen(false);
    table.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    commitDocumentChange();
  };

  const downloadEditedDocx = async () => {
    const root = docxContentRef.current;
    const edits = Array.from(root?.querySelectorAll('[data-docx-paragraph-index][data-docx-dirty="true"]') || [])
      .map((element) => ({ index: Number(element.dataset.docxParagraphIndex), element }));
    const images = Array.from(root?.querySelectorAll('.docx-added-image[data-docx-insert-after]') || [])
      .map((element) => ({
        afterIndex: Number(element.dataset.docxInsertAfter),
        dataUrl: element.querySelector('img')?.src,
        width: Number.parseFloat(element.querySelector('img')?.style.width) || 400,
        height: Number.parseFloat(element.querySelector('img')?.style.height) || 300
      }));
    const tables = Array.from(root?.querySelectorAll('table[data-docx-table-index][data-docx-table-dirty="true"]') || [])
      .map((element) => ({ index: Number(element.dataset.docxTableIndex), element,
        operations: JSON.parse(element.dataset.docxTableOperations || '[]') }));
    const addedBlocks = Array.from(root?.querySelectorAll('[data-docx-added-paragraph="true"], table[data-docx-added-table="true"]') || [])
      .map((element) => ({ afterIndex: Number(element.dataset.docxInsertAfter),
        afterTableIndex: element.dataset.docxInsertAfterTable === undefined ? null : Number(element.dataset.docxInsertAfterTable),
        kind: element.dataset.docxAddedTable === 'true' ? 'table' : 'paragraph', element }));
    if (!edits.length && !images.length && !tables.length && !addedBlocks.length) return false;
    let blob = await makeEditedDocx(file, edits, images, tables, addedBlocks);
    const highlights = Array.from(root.querySelectorAll('.docx-highlight')).map((element) => ({ text: element.textContent || '', color: element.dataset.highlightColor || 'yellow' }));
    if (highlights.length) blob = await makeDocxFileWithHighlights(blob, highlights);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${file.name.replace(/\.docx$/i, '')}_edited.docx`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  };

  useImperativeHandle(ref, () => ({
    async getDocumentText() {
      try {
        return getRenderedDocxText(docxContentRef.current);
      } catch (error) {
        console.warn('[WordViewer] document text extraction failed:', error);
        return '';
      }
    },
    searchDocument(keyword, options) {
      return searchDocxText(keyword, options);
    },
    scrollToSearchResult(resultOrIndex) {
      return scrollToDocxSearchResult(resultOrIndex);
    },
    clearSearchSelection() {
      clearSearchSelection(docxContentRef.current);
    },
    highlightText(keyword, options) {
      return highlightDocxText(keyword, options);
    },
    scrollToHighlightResult(result) {
      return scrollToDocxHighlightResult(result);
    },
    clearHighlightSelection() {
      docxContentRef.current?.querySelectorAll('.docx-highlight-current').forEach((element) => {
        element.classList.remove('docx-highlight-current');
      });
    },
    replaceText(originalText, newText, options) {
      return replaceDocxText(originalText, newText, options);
    },
    scrollToReplaceResult(result) {
      const target = result?.raw || result || {};
      const blockIndex = Number(target.blockIndex);
      const blocks = getSearchBlocks(docxContentRef.current);
      const element = Number.isFinite(blockIndex) ? blocks[blockIndex - 1] : null;
      if (!element) {
        console.warn('[WordViewer] replacement result target not found:', target);
        return false;
      }
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    },
    clearHighlights() {
      ensureInitialHistorySnapshot();
      clearDocxHighlights();
      commitDocumentChange();
      return true;
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
    getModifiedHtml() {
      return serializeModifiedHtml(docxContentRef.current);
    },
    getDocxHighlights() {
      return Array.from(docxContentRef.current?.querySelectorAll('.docx-highlight') || []).map((element) => ({
        text: element.textContent || '',
        color: element.dataset.highlightColor || 'yellow'
      }));
    },
    downloadEditedDocx,
    async downloadAsPdf() {
      const root = viewerBodyRef.current;
      root?.classList.add('docx-exporting');
      try {
        return await convertDocxDomToPdf({ root, fileName: file?.name, file });
      } finally {
        root?.classList.remove('docx-exporting');
      }
    }
  }));

  const selectedWordTable = selectedTableCell ? selectedTableElement() : null;
  const displayedTableCell = selectedTableCell || { row: 0, column: 0 };
  const selectedWordTableBounds = selectedTableBounds();
  const hasSelectedTableRange = selectedWordTableBounds && (selectedWordTableBounds.minRow !== selectedWordTableBounds.maxRow
    || selectedWordTableBounds.minColumn !== selectedWordTableBounds.maxColumn);
  const selectedTableRows = Array.from(selectedWordTable?.rows || []);
  const canChangeTableStructure = selectedTableRows.length > 0 && selectedTableRows.every((row) =>
    row.cells.length === selectedTableRows[0].cells.length && Array.from(row.cells).every((cell) =>
      cell.rowSpan === 1 && cell.colSpan === 1 && !cell.querySelector('table')));
  const fontOptions = availableFonts.length ? availableFonts :
    ['Arial', 'Malgun Gothic', '함초롬돋움', '함초롬바탕', 'Calibri', 'Times New Roman']
      .map((name) => ({ candidate: name, label: name }));
  const changeEditingMode = (nextEditing) => {
    if (editingEnabled && !nextEditing) {
      activeParagraphRef.current?.removeAttribute('contenteditable');
      commitDocumentChange();
      activeParagraphRef.current = null;
      setHasActiveParagraph(false);
      setSelectedImageId(null);
      setSelectedTableCell(null);
      setTablePickerOpen(false);
      setBorderPanelOpen(false);
    }
    setEditingEnabled(nextEditing);
  };

  if (renderError) {
    return (
      <div className="word-viewer word-viewer-state" role="status">
        {toolbarActions}
        <strong>Word 문서를 표시할 수 없습니다.</strong>
        <span>{renderError}</span>
      </div>
    );
  }

  if (!html) {
    return (
      <div className="word-viewer word-viewer-state" role="status">
        {toolbarActions}
        <strong>표시할 DOCX 내용이 없습니다.</strong>
      </div>
    );
  }

  return (
    <div className="word-viewer-shell">
      <div className={`docx-view-mode-controls document-toolbar${hasMultiplePages ? '' : ' is-single-page'}${tablePickerOpen ? ' is-table-picker-open' : ''}`} aria-label="DOCX 보기 방식">
        {downloadActions}
        <div className="docx-view-mode-toggle-group">
          {hasMultiplePages ? (
            <div className="docx-view-mode-toggle" role="group" aria-label="보기 방식 선택">
              <button type="button" className={viewMode === 'scroll' ? 'active' : ''}
                onClick={() => setViewMode('scroll')} aria-pressed={viewMode === 'scroll'}>스크롤</button>
              <button type="button" className={viewMode === 'page' ? 'active' : ''}
                onClick={() => setViewMode('page')} aria-pressed={viewMode === 'page'}>페이지 이동</button>
            </div>
          ) : null}
        <div className="docx-edit-toggle" role="group" aria-label="DOCX 모드 선택">
          <button type="button" className={!editingEnabled ? 'active' : ''}
            aria-pressed={!editingEnabled} onClick={() => changeEditingMode(false)}>뷰어</button>
          <button type="button" className={editingEnabled ? 'active' : ''}
            aria-pressed={editingEnabled} onClick={() => changeEditingMode(true)}>편집</button>
        </div>
        </div>
        <div className="docx-document-tools" role="group" aria-label="문서 작업">
          <div className="docx-table-picker" ref={tablePickerRef}>
            <button type="button" onClick={() => setTablePickerOpen((open) => !open)}
              disabled={!editingEnabled} aria-expanded={tablePickerOpen} aria-haspopup="dialog">표 추가</button>
            {tablePickerOpen && editingEnabled ? (
              <div className="docx-table-picker-panel" role="dialog" aria-label="표 만들기">
                <strong>{tablePickerSize.rows}행 × {tablePickerSize.columns}열</strong>
                <div className="docx-table-picker-grid" aria-label="표 크기 선택">
                  {Array.from({ length: 8 }, (_, row) => Array.from({ length: 10 }, (_, column) => (
                    <button key={`${row}-${column}`} type="button"
                      className={row < tablePickerSize.rows && column < tablePickerSize.columns ? 'is-active' : ''}
                      aria-label={`${row + 1}행 ${column + 1}열 표 추가`}
                      onMouseEnter={() => setTablePickerSize({ rows: row + 1, columns: column + 1 })}
                      onFocus={() => setTablePickerSize({ rows: row + 1, columns: column + 1 })}
                      onClick={() => insertTable(row + 1, column + 1)} />
                  )))}
                </div>
                <form className="docx-table-picker-custom" onSubmit={(event) => {
                  event.preventDefault();
                  insertTable(customTableRows, customTableColumns);
                }}>
                  <span>표 만들기</span>
                  <label>행 <input type="number" min="1" max="30" value={customTableRows}
                    onChange={(event) => setCustomTableRows(event.target.value)} /></label>
                  <label>열 <input type="number" min="1" max="20" value={customTableColumns}
                    onChange={(event) => setCustomTableColumns(event.target.value)} /></label>
                  <button type="submit">삽입</button>
                </form>
              </div>
            ) : null}
          </div>
          <button type="button" onClick={() => imageInputRef.current?.click()} disabled={!editingEnabled || !hasActiveParagraph}>이미지 추가</button>
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif" className="sr-only" onChange={(event) => {
            insertImage(event.target.files?.[0]).catch((error) => console.error('[WordViewer] image insert failed:', error));
            event.target.value = '';
          }} />
        </div>
        <div className="docx-document-history" role="group" aria-label="문서 변경 이력">
          <button
            type="button"
            onClick={undoDocumentChange}
            disabled={!historyState.canUndo}
            aria-label="적용 전으로 되돌리기"
            title="적용 전으로 되돌리기"
          >
            &lt;
          </button>
          <button
            type="button"
            onClick={redoDocumentChange}
            disabled={!historyState.canRedo}
            aria-label="다시 적용하기"
            title="다시 적용하기"
          >
            &gt;
          </button>
          <button
            type="button"
            className="docx-reset-all-button"
            onClick={() => setIsResetConfirmOpen(true)}
            disabled={!historyState.canReset}
          >
            전체 초기화
          </button>
        </div>
        {hasMultiplePages && viewMode === 'page' ? (
            <div className="docx-page-navigation-wrap">
              <div className="docx-page-navigation" aria-label="페이지 이동">
              <button
                type="button"
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                disabled={currentPage === 1}
              >
                이전
              </button>
              <label className="docx-page-input-label">
                <span className="sr-only">이동할 페이지</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label="이동할 페이지"
                  value={pageInput}
                  onChange={handlePageInputChange}
                  onBlur={handlePageInputSubmit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handlePageInputSubmit();
                      event.currentTarget.blur();
                    }
                  }}
                />
                <span aria-live="polite">/ {pageCount}</span>
              </label>
              <button
                type="button"
                onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))}
                disabled={currentPage === pageCount}
              >
                다음
              </button>
            </div>
              {pageInputError ? (
                <p className="docx-page-input-error" role="alert">{pageInputError}</p>
              ) : null}
            </div>
          ) : null}
        {toolbarActions}
      </div>
      {editingEnabled ? (
        <div className="docx-format-toolbar document-toolbar" role="toolbar" aria-label="DOCX 텍스트 서식">
          <label>글꼴 <select value={fontName} onChange={(event) => { setFontName(event.target.value); applyFormat('fontName', event.target.value); }}>
            {fontName && !fontOptions.some((font) => font.candidate === fontName)
              ? <option value={fontName}>{fontName}</option> : null}
            {fontOptions.map((font) => <option key={font.candidate} value={font.candidate}>{font.label}</option>)}
          </select></label>
          <label>크기 <input type="number" min="1" max="200" step="0.5" value={fontSize} onChange={(event) => setFontSize(event.target.value)} onBlur={() => applyFormat('fontSizePt', fontSize)} onKeyDown={(event) => { if (event.key === 'Enter') applyFormat('fontSizePt', fontSize); }} /> pt</label>
          <label>자간 <input type="number" min="-3" max="10" step="0.1" value={letterSpacing} onChange={(event) => setLetterSpacing(event.target.value)} onBlur={() => applyFormat('letterSpacingPt', letterSpacing)} onKeyDown={(event) => { if (event.key === 'Enter') { applyFormat('letterSpacingPt', letterSpacing); event.currentTarget.blur(); } }} /> pt</label>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('bold')} title="굵게"><b>가</b></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('italic')} title="기울임"><i>가</i></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('underline')} title="밑줄"><u>가</u></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('strikeThrough')} title="취소선"><s>가</s></button>
          <label>색 <input type="color" defaultValue="#000000" onChange={(event) => applyFormat('foreColor', event.target.value)} /></label>
          <div className="docx-text-align-group" role="group" aria-label="가로 정렬">
            {[
              ['left', '왼쪽 정렬'],
              ['center', '가운데 정렬'],
              ['right', '오른쪽 정렬'],
              ['justify', '양쪽 정렬']
            ].map(([value, title]) => (
              <button key={value} type="button" onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyFormat('textAlign', value)} aria-label={title} title={title}>
                <TextAlignmentIcon align={value} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {editingEnabled && selectedImageId ? (
        <div className="docx-image-toolbar document-toolbar" role="toolbar" aria-label="추가한 이미지 편집">
          <span>이미지</span>
          <label>너비 <input type="number" min="32" max="560" step="1" value={imageWidthDraft}
            onChange={(event) => setImageWidthDraft(event.target.value)} onBlur={applySelectedImageWidth}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /> px</label>
          <button type="button" onClick={deleteSelectedImage}>삭제</button>
        </div>
      ) : null}
      {editingEnabled ? (
        <div className={`docx-table-toolbar document-toolbar${selectedWordTable ? '' : ' is-inactive'}`}
          role="toolbar" aria-label="Word 표 편집" aria-hidden={!selectedWordTable}>
          <strong>표 편집</strong><span>{hasSelectedTableRange
            ? `${selectedWordTableBounds.minRow + 1}~${selectedWordTableBounds.maxRow + 1}행, ${selectedWordTableBounds.minColumn + 1}~${selectedWordTableBounds.maxColumn + 1}열`
            : `${displayedTableCell.row + 1}행 ${displayedTableCell.column + 1}열`}</span>
          <button type="button" disabled={!canChangeTableStructure} onClick={() => editTableStructure('insertRow')}>아래 행 추가</button>
          <button type="button" disabled={!canChangeTableStructure} onClick={() => editTableStructure('insertColumn')}>오른쪽 열 추가</button>
          <button type="button" disabled={!canChangeTableStructure || selectedTableRows.length <= 1} onClick={() => editTableStructure('deleteRow')}>행 삭제</button>
          <button type="button" disabled={!canChangeTableStructure || selectedTableRows[0]?.cells.length <= 1} onClick={() => editTableStructure('deleteColumn')}>열 삭제</button>
          <button type="button" disabled={!canChangeTableStructure || displayedTableCell.column + 1 >= selectedTableRows[0]?.cells.length} onClick={() => editTableStructure('mergeRight')}>오른쪽 셀 병합</button>
          <button type="button" disabled={!canChangeTableStructure || !hasSelectedTableRange} onClick={() => editTableStructure('mergeRange')}>선택 셀 병합</button>
          <label>셀 색 <input type="color" value={tableFill} onChange={(event) => updateTableCellStyle({ fill: event.target.value })} /></label>
          <button type="button" className="docx-border-panel-toggle" aria-expanded={borderPanelOpen}
            onClick={() => setBorderPanelOpen((open) => !open)}>테두리 설정</button>
          {selectedWordTable && selectedWordTableBounds && borderPanelOpen ? (
            <DocxTableBorderEditor table={selectedWordTable} bounds={selectedWordTableBounds}
              brush={tableBorderBrush} onBrushChange={setTableBorderBrush} onApply={updateTableBorders} />
          ) : null}
        </div>
      ) : null}
      {(fidelityRenderFailed || (!useFidelityRenderer && messages.length > 0)) ? (
        <div className="word-viewer-warning" role="status">
          {fidelityRenderFailed
            ? '원본 레이아웃 렌더링에 실패해 일반 미리보기로 표시합니다.'
            : '일부 Word 서식은 웹 미리보기에서 단순화될 수 있습니다.'}
        </div>
      ) : null}
      <div className="document-body-scroll word-viewer-scroll" ref={viewerBodyRef}>
        <div className="docx-scale-viewport">
          <div
            className="docx-scale-holder"
            style={docxSize.width && docxSize.height ? {
              width: `${docxSize.width * actualScale}px`,
              height: `${docxSize.height * actualScale}px`
            } : undefined}
          >
            <div
              ref={scaleContentRef}
              className="docx-scale-content"
              style={{ transform: `scale(${actualScale})` }}
            >
              {useFidelityRenderer ? (
                <div
                  ref={docxContentRef}
                  className="docx-content docx-fidelity-content"
                  onClick={handleContentClick}
                  onPointerDown={(event) => { handleImageResizePointerDown(event); handleTableCellPointerDown(event); }}
                  onMouseUp={rememberSelection}
                  onKeyUp={rememberSelection}
                  onKeyDown={(event) => { if (editingEnabled && event.key === 'Enter' && activeParagraphRef.current?.contains(event.target)) { event.preventDefault(); document.execCommand('insertLineBreak'); } }}
                  onInput={handleDocumentInput}
                  onBlur={commitDocumentChange}
                  aria-label={fidelityPageCount ? `원본 레이아웃 ${fidelityPageCount}페이지` : '원본 레이아웃을 불러오는 중'}
                />
              ) : (
                <div ref={docxContentRef} className="docx-content word-page-stack" style={pageStyle} onClick={handleContentClick} onPointerDown={(event) => { handleImageResizePointerDown(event); handleTableCellPointerDown(event); }} onMouseUp={rememberSelection} onKeyUp={rememberSelection} onKeyDown={(event) => { if (editingEnabled && event.key === 'Enter' && activeParagraphRef.current?.contains(event.target)) { event.preventDefault(); document.execCommand('insertLineBreak'); } }} onInput={handleDocumentInput} onBlur={commitDocumentChange}>
                  {pages.map((pageHtml, index) => (
                    <div
                      key={`${index}-${pages.length}`}
                      className={`docx-page-frame ${viewMode === 'page' ? 'page-mode' : ''}`}
                      hidden={viewMode === 'page' && currentPage !== index + 1}
                    >
                      <article
                        className="word-document"
                        data-virtual-page-number={index + 1}
                        dangerouslySetInnerHTML={{ __html: pageHtml }}
                      />
                      {viewMode === 'page' ? (
                        <span className="docx-current-page-indicator" aria-live="polite">
                          {index + 1} / {pages.length}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {isResetConfirmOpen ? (
        <div className="docx-reset-confirm-backdrop" role="presentation">
          <div className="docx-reset-confirm" role="dialog" aria-modal="true" aria-labelledby="docx-reset-confirm-title">
            <p id="docx-reset-confirm-title">모든 기능 적용전으로 초기화 하시겠습니다?</p>
            <div>
              <button
                type="button"
                onClick={() => {
                  resetAllDocumentChanges();
                  setIsResetConfirmOpen(false);
                }}
              >
                예
              </button>
              <button type="button" onClick={() => setIsResetConfirmOpen(false)}>아니요</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default WordViewer;
