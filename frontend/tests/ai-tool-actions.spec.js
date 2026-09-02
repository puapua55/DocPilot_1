import { test, expect } from '@playwright/test';
import JSZip from 'jszip';

async function createDocxBuffer() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>테스트 문서입니다. 테스트 항목입니다.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function mockChat(page) {
  await page.route('**/api/chat', async (route) => {
    const { message } = route.request().postDataJSON();
    let payload = { answer: '일반 답변', intent: 'question_answer', action: null };
    if (message.includes('찾아')) payload = { answer: "'테스트' 검색을 준비했습니다. 버튼을 눌러 실행하세요.", intent: 'search', action: { type: 'search', keyword: '테스트' } };
    if (message.includes('하이라이트')) payload = { answer: "'테스트' 하이라이트를 준비했습니다. 버튼을 눌러 실행하세요.", intent: 'highlight', action: { type: 'highlight', keyword: '테스트' } };
    if (message.includes('바꿔')) payload = { answer: '치환 작업을 준비했습니다. 실행 방식을 선택하세요.', intent: 'replace', action: { type: 'replace', originalText: '테스트', newText: '시험' } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

async function send(page, text) { const input = page.getByPlaceholder('DocPilot AI에게 질문해보세요.'); await input.fill(text); await input.press('Enter'); }
async function uploadDocx(page) { await page.locator('input[type="file"]').first().setInputFiles({ name: 'tool-action.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await createDocxBuffer() }); await expect(page.locator('.word-document')).toBeVisible(); }

test.beforeEach(async ({ page }) => { await mockChat(page); await page.goto('/'); });

test('search action card waits for approval and records result', async ({ page }) => {
  await uploadDocx(page); await send(page, '테스트 찾아줘');
  const card = page.locator('.ai-action-card[data-action-type="search"]');
  await expect(card).toContainText('작업 준비됨'); await expect(card).toContainText('문서 검색'); await expect(card).toContainText('검색어'); await expect(card).toContainText('테스트'); await expect(card).toContainText('tool-action.docx');
  const button = page.getByRole('button', { name: '검색 실행' }); await expect(button).toBeVisible(); await button.click();
  await expect(page.getByText(/검색 결과: 1건/)).toBeVisible();
});

test('highlight action card waits for approval and records count', async ({ page }) => {
  await uploadDocx(page); await send(page, '테스트 하이라이트해줘');
  const card = page.locator('.ai-action-card[data-action-type="highlight"]');
  await expect(card).toContainText('위치 하이라이트'); await expect(card).toContainText('대상 단어'); await expect(card).toContainText('테스트');
  await page.getByRole('button', { name: '하이라이트 실행' }).click();
  await expect(page.locator('.docx-highlight')).toHaveCount(2); await expect(page.getByText(/적용 건수: 2건/)).toBeVisible();
});

test('replace action card waits for approval then changes only viewer DOM', async ({ page }) => {
  await uploadDocx(page); await send(page, '테스트를 시험으로 바꿔줘');
  const card = page.locator('.ai-action-card[data-action-type="replace"]');
  await expect(card).toContainText('텍스트 치환'); await expect(card).toContainText('기존 단어'); await expect(card).toContainText('변경 단어'); await expect(card).toContainText('시험');
  await expect(page.getByRole('button', { name: '화면에 적용' })).toBeVisible(); await expect(page.getByRole('button', { name: '변환 파일 다운로드' })).toBeVisible();
  await page.getByRole('button', { name: '화면에 적용' }).click();
  await expect(page.locator('.word-document')).toContainText('시험 문서입니다. 시험 항목입니다.'); await expect(page.getByText(/적용 건수: 2건/)).toBeVisible();
});

test('replace convert prevents duplicate click and records downloaded file name', async ({ page }) => {
  await uploadDocx(page); await send(page, '테스트를 시험으로 바꿔줘');
  const button = page.getByRole('button', { name: '변환 파일 다운로드' }); const downloadPromise = page.waitForEvent('download'); await button.click();
  await expect(page.getByRole('button', { name: '변환 파일 생성 중...' })).toBeDisabled();
  const download = await downloadPromise; expect(download.suggestedFilename()).toBe('tool-action_docx_converted.docx');
  const buffer = await (await import('node:fs/promises')).readFile(await download.path()); const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const documentXml = await zip.file('word/document.xml').async('string'); const stylesXml = await zip.file('word/styles.xml').async('string');
  expect(documentXml).toContain('시험'); expect(documentXml).not.toContain('테스트'); expect(stylesXml).toContain('TableGrid');
  await expect(page.getByText(/파일명: tool-action_docx_converted\.docx/)).toBeVisible();
});

test('document action is not exposed without a selected document', async ({ page }) => {
  await send(page, '테스트 찾아줘'); await expect(page.getByText('현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.')).toBeVisible(); await expect(page.getByRole('button', { name: '검색 실행' })).toHaveCount(0);
});
