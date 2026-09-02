import { test, expect } from '@playwright/test';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';

async function interceptChat(page) {
  const requests = [];

  await page.route('**/api/chat', async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    requests.push(body);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        answer: body.documentText
          ? '제공된 문서 기준으로 답변했습니다.'
          : '일반 질문에 답변했습니다.'
      })
    });
  });

  return requests;
}

async function sendChatMessage(page, message) {
  const input = page.getByPlaceholder('DocPilot AI에게 질문해보세요.');
  await input.fill(message);
  await input.press('Enter');
  await expect(page.getByText(/답변했습니다/)).toBeVisible();
}

function createPdfBuffer() {
  const pdf = new jsPDF();
  pdf.text('DocPilot PDF test document', 20, 20);
  pdf.text('test keyword appears twice: test test', 20, 30);
  pdf.text('Important sentence is on page one.', 20, 40);
  return Buffer.from(pdf.output('arraybuffer'));
}

async function createDocxBuffer() {
  const zip = new JSZip();

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>DocPilot DOCX test document</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트 단어가 두 번 있습니다. 테스트 테스트</w:t></w:r></w:p>
    <w:p><w:r><w:t>계약 기간과 금액 정보는 없습니다.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function uploadFile(page, file) {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(file);
}

test('문서 없이 일반 질문은 빈 documentText로 전송된다', async ({ page }) => {
  const requests = await interceptChat(page);
  await page.goto('/');

  await sendChatMessage(page, '안녕');

  expect(requests).toHaveLength(1);
  expect(requests[0].documentText).toBe('');
  expect(requests[0].documentName).toBe('');
});

test('PDF 업로드 후 AI 질문은 페이지 번호가 포함된 PDF 텍스트를 전송한다', async ({ page }) => {
  const requests = await interceptChat(page);
  await page.goto('/');

  await uploadFile(page, {
    name: 'ai-document-test.pdf',
    mimeType: 'application/pdf',
    buffer: createPdfBuffer()
  });

  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await sendChatMessage(page, '이 문서 요약해줘');

  expect(requests).toHaveLength(1);
  const body = requests[0];
  expect(body.documentName).toBe('ai-document-test.pdf');
  expect(body.documentType).toBe('pdf');
  expect(body.documentText.length).toBeGreaterThan(0);
  expect(body.documentText).toContain('[1페이지]');
  expect(body.documentText).toContain('DocPilot PDF test document');

  await expect(page.getByText('정확한 문서 검색', { exact: true })).toBeVisible();
  await expect(page.getByText('위치 하이라이트', { exact: true })).toBeVisible();
  await expect(page.getByText('즉시 텍스트 교체', { exact: true })).toBeVisible();
});

test('DOCX 업로드 후 AI 질문은 렌더링된 DOCX 텍스트를 전송한다', async ({ page }) => {
  const requests = await interceptChat(page);
  await page.goto('/');

  await uploadFile(page, {
    name: 'ai-document-test.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createDocxBuffer()
  });

  await expect(page.locator('.word-document')).toBeVisible();
  await sendChatMessage(page, '이 문서에 테스트라는 단어가 있어?');

  expect(requests).toHaveLength(1);
  const body = requests[0];
  expect(body.documentName).toBe('ai-document-test.docx');
  expect(body.documentType).toBe('word');
  expect(body.documentText.length).toBeGreaterThan(0);
  expect(body.documentText).toContain('DocPilot DOCX test document');
  expect(body.documentText).toContain('테스트');
  expect(body.documentText).toContain('계약 기간과 금액 정보는 없습니다.');

  await expect(page.getByText('정확한 문서 검색', { exact: true })).toBeVisible();
  await expect(page.getByText('위치 하이라이트', { exact: true })).toBeVisible();
  await expect(page.getByText('즉시 텍스트 교체', { exact: true })).toBeVisible();
});
