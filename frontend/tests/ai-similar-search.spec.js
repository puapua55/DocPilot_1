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
  const searchTableLayout = await page.locator('.chat-search-table--search').evaluate((table) => {
    const cells = Array.from(table.querySelector('tbody tr').cells);
    const wrap = table.closest('.chat-search-table-wrap');
    return {
      fits: table.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 1,
      pageWidth: cells[0].getBoundingClientRect().width,
      textWidth: cells[2].getBoundingClientRect().width,
      keywordWidth: cells[3].getBoundingClientRect().width
    };
  });
  expect(searchTableLayout.fits).toBe(true);
  expect(searchTableLayout.pageWidth).toBeGreaterThanOrEqual(84);
  expect(Math.abs(searchTableLayout.textWidth - searchTableLayout.keywordWidth)).toBeLessThanOrEqual(1);
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

test('chat text change results show list positions and navigate to the selected match', async ({ page }) => {
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      answer: '변경할 대상을 확인해주세요.',
      intent: 'batch-replace',
      action: { type: 'batch-replace', originalText: '프로젝트', newText: '작업', all: false, targets: [] }
    })
  }));
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'replace-results.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createDocx()
  });
  await expect(page.locator('.docx-content')).toContainText('프로젝트 일상');
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.locator('.chat-input').fill('프로젝트를 작업으로 바꿔줘');
  await page.locator('.chat-input').press('Enter');

  const table = page.locator('.chat-search-table--replace');
  await expect(table.locator('th')).toHaveText(['번호', '페이지', '위치', '찾는 텍스트', '변경할 텍스트']);
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').first().locator('td').first()).toHaveText('1');
  await table.locator('tbody tr').nth(1).locator('td').last().click();
  await expect(page.locator('.docx-search-current')).toHaveCount(1);
});

test('offline chat highlights every matching word when no page is specified', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'offline-highlight.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createDocx()
  });
  await expect(page.locator('.docx-content')).toContainText('프로젝트 일상');
  await page.getByRole('button', { name: 'AI ON' }).click();
  await expect(page.getByRole('button', { name: 'AI OFF' })).toBeVisible();
  await page.locator('.chat-input').fill('프로젝트를 하이라이트 표시');
  await page.locator('.chat-input').press('Enter');
  await page.getByRole('button', { name: '하이라이트 실행' }).click();
  await expect(page.locator('.docx-highlight')).toHaveCount(3);
});

test('offline chat saves a DOCX with the requested filename', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'source.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createDocx()
  });
  await expect(page.locator('.docx-content')).toContainText('프로젝트 일상');
  await page.getByRole('button', { name: 'AI ON' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.chat-input').fill('최종보고서.docx로 저장해줘');
  await page.locator('.chat-input').press('Enter');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('최종보고서.docx');
});

test('offline chat limits search results to the requested PDF page', async ({ page }) => {
  const pdf = new jsPDF();
  pdf.text('Project first page', 20, 20);
  pdf.addPage();
  pdf.text('Project second page', 20, 20);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'search-pages.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'AI ON' }).click();
  await page.locator('.chat-input').fill('2페이지에서 Project를 찾아줘');
  await page.locator('.chat-input').press('Enter');
  const rows = page.locator('.chat-search-table--search tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('td').first()).toHaveText('2페이지');
});

test('offline chat applies an explicit all replacement to the open DOCX', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'replace-all.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createDocx()
  });
  await expect(page.locator('.docx-content')).toContainText('프로젝트 일상');
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByRole('button', { name: 'AI ON' }).click();
  await page.locator('.chat-input').fill('프로젝트를 사업으로 모두 변경해줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.docx-content')).not.toContainText('프로젝트');
  await expect(page.locator('.docx-content')).toContainText('사업 일상');
});

test('offline chat opens PDF preview with the requested filename', async ({ page }) => {
  const pdf = new jsPDF();
  pdf.text('Project', 20, 20);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'source.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'AI ON' }).click();
  await page.locator('.chat-input').fill('파일명을 최종본으로 해서 PDF로 저장해줘');
  await page.locator('.chat-input').press('Enter');
  const preview = page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('최종본.pdf');
});

