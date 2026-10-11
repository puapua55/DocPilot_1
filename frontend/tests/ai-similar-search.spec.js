import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';

async function createDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word').file('document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>프로젝트 일정</w:t></w:r></w:p><w:p><w:r><w:t>프로젝트 일상</w:t></w:r></w:p><w:p><w:r><w:t>프로젝트 예산</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('chat asks similar text one at a time and searches the accepted text locally', async ({ page }) => {
  let chatRequests = 0;
  await page.route('**/api/chat', async (route) => {
    chatRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        answer: '검색을 준비했습니다.',
        intent: 'search',
        action: { type: 'search', keyword: '프로젝트 일쩡' }
      })
    });
  });
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'similar.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createDocx()
  });
  await expect(page.locator('.docx-content')).toContainText('프로젝트 일정');

  await page.locator('.chat-input').fill('프로젝트 일쩡 찾아줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.getByText("찾으려는 텍스트가 '프로젝트 일정'인가요?")).toBeVisible();
  await page.getByRole('button', { name: '아니요' }).click();
  await expect(page.getByText("찾으려는 텍스트가 '프로젝트 일상'인가요?")).toBeVisible();
  await page.locator('.chat-input').fill('맞아요');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.chat-search-result-row')).toHaveCount(1);
  await expect(page.locator('.chat-search-result-row')).toContainText('프로젝트 일상');
  expect(chatRequests).toBe(1);
});

test('PDF chat suggestion uses the ordinary exact search when accepted', async ({ page }) => {
  let chatRequests = 0;
  await page.route('**/api/chat', async (route) => {
    chatRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        answer: 'Searching.',
        intent: 'search',
        action: { type: 'search', keyword: 'Project timline' }
      })
    });
  });
  const pdf = new jsPDF();
  pdf.text('Project timeline', 20, 20);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'similar.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await page.locator('.chat-input').fill('Find Project timline');
  await page.locator('.chat-input').press('Enter');
  await expect(page.getByText("찾으려는 텍스트가 'Project timeline'인가요?")).toBeVisible();
  await page.getByRole('button', { name: '맞아요' }).click();
  await expect(page.locator('.chat-search-result-row')).toHaveCount(1);
  expect(chatRequests).toBe(1);
});
