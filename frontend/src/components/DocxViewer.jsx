import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import './DocxViewer.css';

const TEXT_BLOCK_SELECTOR = 'p, li, td, th, h1, h2, h3';
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;
const A4_PAGE_RATIO = 297 / 210;
const DEFAULT_VIRTUAL_PAGE_GAP = 56;

function clampZoom(value) {
  return Math.max(
    MIN_ZOOM,
    Math.min(MAX_ZOOM, value)
  );
}

// mammoth is useful for text extraction/editing, but it does not faithfully
// reproduce Word page layout, backgrounds, shapes, or theme styling. The visible
// preview uses docx-preview; mammoth powers the hidden text DOM for commands.
const DocxViewer = forwardRef(function DocxViewer({ file, scale = 1, onZoomChange }, ref) {
  const bodyRef = useRef(null);
  const previewRef = useRef(null);
  const scaleHolderRef = useRef(null);
  const textLayerRef = useRef(null);
  const zoomRef = useRef(scale);
  const pageLayoutRef = useRef({ pageRatio: A4_PAGE_RATIO });
  const [status, setStatus] = useState('DOCX 문서를 불러오는 중입니다...');
  const [error, setError] = useState('');
  const [renderMode, setRenderMode] = useState('preview');
  const [zoom, setZoom] = useState(scale);
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [pageBoundaries, setPageBoundaries] = useState([]);

  useEffect(() => {
    const nextScale = clampZoom(Number.isFinite(scale) ? scale : 1);
    setZoom((current) => (Math.abs(current - nextScale) < 0.001 ? current : nextScale));
    zoomRef.current = nextScale;
  }, [scale]);

  const getDocxScaleTarget = useCallback(() => {
    const preview = previewRef.current;

    if (!preview) {
      console.warn('[DocxZoom] previewRef missing');
      return { root: null, pages: [] };
    }

    const wrapper = preview.querySelector('.docx-wrapper, .docx-preview-wrapper') || preview;
    const pages = Array.from(wrapper.querySelectorAll('section.docx, section.docx-preview'));

    if (!pages.length && wrapper.tagName === 'SECTION' && wrapper.classList.contains('docx-preview')) {
      pages.push(wrapper);
    }

    console.log('[DocxZoom] scale target:', {
      tag: wrapper.tagName,
      className: wrapper.className,
      pageCount: pages.length,
      width: wrapper.scrollWidth,
      height: wrapper.scrollHeight
    });

    return { root: wrapper, pages };
  }, []);

  const measureDocxContent = useCallback(() => {
    const targetInfo = getDocxScaleTarget();
    const target = targetInfo.root;

    if (!target) {
      return;
    }

    const nextSize = { width: target.scrollWidth, height: target.scrollHeight };
    if (nextSize.width <= 0 || nextSize.height <= 0) {
      return;
    }

    setContentSize((current) => (
      current.width === nextSize.width && current.height === nextSize.height ? current : nextSize
    ));
    updateDocxPageBoundaries();
  }, [getDocxScaleTarget]);

  const updateZoom = useCallback((next) => {
    const normalized = clampZoom(Number((next || 1).toFixed(2)));
    setZoom(normalized);

    if (typeof onZoomChange === 'function') {
      onZoomChange(normalized);
    }
  }, [onZoomChange]);

  const handleZoomOut = useCallback(() => {
    console.log('[DocxZoom] zoom out clicked');

    const next = clampZoom(Number((zoom - ZOOM_STEP).toFixed(2)));
    console.log('[DocxZoom] zoom out:', { prev: zoom, next });
    updateZoom(next);
  }, [updateZoom, zoom]);

  const handleZoomIn = useCallback(() => {
    console.log('[DocxZoom] zoom in clicked');

    const next = clampZoom(Number((zoom + ZOOM_STEP).toFixed(2)));
    console.log('[DocxZoom] zoom in:', { prev: zoom, next });
    updateZoom(next);
  }, [updateZoom, zoom]);

  const handleResetZoom = useCallback(() => {
    console.log('[DocxZoom] reset clicked');
    updateZoom(1);
  }, [updateZoom]);

  useImperativeHandle(ref, () => ({
    searchDocument(keyword) {
      return searchDocxDocument(keyword);
    },

    highlightText(keyword) {
      return highlightDocxText(keyword);
    },

    replaceText(originalText, newText) {
      return replaceDocxText(originalText, newText);
    },

    scrollToSearchResult(result) {
      return scrollToDocxSearchResult(result);
    },

    clearHighlights() {
      clearDocxHighlights();
      clearDocxSearchMarks();
    }
  }));

  useEffect(() => {
    let cancelled = false;

    async function loadDocx() {
      if (!file) {
        return;
      }

      console.log('[DocxViewer] file:', file?.name, file?.type, file?.size);
      setError('');
      setStatus('DOCX 문서를 불러오는 중입니다...');
      setRenderMode('preview');

      if (previewRef.current) {
        previewRef.current.innerHTML = '';
      }

      if (textLayerRef.current) {
        textLayerRef.current.innerHTML = '';
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        pageLayoutRef.current = await inspectDocxPageLayout(arrayBuffer);

        console.log('[DocxViewer] page break metadata:', pageLayoutRef.current);

        if (previewRef.current) {
          await renderAsync(arrayBuffer, previewRef.current, undefined, {
            className: 'docx-preview',
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            ignoreFonts: false,
            breakPages: true,
            renderHeaders: true,
            renderFooters: true,
            renderFootnotes: true,
            renderEndnotes: true,
            ignoreLastRenderedPageBreak: false,
            useBase64URL: true
          });
        }

        const preview = previewRef.current;
        const wrapper = preview?.querySelector('.docx-wrapper');
        const sections = Array.from(preview?.querySelectorAll('section.docx') || []);

        console.log('[DocxViewer] rendered section count:', sections.length);
        console.log('[DocxViewer] rendered wrapper count:', preview?.querySelectorAll('.docx-wrapper').length || 0);

        console.log('[DocxPageDebug] rendered DOM:', {
          hasPreview: !!preview,
          hasWrapper: !!wrapper,
          sectionCount: sections.length,
          previewChildren: Array.from(preview?.children || []).map((el) => ({
            tag: el.tagName,
            className: el.className,
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight
          })),
          wrapperChildren: wrapper
            ? Array.from(wrapper.children).map((el) => ({
              tag: el.tagName,
              className: el.className,
              width: el.getBoundingClientRect().width,
              height: el.getBoundingClientRect().height,
              scrollWidth: el.scrollWidth,
              scrollHeight: el.scrollHeight,
              display: window.getComputedStyle(el).display,
              marginBottom: window.getComputedStyle(el).marginBottom,
              overflow: window.getComputedStyle(el).overflow,
              position: window.getComputedStyle(el).position
            }))
            : []
        });
        sections.forEach((section, index) => {
          const style = window.getComputedStyle(section);

          console.log('[DocxPageDebug] section:', index + 1, {
            width: section.getBoundingClientRect().width,
            height: section.getBoundingClientRect().height,
            scrollWidth: section.scrollWidth,
            scrollHeight: section.scrollHeight,
            display: style.display,
            position: style.position,
            marginTop: style.marginTop,
            marginBottom: style.marginBottom,
            overflow: style.overflow,
            background: style.background,
            boxShadow: style.boxShadow
          });
        });
        console.log(
          '[DocxZoom] preview HTML:',
          previewRef.current?.innerHTML?.slice(0, 1000)
        );
        console.log('[DocxZoom] wrapper candidates:', {
          docxWrapper: previewRef.current?.querySelector('.docx-wrapper'),
          docxSection: previewRef.current?.querySelector('section.docx'),
          firstElementChild: previewRef.current?.firstElementChild,
          children: Array.from(previewRef.current?.children || []).map((el) => ({
            tag: el.tagName,
            className: el.className
          }))
        });

        const result = await convertDocxToTextHtml(arrayBuffer);

        if (textLayerRef.current) {
          textLayerRef.current.innerHTML = result.value || '';
        }

        if (cancelled) {
          return;
        }

        setRenderMode('preview');
        setZoom(1);
        setStatus('');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            measureDocxContent();
          });
        });

        if (result.messages?.length) {
          console.log('[DocxViewer] mammoth messages:', result.messages);
        }
      } catch (err) {
        console.error('[DocxViewer] docx-preview render failed:', err);

        try {
          const arrayBuffer = await file.arrayBuffer();
          const result = await convertDocxToTextHtml(arrayBuffer);

          if (previewRef.current) {
            previewRef.current.innerHTML = result.value || '';
          }

          if (textLayerRef.current) {
            textLayerRef.current.innerHTML = result.value || '';
          }

          if (cancelled) {
            return;
          }

          setRenderMode('mammoth');
          setZoom(1);
          setStatus('');
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              measureDocxContent();
            });
          });
        } catch (fallbackErr) {
          if (cancelled) {
            return;
          }

          console.error('[DocxViewer] mammoth fallback failed:', fallbackErr);
          setError('DOCX 문서를 표시하지 못했습니다. 파일 형식 또는 문서 내용을 확인해주세요.');
          setStatus('');
        }
      }
    }

    loadDocx();

    return () => {
      cancelled = true;
    };
  }, [file, measureDocxContent]);

  useEffect(() => {
    function handleResize() {
      measureDocxContent();
    }

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [measureDocxContent]);

  useEffect(() => {
    if (!bodyRef.current || typeof ResizeObserver !== 'function') {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      measureDocxContent();
    });

    observer.observe(bodyRef.current);

    return () => {
      observer.disconnect();
    };
  }, [measureDocxContent]);

  useEffect(() => {
    console.log('[DocxZoom] zoom state changed:', zoom);
    zoomRef.current = zoom;
    window.requestAnimationFrame(updateDocxPageBoundaries);
  }, [zoom]);

  function getDocxSearchRoot() {
    const preview = previewRef.current;
    return preview?.querySelector('.docx-wrapper, .docx-preview-wrapper') || preview;
  }

  function getDocxPageInfo(block, root, sections) {
    const section = block.closest('section.docx, section.docx-preview');
    const sectionIndex = sections.indexOf(section);

    if (sections.length > 1 && sectionIndex >= 0) {
      return {
        pageNumber: sectionIndex + 1,
        pageHeight: section.offsetHeight || section.getBoundingClientRect().height,
        relativeTop: block.offsetTop
      };
    }

    const pageRoot = section || root;
    const pageHeight = getEstimatedDocxPageHeight(pageRoot);
    const pageRect = pageRoot.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const zoomScale = zoomRef.current || 1;
    const relativeTop = Math.max(0, (blockRect.top - pageRect.top) / zoomScale);

    return {
      pageNumber: pageHeight > 0 ? Math.floor(relativeTop / pageHeight) + 1 : 1,
      pageHeight,
      relativeTop
    };
  }

  function getEstimatedDocxPageHeight(pageRoot) {
    if (!pageRoot) {
      return 0;
    }

    const width = pageRoot.offsetWidth || (pageRoot.getBoundingClientRect().width / (zoomRef.current || 1));
    const pageRatio = pageLayoutRef.current?.pageRatio || A4_PAGE_RATIO;

    return width > 0 ? width * pageRatio : 1122;
  }

  function setDocxPageBoundaries(nextBoundaries) {
    setPageBoundaries((current) => {
      const unchanged = current.length === nextBoundaries.length && current.every((boundary, index) => {
        const next = nextBoundaries[index];
        return boundary.pageNumber === next.pageNumber &&
          boundary.top === next.top &&
          boundary.left === next.left &&
          boundary.width === next.width &&
          boundary.height === next.height;
      });

      return unchanged ? current : nextBoundaries;
    });
  }

  function updateDocxPageBoundaries() {
    const root = getDocxSearchRoot();
    const holder = scaleHolderRef.current;
    const sections = Array.from(root?.querySelectorAll('section.docx, section.docx-preview') || []);

    if (!root || !holder || sections.length !== 1) {
      setDocxPageBoundaries([]);
      return;
    }

    const section = sections[0];
    const pageHeight = getEstimatedDocxPageHeight(section);
    const sectionHeight = section.offsetHeight;

    const hasExplicitPageBreak = (pageLayoutRef.current?.explicitPageBreaks || 0) > 0 ||
      (pageLayoutRef.current?.lastRenderedPageBreaks || 0) > 0;
    const shouldShowVirtualPageGaps = !hasExplicitPageBreak && pageHeight > 0 && sectionHeight > pageHeight * 1.1;
    if (!shouldShowVirtualPageGaps) {
      setDocxPageBoundaries([]);
      return;
    }

    const zoomScale = zoomRef.current || 1;
    const holderRect = holder.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    const sectionTop = (sectionRect.top - holderRect.top) / zoomScale;
    const sectionLeft = (sectionRect.left - holderRect.left) / zoomScale;
    const pageCount = Math.ceil(sectionHeight / pageHeight);
    const pageGap = getDocxPageGap(sections, zoomScale);
    const boundaries = Array.from({ length: pageCount - 1 }, (_, index) => {
      const boundaryTop = pageHeight * (index + 1);

      return {
        pageNumber: index + 2,
        top: sectionTop + boundaryTop - pageGap / 2,
        left: sectionLeft,
        width: section.offsetWidth,
        height: pageGap
      };
    });

    console.log('[DocxViewer] page visualization:', {
      sectionCount: sections.length,
      sectionWidth: section.offsetWidth,
      sectionHeight,
      estimatedPageHeight: pageHeight,
      pageGap,
      hasExplicitPageBreak,
      shouldShowVirtualPageGaps,
      tables: Array.from(section.querySelectorAll('table')).map((table) => ({
        offsetTop: table.offsetTop,
        height: table.offsetHeight
      })),
      pageCount
    });

    setDocxPageBoundaries(boundaries);
  }

  function getDocxPageGap(sections, zoomScale) {
    if (sections.length >= 2) {
      const firstRect = sections[0].getBoundingClientRect();
      const secondRect = sections[1].getBoundingClientRect();
      const measuredGap = (secondRect.top - firstRect.bottom) / zoomScale;

      if (Number.isFinite(measuredGap) && measuredGap > 16 && measuredGap < 120) {
        return Math.round(measuredGap);
      }
    }

    return DEFAULT_VIRTUAL_PAGE_GAP;
  }

  function getDocxTextBlocks() {
    const root = getDocxSearchRoot();
    if (!root) {
      return [];
    }

    const sections = Array.from(root.querySelectorAll('section.docx, section.docx-preview'));
    const paragraphCounts = new Map();

    return Array.from(root.querySelectorAll(TEXT_BLOCK_SELECTOR))
      .filter((el) => !el.closest('[data-docx-hidden="true"], .docx-hidden-text, .docx-search-source'))
      .filter((el) => !el.closest('[data-docx-page-boundary-layer="true"]'))
      .filter((el) => !el.querySelector(TEXT_BLOCK_SELECTOR))
      .filter((el) => el.textContent?.trim())
      .map((el, index) => {
        const pageInfo = getDocxPageInfo(el, root, sections);
        const pageNumber = pageInfo.pageNumber;
        const paragraphNumber = (paragraphCounts.get(pageNumber) || 0) + 1;

        paragraphCounts.set(pageNumber, paragraphNumber);

        return {
          element: el,
          blockIndex: index + 1,
          pageNumber,
          paragraphNumber,
          pageHeight: pageInfo.pageHeight,
          relativeTop: pageInfo.relativeTop,
          text: el.textContent.trim()
        };
      });
  }

  function searchDocxDocument(keyword) {
    const normalizedKeyword = String(keyword || '').trim();
    if (!normalizedKeyword) {
      return [];
    }

    clearDocxSearchMarks();

    const results = [];
    const searchRoot = getDocxSearchRoot();
    const blocks = getDocxTextBlocks();

    console.log('[DocxViewer] search root:', searchRoot);
    console.log('[DocxViewer] searchable block count:', blocks.length);

    blocks.forEach((block) => {
      if (!block.text.includes(normalizedKeyword)) {
        return;
      }

      const resultIndex = results.length;

      block.element.dataset.docxSearchIndex = String(resultIndex);
      results.push({
        type: 'docx',
        index: resultIndex,
        blockIndex: block.blockIndex,
        pageNumber: block.pageNumber,
        paragraphIndex: block.paragraphNumber,
        paragraphNumber: block.paragraphNumber,
        keyword: normalizedKeyword,
        matchedText: block.text,
        previewText: block.text,
        text: block.text
      });

      console.log('[DocxViewer] search result block:', {
        text: block.text,
        offsetTop: block.element.offsetTop,
        pageNumber: block.pageNumber,
        pageHeight: block.pageHeight,
        relativeTop: block.relativeTop
      });
    });

    console.log('[DocxViewer] search results:', results.length);

    return results;
  }

  function scrollToDocxSearchResult(result) {
    const root = getDocxSearchRoot();
    if (!root || !result) {
      return;
    }

    const index = result.index ?? result.resultIndex;
    const target = root.querySelector(`[data-docx-search-index="${index}"]`);

    if (!target) {
      console.warn('[DocxSearch] target not found:', result);
      return;
    }

    root.querySelectorAll('.docx-search-current').forEach((el) => {
      el.classList.remove('docx-search-current');
    });

    target.classList.add('docx-search-current');

    target.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }

  function highlightDocxText(keyword) {
    const root = getDocxSearchRoot();
    const normalizedKeyword = String(keyword || '').trim();

    if (!root || !normalizedKeyword) {
      return 0;
    }

    clearDocxHighlights();

    const count = highlightTextInRoot(root, normalizedKeyword);

    console.log('[DocxHighlight] count:', count);

    return count;
  }

  function replaceDocxText(originalText, newText) {
    const root = getDocxSearchRoot();
    const from = String(originalText || '');
    const to = String(newText || '');

    if (!root || !from.trim()) {
      return 0;
    }

    clearDocxHighlights();
    clearDocxSearchMarks();

    const count = replaceTextInRoot(root, from, to);

    console.log('[DocxReplace] count:', count);

    return count;
  }

  function clearDocxHighlights() {
    const root = getDocxSearchRoot();
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

  function clearDocxSearchMarks() {
    const root = getDocxSearchRoot();
    if (!root) {
      return;
    }

    root.querySelectorAll('[data-docx-search-index]').forEach((el) => {
      delete el.dataset.docxSearchIndex;
    });

    root.querySelectorAll('.docx-search-current').forEach((el) => {
      el.classList.remove('docx-search-current');
    });
  }

  return (
    <div className="docx-viewer">
      <div ref={bodyRef} className="docx-viewer-body">
        {status ? (
          <div className="docx-viewer-status">
            {status}
          </div>
        ) : null}

        {error ? (
          <div className="docx-viewer-error">
            {error}
          </div>
        ) : null}

        <div
          className="docx-scale-stage"
          style={{
            width: contentSize.width ? `${contentSize.width * zoom}px` : '100%',
            height: contentSize.height ? `${contentSize.height * zoom}px` : 'auto'
          }}
        >
          <div
            ref={scaleHolderRef}
            className="docx-scale-holder"
            style={{
              width: contentSize.width ? `${contentSize.width}px` : 'fit-content',
              height: contentSize.height ? `${contentSize.height}px` : 'auto',
              transform: `scale(${zoom})`,
              transformOrigin: 'top center'
            }}
          >
            <div
              ref={previewRef}
              className="docx-preview-container"
              data-docx-scale={zoom}
            />
            {pageBoundaries.length > 0 ? (
              <div
                className="docx-page-visual-layer"
                aria-hidden="true"
                data-docx-page-boundary-layer="true"
              >
                {pageBoundaries.map((boundary) => (
                  <div
                    key={boundary.pageNumber}
                    className="docx-virtual-page-gap"
                    style={{
                      top: `${boundary.top}px`,
                      left: `${boundary.left}px`,
                      width: `${boundary.width}px`,
                      height: `${boundary.height}px`
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div ref={textLayerRef} className="docx-text-dom" aria-hidden="true" />
      </div>
    </div>
  );
});

async function convertDocxToTextHtml(arrayBuffer) {
  return mammoth.convertToHtml(
    { arrayBuffer },
    {
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        'b => strong',
        'i => em'
      ]
    }
  );
}

async function inspectDocxPageLayout(arrayBuffer) {
  try {
    const zip = await JSZip.loadAsync(arrayBuffer.slice(0));
    const documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      return { pageRatio: A4_PAGE_RATIO, explicitPageBreaks: 0, lastRenderedPageBreaks: 0 };
    }

    const pageSizeMatch = documentXml.match(/<w:pgSz\b[^>]*\bw:w="(\d+)"[^>]*\bw:h="(\d+)"[^>]*\/?\s*>/i);
    const pageWidth = Number(pageSizeMatch?.[1]);
    const pageHeight = Number(pageSizeMatch?.[2]);
    const pageRatio = pageWidth > 0 && pageHeight > 0 ? pageHeight / pageWidth : A4_PAGE_RATIO;

    return {
      pageRatio,
      explicitPageBreaks: (documentXml.match(/<w:br\b[^>]*\bw:type="page"[^>]*\/?\s*>/gi) || []).length,
      lastRenderedPageBreaks: (documentXml.match(/<w:lastRenderedPageBreak\b[^>]*\/?\s*>/gi) || []).length
    };
  } catch (error) {
    console.warn('[DocxViewer] Could not inspect DOCX page metadata:', error);
    return { pageRatio: A4_PAGE_RATIO, explicitPageBreaks: 0, lastRenderedPageBreaks: 0 };
  }
}

function highlightTextInRoot(root, keyword) {
  if (!root || !keyword) {
    return 0;
  }

  const textNodes = collectMatchingTextNodes(root, keyword);
  let count = 0;

  textNodes.forEach((node) => {
    const text = node.nodeValue || '';
    const parts = text.split(keyword);

    if (parts.length <= 1) {
      return;
    }

    const fragment = document.createDocumentFragment();

    parts.forEach((part, index) => {
      if (part) {
        fragment.appendChild(document.createTextNode(part));
      }

      if (index < parts.length - 1) {
        const mark = document.createElement('span');
        mark.className = 'docx-highlight';
        mark.textContent = keyword;
        fragment.appendChild(mark);
        count += 1;
      }
    });

    node.parentNode?.replaceChild(fragment, node);
  });

  return count;
}

function replaceTextInRoot(root, from, to) {
  if (!root || !from) {
    return 0;
  }

  const textNodes = collectMatchingTextNodes(root, from);
  let count = 0;

  textNodes.forEach((node) => {
    const value = node.nodeValue || '';
    const nextValue = value.split(from).join(to);

    if (nextValue !== value) {
      count += value.split(from).length - 1;
      node.nodeValue = nextValue;
    }
  });

  return count;
}

function collectMatchingTextNodes(root, text) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const value = node.nodeValue || '';

        if (!value.includes(text)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (
          node.parentElement?.closest('.docx-highlight') ||
          node.parentElement?.closest('script, style')
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  const textNodes = [];

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  return textNodes;
}

export default DocxViewer;
