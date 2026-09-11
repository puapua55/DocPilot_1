import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
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

const WordViewer = forwardRef(function WordViewer({ previewModel, file, scale = 1, toolbarActions }, ref) {
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

    renderAsync(file, container, container, {
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
    }).then(() => {
      if (cancelled) return;
      setFidelityPageCount(container.querySelectorAll('section.docx').length);
    }).catch((error) => {
      console.error('[WordViewer] original-layout DOCX render failed:', error);
      if (!cancelled) setFidelityRenderFailed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [file, shouldUseFidelityRenderer, fidelityRenderFailed]);

  const captureDocumentSnapshot = () => Array.from(
    docxContentRef.current?.querySelectorAll('.word-document, section.docx') || []
  ).map((page) => page.innerHTML);

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

      if (!hasKeyword(text, normalizedKeyword, matchMode)) {
        return;
      }

      const resultIndex = results.length;
      element.dataset.docxSearchIndex = String(resultIndex);
      results.push({
        id: `docx-${pageNumber}-${paragraphNumber}-${resultIndex}`,
        type: 'docx',
        index: resultIndex,
        pageNumber,
        paragraphNumber,
        paragraphIndex: paragraphNumber,
        blockIndex: blockIndex + 1,
        text,
        matchedText: text,
        keyword: normalizedKeyword,
        matchIndex: text.toLowerCase().indexOf(normalizedKeyword.toLowerCase())
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

    const resultIndex = typeof resultOrIndex === 'number'
      ? resultOrIndex
      : Number(resultOrIndex?.index ?? resultOrIndex?.raw?.index);

    if (!Number.isFinite(resultIndex)) {
      console.warn('[WordViewer] invalid search result target:', resultOrIndex);
      return false;
    }

    const element = root.querySelector(`[data-docx-search-index="${resultIndex}"]`);
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

    if (!root || !normalizedKeyword) {
      return { count: 0, results: [] };
    }

    ensureInitialHistorySnapshot();
    clearDocxHighlights();

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
        if (matchIndex > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, matchIndex)));
        }

        const id = `docx-highlight-${metadata.pageNumber}-${metadata.paragraphNumber || 0}-${results.length}`;
        const mark = document.createElement('span');
        mark.className = 'docx-highlight';
        mark.dataset.highlightColor = color;
        mark.dataset.docxHighlightId = id;
        mark.style.backgroundColor = DOCX_HIGHLIGHT_COLORS[color];
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
          keyword: normalizedKeyword,
          color,
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
        after += before.slice(cursor, matchIndex);
        after += replacement;
        results.push({
          id: `docx-replace-${metadata.pageNumber}-${metadata.paragraphNumber || 0}-${results.length}`,
          type: 'docx',
          pageNumber: metadata.pageNumber,
          paragraphNumber: metadata.paragraphNumber,
          blockIndex: metadata.blockIndex,
          originalText: originalBlockText,
          replacedText: originalBlockText.replace(target, replacement),
          keyword: target,
          newText: replacement,
          matchIndex,
          occurrenceIndex
        });
        cursor = matchIndex + target.length;
      });

      after += before.slice(cursor);
      node.nodeValue = after;
    });

    commitDocumentChange();
    return {
      count: results.length,
      replaceCount: results.length,
      results
    };
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
    }
  }));

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
      <div className="docx-view-mode-controls" aria-label="DOCX 보기 방식">
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
        {hasMultiplePages ? (
          <div className="docx-view-mode-options">
          <div className="docx-view-mode-toggle" role="group" aria-label="보기 방식 선택">
            <button
              type="button"
              className={viewMode === 'scroll' ? 'active' : ''}
              onClick={() => setViewMode('scroll')}
              aria-pressed={viewMode === 'scroll'}
            >
              스크롤
            </button>
            <button
              type="button"
              className={viewMode === 'page' ? 'active' : ''}
              onClick={() => setViewMode('page')}
              aria-pressed={viewMode === 'page'}
            >
              페이지 이동
            </button>
          </div>
          {viewMode === 'page' ? (
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
          </div>
        ) : null}
        {toolbarActions}
      </div>
      {(messages.length > 0 || fidelityRenderFailed) ? (
        <div className="word-viewer-warning" role="status">
          {fidelityRenderFailed
            ? '원본 레이아웃 렌더링에 실패해 일반 미리보기로 표시합니다.'
            : '일부 Word 서식은 웹 미리보기에서 단순화될 수 있습니다.'}
        </div>
      ) : null}
      <div className="word-viewer-scroll" ref={viewerBodyRef}>
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
                  aria-label={fidelityPageCount ? `원본 레이아웃 ${fidelityPageCount}페이지` : '원본 레이아웃을 불러오는 중'}
                />
              ) : (
                <div ref={docxContentRef} className="docx-content word-page-stack" style={pageStyle}>
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
