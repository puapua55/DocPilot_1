import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import mammoth from 'mammoth';
import './DocxViewer.css';

const TEXT_BLOCK_SELECTOR = 'p, li, td, th, h1, h2, h3';
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;

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
  const [status, setStatus] = useState('DOCX 문서를 불러오는 중입니다...');
  const [error, setError] = useState('');
  const [renderMode, setRenderMode] = useState('preview');
  const [zoom, setZoom] = useState(scale);

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

  const getDocxPagesMetrics = useCallback((target, holder) => {
    const pages = Array.from(target.querySelectorAll('section.docx'));
    const widths = pages.map((page) => {
      const rect = page.getBoundingClientRect();
      return page.scrollWidth || rect.width || 0;
    });
    const heights = pages.map((page) => {
      const rect = page.getBoundingClientRect();
      return page.scrollHeight || rect.height || 0;
    });

    const maxPageWidth = widths.length > 0 ? Math.max(...widths) : 0;
    const maxPageHeight = heights.length > 0 ? Math.max(...heights) : 0;
    const viewportWidth = Math.max(320, (holder?.parentElement?.clientWidth || 900) - 80);
    const fitScale = maxPageWidth > 0 ? Math.min(1.2, Math.max(0.45, viewportWidth / maxPageWidth)) : 1;
    const totalPageHeight = heights.reduce((sum, height) => sum + height, 0) + Math.max(0, pages.length - 1) * 28;

    return {
      pageCount: pages.length,
      maxPageWidth,
      maxPageHeight,
      totalPageHeight,
      viewportWidth,
      fitScale
    };
  }, []);

  const applyDocxScale = useCallback((nextScale) => {
    const holder = scaleHolderRef.current;
    const targetInfo = getDocxScaleTarget();
    const target = targetInfo.root;
    const pages = targetInfo.pages;

    if (!holder || !target) {
      return;
    }

    const safeScale = clampZoom(Number.isFinite(nextScale) ? nextScale : 1);
    const viewportWidth = Math.max(320, (holder.parentElement?.clientWidth || 900) - 80);
    const a4Width = 794;
    const a4Height = 1123;
    const baseWidth = Math.min(a4Width, viewportWidth * 0.92);
    const pageRatio = a4Height / a4Width;
    const pageDisplayWidth = Math.min(Math.max(baseWidth * safeScale, 220), viewportWidth * 1.45);
    const pageDisplayHeight = pageDisplayWidth * pageRatio;

    pages.forEach((page) => {
      page.style.setProperty('width', `${pageDisplayWidth}px`, 'important');
      page.style.setProperty('height', `${pageDisplayHeight}px`, 'important');
      page.style.setProperty('max-width', `${viewportWidth * 1.45}px`, 'important');
      page.style.setProperty('min-width', '220px', 'important');
      page.style.setProperty('box-sizing', 'border-box', 'important');
      page.style.setProperty('display', 'block', 'important');
      page.style.setProperty('margin-left', 'auto', 'important');
      page.style.setProperty('margin-right', 'auto', 'important');
      page.style.setProperty('overflow', 'hidden', 'important');
    });

    target.style.setProperty('width', '100%', 'important');
    target.style.setProperty('max-width', `${viewportWidth * 1.15}px`, 'important');
    target.style.setProperty('height', 'auto', 'important');
    target.style.setProperty('display', 'flex', 'important');
    target.style.setProperty('flex-direction', 'column', 'important');
    target.style.setProperty('align-items', 'center', 'important');
    target.style.setProperty('justify-content', 'flex-start', 'important');
    target.style.setProperty('transform', 'none', 'important');
    target.style.setProperty('transform-origin', 'top center', 'important');

    holder.style.width = '100%';
    holder.style.maxWidth = `${viewportWidth * 1.15}px`;
    holder.style.height = 'auto';
    holder.style.minHeight = '0';
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
    requestAnimationFrame(() => {
      applyDocxScale(1);
    });
  }, [applyDocxScale, updateZoom]);

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
            console.log('[DocxViewer] initial scale apply');
            applyDocxScale(1);
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
              console.log('[DocxViewer] initial scale apply');
              applyDocxScale(1);
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
  }, [applyDocxScale, file]);

  useEffect(() => {
    function handleResize() {
      applyDocxScale(zoomRef.current);
    }

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [applyDocxScale]);

  useEffect(() => {
    if (!bodyRef.current || typeof ResizeObserver !== 'function') {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      applyDocxScale(zoomRef.current);
    });

    observer.observe(bodyRef.current);

    return () => {
      observer.disconnect();
    };
  }, [applyDocxScale]);

  useEffect(() => {
    console.log('[DocxZoom] zoom state changed:', zoom);
    zoomRef.current = zoom;

    requestAnimationFrame(() => {
      applyDocxScale(zoom);
    });
  }, [applyDocxScale, zoom]);

  function getDocxTextBlocks() {
    const root = textLayerRef.current;
    if (!root) {
      return [];
    }

    return Array.from(root.querySelectorAll(TEXT_BLOCK_SELECTOR))
      .filter((el) => el.textContent?.trim())
      .map((el, index) => ({
        element: el,
        blockIndex: index + 1,
        text: el.textContent.trim()
      }));
  }

  function searchDocxDocument(keyword) {
    const normalizedKeyword = String(keyword || '').trim();
    if (!normalizedKeyword) {
      return [];
    }

    clearDocxSearchMarks();

    const results = [];

    getDocxTextBlocks().forEach((block) => {
      if (!block.text.includes(normalizedKeyword)) {
        return;
      }

      const resultIndex = results.length;

      block.element.dataset.docxSearchIndex = String(resultIndex);
      results.push({
        type: 'docx',
        index: resultIndex,
        blockIndex: block.blockIndex,
        paragraphIndex: block.blockIndex,
        keyword: normalizedKeyword,
        matchedText: block.text,
        previewText: block.text
      });
    });

    console.log('[DocxSearch] results:', results);

    return results;
  }

  function scrollToDocxSearchResult(result) {
    const root = textLayerRef.current;
    const previewRoot = previewRef.current;
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

    const previewTarget = findPreviewBlockByText(target.textContent || '');
    const scrollTarget = previewTarget || target;

    previewRoot?.querySelectorAll('.docx-search-current').forEach((el) => {
      el.classList.remove('docx-search-current');
    });
    previewTarget?.classList.add('docx-search-current');

    scrollTarget.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }

  function highlightDocxText(keyword) {
    const root = textLayerRef.current;
    const normalizedKeyword = String(keyword || '').trim();

    if (!root || !normalizedKeyword) {
      return 0;
    }

    clearDocxHighlights();

    const hiddenCount = highlightTextInRoot(root, normalizedKeyword);
    const previewCount = highlightTextInRoot(previewRef.current, normalizedKeyword);
    const count = previewCount || hiddenCount;

    console.log('[DocxHighlight] count:', count);

    return count;
  }

  function replaceDocxText(originalText, newText) {
    const root = textLayerRef.current;
    const from = String(originalText || '');
    const to = String(newText || '');

    if (!root || !from.trim()) {
      return 0;
    }

    clearDocxHighlights();
    clearDocxSearchMarks();

    const count = replaceTextInRoot(root, from, to);
    replaceTextInRoot(previewRef.current, from, to);

    console.log('[DocxReplace] count:', count);

    return count;
  }

  function clearDocxHighlights() {
    [textLayerRef.current, previewRef.current].forEach((root) => {
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
    });
  }

  function clearDocxSearchMarks() {
    [textLayerRef.current, previewRef.current].forEach((root) => {
      if (!root) {
        return;
      }

      root.querySelectorAll('[data-docx-search-index]').forEach((el) => {
        delete el.dataset.docxSearchIndex;
      });

      root.querySelectorAll('.docx-search-current').forEach((el) => {
        el.classList.remove('docx-search-current');
      });
    });
  }

  function findPreviewBlockByText(text) {
    const root = previewRef.current;
    const normalizedText = String(text || '').trim();

    if (!root || !normalizedText) {
      return null;
    }

    return Array.from(root.querySelectorAll(TEXT_BLOCK_SELECTOR))
      .find((el) => el.textContent?.trim() === normalizedText) || null;
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

        <div ref={scaleHolderRef} className="docx-scale-holder">
          <div
            ref={previewRef}
            className="docx-preview-container"
            data-docx-scale={zoom}
          />
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
