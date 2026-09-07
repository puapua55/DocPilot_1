import { forwardRef, useImperativeHandle, useRef } from 'react';
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

function isSearchExcluded(element) {
  return Boolean(element?.closest?.(SEARCH_EXCLUDED_SELECTOR));
}

function getSearchBlocks(root) {
  if (!root) {
    return [];
  }

  const primaryBlocks = Array.from(root.querySelectorAll(SEARCH_BLOCK_SELECTOR));
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

const WordViewer = forwardRef(function WordViewer({ previewModel }, ref) {
  const { html, renderError, messages = [] } = previewModel || {};
  const docxContentRef = useRef(null);

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
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
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

  const replaceDocxText = (originalText, newText) => {
    const root = docxContentRef.current;
    const target = String(originalText || '').trim();
    const replacement = String(newText ?? '');

    if (!root || !target) {
      return 0;
    }

    clearDocxHighlights();
    clearSearchSelection(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.includes(target)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (node.parentElement?.closest('script, style')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    let replaceCount = 0;
    textNodes.forEach((node) => {
      const before = node.nodeValue || '';
      const occurrences = before.split(target).length - 1;
      if (occurrences <= 0) {
        return;
      }

      node.nodeValue = before.split(target).join(replacement);
      replaceCount += occurrences;
    });

    return replaceCount;
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
    replaceText(originalText, newText) {
      return replaceDocxText(originalText, newText);
    },
    clearHighlights() {
      clearDocxHighlights();
    },
    getModifiedHtml() {
      return serializeModifiedHtml(docxContentRef.current);
    }
  }));

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
          ref={docxContentRef}
          className="word-document docx-content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
});

export default WordViewer;