test('offline chat highlights only the requested PDF page', async ({ page }) => {
  const pdf = new jsPDF();
  pdf.text('Project first page', 20, 20);
  pdf.addPage();
  pdf.text('Project second page', 20, 20);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'highlight-pages.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'AI ON' }).click();
  await page.locator('.chat-input').fill('2페이지의 Project를 하이라이트해줘');
  await page.locator('.chat-input').press('Enter');
  await page.getByRole('button', { name: '하이라이트 실행' }).click();
  await expect(page.locator('.chat-feed')).toContainText('적용 건수: 1건');
  await expect(page.locator('.chat-feed')).toContainText('적용 위치: 2페이지');
});

test('offline chat confirms reset and can redo the previous DOCX change', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'history.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createDocx()
  });
  await expect(page.locator('.docx-content')).toContainText('프로젝트 일상');
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByRole('button', { name: 'AI ON' }).click();
  await page.locator('.chat-input').fill('프로젝트를 사업으로 모두 변경해줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.docx-content')).toContainText('사업 일상');
  await expect(page.getByRole('button', { name: '적용 전으로 되돌리기' })).toBeEnabled();

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.chat-input').fill('전체 초기화해줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.chat-feed')).toContainText('문서의 편집 내용을 전체 초기화했습니다.');
  await expect(page.locator('.docx-content')).toContainText('프로젝트 일상');
  await expect(page.getByRole('button', { name: '다시 적용하기' })).toBeEnabled();
  await page.locator('.chat-input').fill('다시 실행해줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.chat-feed')).toContainText('되돌린 문서 변경을 다시 적용했습니다.');
  await expect(page.locator('.docx-content')).toContainText('사업 일상');
});

test('PDF chat width fit resets zoom like the viewer button', async ({ page }) => {
  const pdf = new jsPDF();
  pdf.text('Project', 20, 20);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'fit.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'AI ON' }).click();
  const initialZoom = await page.locator('.zoom-value').textContent();
  await page.locator('.chat-input').fill('150%로 확대해줘');
  await page.locator('.chat-input').press('Enter');
  await expect.poll(() => page.locator('.zoom-value').textContent()).not.toBe(initialZoom);
  await page.locator('.chat-input').fill('너비 맞춤으로 바꿔줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.zoom-value')).toHaveText(initialZoom);
  await expect(page.locator('.chat-feed')).toContainText('너비 맞춤을 적용했습니다.');
  await expect(page.getByRole('button', { name: '맞춤 방식: 너비에 맞춤' })).toBeVisible();
});

test('chat explains unavailable DOCX fit and PDF to DOCX download', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'fit.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await createDocx()
  });
  await expect(page.locator('.docx-content')).toContainText('프로젝트 일상');
  await page.getByRole('button', { name: 'AI ON' }).click();
  await page.locator('.chat-input').fill('너비 맞춤으로 바꿔줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.chat-feed')).toContainText('지원되지 않는 기능입니다.');

  await page.goto('/');
  const pdf = new jsPDF();
  pdf.text('Project', 20, 20);
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await page.locator('.chat-input').fill('DOCX로 다운로드해줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.chat-feed .chat-bubble').last()).toHaveText('지원되지 않는 기능입니다.');
});

test('PDF chat reset uses the same edit history as the reset button', async ({ page }) => {
  const pdf = new jsPDF();
  pdf.text('Project', 20, 20);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'reset.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'AI ON' }).click();
  await page.locator('.chat-input').fill('Project를 하이라이트해줘');
  await page.locator('.chat-input').press('Enter');
  await page.getByRole('button', { name: '하이라이트 실행' }).click();
  await expect(page.locator('.chat-feed')).toContainText('적용 건수: 1건');
  await page.locator('.chat-input').fill('전체 초기화해줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.chat-feed')).toContainText('문서의 편집 내용을 전체 초기화했습니다.');
  await page.locator('.chat-input').fill('다시 실행해줘');
  await page.locator('.chat-input').press('Enter');
  await expect(page.locator('.chat-feed')).toContainText('되돌린 문서 변경을 다시 적용했습니다.');
});
