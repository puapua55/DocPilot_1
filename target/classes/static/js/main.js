console.log('[JS 로드됨]');

const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatWindow = document.getElementById('chatWindow');

function formatFileSize(bytes) {
  if (!bytes) return '';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function addMessage(text, isUser = false) {
  const row = document.createElement('div');
  row.className = `message ${isUser ? 'user' : 'ai'}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  chatWindow?.appendChild(row);
  if (chatWindow) {
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }
}

function handleChatSubmit(event) {
  event.preventDefault();
  const value = chatInput?.value.trim();
  if (!value) return;

  addMessage(value, true);
  if (chatInput) {
    chatInput.value = '';
  }

  setTimeout(() => {
    addMessage('요청 내용을 확인했습니다. 테스트 화면에서는 실제 AI 응답 대신 이 메시지가 표시됩니다.', false);
  }, 350);
}

function initializeDocumentViewer() {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const previewArea = document.getElementById('documentPreviewArea') || document.getElementById('uploadBox');

  if (!previewArea) {
    console.warn('DocPilot 업로드 안내 영역을 찾을 수 없습니다.');
    return;
  }

  let fileInputRef = null;
  let debugMessages = [];
  let currentObjectUrl = null;
  let currentPdfDocument = null;
  let currentViewerType = null;

  appendDebugLog('[업로드 안내 영역 확인]');
  console.log('[uploadBox 확인]', previewArea);

  renderUploadPlaceholder();

  function renderUploadPlaceholder() {
    previewArea.innerHTML = `
      <div class="upload-card drop-zone" id="dropZone">
        <div class="upload-icon">📄</div>
        <h2 id="uploadTitle">파일을 업로드하세요</h2>
        <p id="uploadSubtitle">PDF, DOC, DOCX 파일을 드래그하거나 클릭해 추가</p>
        <button id="selectFileButton" type="button" class="upload-button select-file-button">
          ＋ 파일 선택
        </button>
        <input
          id="fileInput"
          name="file"
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          class="file-input-hidden"
        />
        <div id="debugLog" class="debug-log"></div>
        <div class="upload-meta" id="uploadMeta">
          <span>🔒 모든 파일은 로컬 환경에서 처리됩니다.</span>
          <span>데이터는 외부로 전송되지 않습니다.</span>
        </div>
      </div>`;

    renderDebugLog();
    bindUploadEvents();
  }

  function bindUploadEvents() {
    fileInputRef = previewArea.querySelector('#fileInput');
    const selectFileButton = previewArea.querySelector('#selectFileButton');
    const dropZone = previewArea.querySelector('#dropZone');

    if (selectFileButton && fileInputRef) {
      selectFileButton.addEventListener('click', (event) => {
        appendDebugLog('[파일선택 버튼 클릭됨]');
        event.preventDefault();
        fileInputRef.click();
      });
    }

    if (fileInputRef) {
      fileInputRef.addEventListener('change', async (event) => {
        appendDebugLog('[파일 선택 이벤트 발생]');
        const file = event.target.files?.[0];
        appendDebugLog(`[선택된 파일] ${file ? file.name : '없음'}`);
        if (!file) return;

        appendDebugLog(`[파일 타입] ${file.type || 'unknown'}`);
        appendDebugLog(`[파일 크기] ${formatFileSize(file.size)}`);
        event.target.value = '';
        await handleFileSelection(file);
      });
    }

    if (dropZone) {
      dropZone.addEventListener('dragover', (event) => {
        event.preventDefault();
        dropZone.classList.add('dragover');
      });

      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
      });

      dropZone.addEventListener('drop', async (event) => {
        event.preventDefault();
        dropZone.classList.remove('dragover');
        const file = event.dataTransfer.files?.[0];
        if (file) {
          await handleFileSelection(file);
        }
      });
    }
  }

  async function handleFileSelection(file) {
    try {
      validateFile(file);
    } catch (error) {
      appendDebugLog(`[업로드 오류] ${error.message}`);
      return;
    }

    appendDebugLog('[업로드 안내 영역 확인]');
    if (isPdfFile(file)) {
      await showLocalViewer(file);
    } else {
      appendDebugLog('[지원하지 않는 형식이므로 기본 안내를 표시합니다.]');
      renderSelectionMessage(file);
    }
  }

  async function showLocalViewer(file) {
    const isAndroid = /Android/i.test(navigator.userAgent);
    const isMobile = window.innerWidth <= 768 || isAndroid;

    appendDebugLog('[로컬 뷰어 표시 시작]');
    appendDebugLog('[PDF 파일 확인]');
    appendDebugLog(`[사용 브라우저] ${navigator.userAgent}`);
    appendDebugLog(`[isAndroid] ${isAndroid}`);
    appendDebugLog(`[isMobile] ${isMobile}`);

    clearViewerState();

    currentObjectUrl = URL.createObjectURL(file);
    appendDebugLog('[blob URL 생성]');
    appendDebugLog(`[blob URL] ${currentObjectUrl}`);

    if (isMobile) {
      appendDebugLog('[선택된 뷰어 방식] PDF.js');
      await showPdfWithPdfJs(file, currentObjectUrl);
    } else {
      appendDebugLog('[선택된 뷰어 방식] iframe');
      showPdfWithIframe(file, currentObjectUrl);
    }

    appendDebugLog('[로컬 PDF 뷰어 표시 완료]');
  }

  function renderViewerShell(file, bodyMarkup) {
    previewArea.innerHTML = `
      <div class="viewer-header">
        <div class="viewer-file-info">
          <span class="pdf-badge">PDF</span>
          <span class="viewer-file-name">${escapeHtml(file.name)}</span>
          <span class="viewer-file-size">${formatFileSize(file.size)}</span>
        </div>
        <button id="closeViewerBtn" type="button" class="viewer-close-btn">×</button>
      </div>
      ${bodyMarkup}
      <div id="debugLog" class="debug-log"></div>`;

    renderDebugLog();
    previewArea.querySelector('#closeViewerBtn')?.addEventListener('click', () => {
      closeViewer();
    });
  }

  function showPdfWithIframe(file, fileUrl) {
    appendDebugLog('[iframe PDF 뷰어 표시 시작]');
    renderViewerShell(file, `
      <div class="viewer-body">
        <iframe
          src="${fileUrl}"
          class="pdf-viewer"
          title="PDF 미리보기"
        ></iframe>
      </div>`);

    appendDebugLog('[iframe 삽입 완료]');
    debugViewerMetrics();
    currentViewerType = 'iframe';
  }

  async function showPdfWithPdfJs(file, fileUrl) {
    appendDebugLog('[PDF.js 뷰어 표시 시작]');
    renderViewerShell(file, `
      <div class="viewer-body pdfjs-viewer-body">
        <div class="pdf-canvas-wrap">
          <canvas id="pdfCanvas"></canvas>
        </div>
      </div>`);

    try {
      await loadPdfJsLibrary();
      const pdfJsLib = window.pdfjsLib;
      const pdfDocument = await pdfJsLib.getDocument(fileUrl).promise;
      currentPdfDocument = pdfDocument;
      appendDebugLog('[PDF.js 문서 로드 완료]');

      const page = await pdfDocument.getPage(1);
      appendDebugLog('[PDF.js 첫 페이지 로드 완료]');

      const canvas = previewArea.querySelector('#pdfCanvas');
      if (!canvas) {
        throw new Error('PDF canvas를 찾을 수 없습니다.');
      }

      const viewport = page.getViewport({ scale: 1 });
      const containerWidth = canvas.parentElement?.clientWidth || 320;
      const scale = Math.min(1.9, containerWidth / viewport.width);
      const scaledViewport = page.getViewport({ scale });
      appendDebugLog('[PDF.js scale 계산 완료]');

      canvas.width = Math.floor(scaledViewport.width);
      canvas.height = Math.floor(scaledViewport.height);
      canvas.style.width = `${Math.floor(scaledViewport.width)}px`;
      canvas.style.height = `${Math.floor(scaledViewport.height)}px`;

      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: scaledViewport }).promise;
      appendDebugLog('[PDF.js 렌더링 완료]');
    } catch (error) {
      appendDebugLog(`[PDF.js 오류] ${error.message}`);
      showPdfWithIframe(file, fileUrl);
      return;
    }

    debugViewerMetrics();
    currentViewerType = 'pdfjs';
  }

  function loadPdfJsLibrary() {
    return new Promise((resolve, reject) => {
      if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
        appendDebugLog('[PDF.js 로드 확인]');
        resolve(window.pdfjsLib);
        return;
      }

      const existingScript = document.querySelector('script[data-pdfjs-loader]');
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(window.pdfjsLib), { once: true });
        existingScript.addEventListener('error', () => reject(new Error('PDF.js 스크립트 로드 실패')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.js';
      script.async = true;
      script.setAttribute('data-pdfjs-loader', 'true');
      script.onload = () => {
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
          appendDebugLog('[PDF.js 로드 확인]');
          resolve(window.pdfjsLib);
        } else {
          reject(new Error('PDF.js 초기화 실패'));
        }
      };
      script.onerror = () => reject(new Error('PDF.js 스크립트 로드 실패'));
      document.head.appendChild(script);
    });
  }

  function renderSelectionMessage(file) {
    previewArea.innerHTML = `
      <div class="selection-info-card">
        <div class="selection-info-title">선택된 파일</div>
        <div class="selection-info-name">${escapeHtml(file.name)}</div>
        <div class="selection-info-size">${formatFileSize(file.size)}</div>
        <p class="selection-info-note">현재는 PDF 파일 미리보기를 기본으로 제공합니다.</p>
        <button id="reselectFileButton" type="button" class="reselect-button">다른 파일 선택</button>
        <div id="debugLog" class="debug-log"></div>
      </div>`;

    renderDebugLog();
    previewArea.querySelector('#reselectFileButton')?.addEventListener('click', () => {
      appendDebugLog('[파일선택 버튼 클릭됨]');
      fileInputRef?.click();
    });
  }

  function validateFile(file) {
    const extension = getExtension(file.name);
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (!['pdf', 'doc', 'docx'].includes(extension)) {
      throw new Error('PDF 또는 DOC/DOCX 파일만 선택할 수 있습니다.');
    }
    if (!allowedTypes.includes(file.type) && file.type !== '') {
      throw new Error('PDF 또는 DOC/DOCX 파일만 선택할 수 있습니다.');
    }
    if (file.size === 0) {
      throw new Error('내용이 없는 파일입니다.');
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new Error('파일 크기는 50MB를 초과할 수 없습니다.');
    }
  }

  function closeViewer() {
    appendDebugLog('[뷰어 닫기]');
    clearViewerState();

    if (fileInputRef) {
      fileInputRef.value = '';
    }

    renderUploadPlaceholder();
  }

  function clearViewerState() {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }

    if (currentPdfDocument) {
      currentPdfDocument.destroy?.();
      currentPdfDocument = null;
    }

    currentViewerType = null;
  }

  function isPdfFile(file) {
    const fileName = file.name?.toLowerCase() || '';
    return file.type === 'application/pdf' || fileName.endsWith('.pdf');
  }

  function getExtension(fileName) {
    const parts = fileName.toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
  }

  function appendDebugLog(message) {
    debugMessages.push(message);
    console.log(message);
    renderDebugLog();
  }

  function debugViewerMetrics() {
    const viewerBody = previewArea.querySelector('.viewer-body, .pdfjs-viewer-body');
    const pdfViewer = previewArea.querySelector('.pdf-viewer, #pdfCanvas');
    const parentContainer = previewArea.parentElement;

    appendDebugLog(`[uploadBox 높이] ${Math.round(previewArea.getBoundingClientRect().height)}`);
    appendDebugLog(`[viewer-body 높이] ${Math.round(viewerBody?.getBoundingClientRect().height || 0)}`);
    appendDebugLog(`[pdf-viewer 높이] ${Math.round(pdfViewer?.getBoundingClientRect().height || 0)}`);
    appendDebugLog(`[부모 컨테이너 높이] ${Math.round(parentContainer?.getBoundingClientRect().height || 0)}`);
  }

  function renderDebugLog() {
    const debugLog = previewArea.querySelector('#debugLog');
    if (!debugLog) {
      return;
    }

    debugLog.innerHTML = debugMessages
      .map((message) => `<div class="debug-log-entry">${escapeHtml(message)}</div>`)
      .join('');
    debugLog.scrollTop = debugLog.scrollHeight;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initializeDocumentViewer();
  console.log('DocPilot document viewer initialized');
  if (chatForm) {
    chatForm.addEventListener('submit', handleChatSubmit);
  }
});
