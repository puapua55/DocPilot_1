import { test, expect } from '@playwright/test';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';

async function interceptChat(page) {
  const requests = [];
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const isHighlight = body.message.includes('하이라이트');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        answer: isHighlight ? '하이라이트를 준비했습니다.' : '검색을 준비했습니다.',
        intent: isHighlight ? 'highlight' : 'search',
        action: isHighlight
          ? { type: 'highlight', keyword: '테스트' }
          : { type: 'search', keyword: 'test' }
      })
    });
  });
  return requests;
}

function createPdfBuffer() {
  const pdf = new jsPDF();
  pdf.text('DocPilot PDF test document', 20, 20);
  pdf.text('test keyword appears twice: test test', 20, 30);
  return Buffer.from(pdf.output('arraybuffer'));
}

async function createDocxBuffer() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DocPilot DOCX test document</w:t></w:r></w:p><w:p><w:r><w:t>테스트 단어가 있습니다.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function uploadFile(page, file) {
  await page.locator('input[type="file"]').first().setInputFiles(file);
}

async function sendDocumentAction(page, message) {
  const input = page.locator('.chat-input');
  await input.fill(message);
  await input.press('Enter');
}

test('문서를 선택하기 전에는 채팅 입력을 제한한다', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.chat-input')).toBeDisabled();
  await expect(page.getByText('문서 작업 요청만 지원합니다.')).toBeVisible();
});

test('PDF 문서 작업 요청만 Gemini 연결 경로로 전송한다', async ({ page }) => {
  const requests = await interceptChat(page);
  await page.goto('/');
  await uploadFile(page, { name: 'ai-document-test.pdf', mimeType: 'application/pdf', buffer: createPdfBuffer() });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await sendDocumentAction(page, 'test를 정확히 검색해줘');
  await expect(page.getByText('검색을 준비했습니다.')).toBeVisible();

  expect(requests).toHaveLength(1);
  expect(requests[0].documentName).toBe('ai-document-test.pdf');
  expect(requests[0].documentType).toBe('pdf');
  expect(requests[0].documentText).toContain('[1페이지]');
});

test('일반 채팅 응답은 문서 작업 전용 안내로 대체한다', async ({ page }) => {
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ answer: '일반 답변', intent: 'question_answer', action: null })
  }));
  await page.goto('/');
  await uploadFile(page, { name: 'ai-document-test.pdf', mimeType: 'application/pdf', buffer: createPdfBuffer() });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await sendDocumentAction(page, '이 문서를 요약해줘');
  await expect(page.getByText('채팅은 정확한 문서 검색, 위치 하이라이트, 즉시 텍스트 교체 요청에만 사용할 수 있습니다.')).toBeVisible();
});

test('DOCX 문서 작업 요청은 문서 텍스트와 함께 전송한다', async ({ page }) => {
  const requests = await interceptChat(page);
  await page.goto('/');
  await uploadFile(page, { name: 'ai-document-test.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await createDocxBuffer() });
  await expect(page.locator('.word-document')).toBeVisible();
  await sendDocumentAction(page, '테스트를 하이라이트해줘');
  await expect(page.getByText('하이라이트를 준비했습니다.')).toBeVisible();

  expect(requests).toHaveLength(1);
  expect(requests[0].documentType).toBe('word');
  expect(requests[0].documentText).toContain('테스트');
});
