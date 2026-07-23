const fileInput = document.getElementById('fileInput');
const uploadTitle = document.getElementById('uploadTitle');
const uploadSubtitle = document.getElementById('uploadSubtitle');
const uploadMeta = document.getElementById('uploadMeta');
const dropZone = document.getElementById('dropZone');
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
  chatWindow.appendChild(row);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function handleFiles(files) {
  const file = files?.[0];
  if (!file) return;

  const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!allowedTypes.includes(file.type)) {
    alert('PDF 또는 DOCX 파일만 선택할 수 있습니다.');
    return;
  }

  uploadTitle.textContent = file.name;
  uploadSubtitle.textContent = `${file.name} 업로드 준비 완료`;
  uploadMeta.innerHTML = `
    <span>📄 ${formatFileSize(file.size)}</span>
    <span>✅ 선택된 파일: ${file.name}</span>
  `;
}

fileInput.addEventListener('change', (event) => {
  handleFiles(event.target.files);
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(event.dataTransfer.files);
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = chatInput.value.trim();
  if (!value) return;

  addMessage(value, true);
  chatInput.value = '';

  setTimeout(() => {
    addMessage('요청 내용을 확인했습니다. 테스트 화면에서는 실제 AI 응답 대신 이 메시지가 표시됩니다.', false);
  }, 350);
});
