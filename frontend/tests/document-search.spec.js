import { test, expect } from '@playwright/test';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';

async function createSearchDocxBuffer() {
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
    <w:p><w:r><w:t>테스트1</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트2</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트3</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트</w:t></w:r></w:p>
    <w:p><w:r><w:t>검색과 무관한 문단</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

function createSearchPdfBuffer() {
  const pdf = new jsPDF();
  pdf.text('DocPilot first page', 20, 20);
  pdf.text('search target alpha', 20, 30);
  pdf.addPage();
  pdf.text('DocPilot second page', 20, 20);
  pdf.text('search target beta', 20, 30);
  return Buffer.from(pdf.output('arraybuffer'));
}

async function openSearch(page) {
  await page.getByText('정확한 문서 검색', { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function upload(page, file) {
  await page.locator('input[type="file"]').first().setInputFiles(file);
}

test('문서 없음 상태에서 검색 안내를 표시한다', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  await expect(page.getByText('현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.')).toBeVisible();
  await expect(page.getByText('검색 결과: 총')).toBeVisible();
});

test('DOCX 포함 검색과 정확히 일치 검색을 구분한다', async ({ page }) => {
  await page.goto('/');
  await upload(page, {
    name: '테스트1.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createSearchDocxBuffer()
  });
  await expect(page.locator('.word-document')).toBeVisible();

  await openSearch(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('테스트1.docx', { exact: true })).toBeVisible();
  await expect(dialog.getByText('DOCX', { exact: true })).toBeVisible();

  const input = page.getByPlaceholder('검색어를 입력하세요');
  await input.fill('테스트');
  await page.getByRole('button', { name: '검색', exact: true }).click();

  await expect(page.getByText('총 4건을 찾았습니다.')).toBeVisible();
  await expect(page.locator('.search-result-row')).toHaveCount(4);
  await expect(page.locator('.search-result-row').first()).toContainText('1페이지');
  await expect(page.locator('.search-result-row').first()).toContainText('문단 1');
  await expect(page.locator('.search-result-row').first()).toContainText('테스트1');

  await page.getByLabel('정확히 일치').check();
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByText('총 1건을 찾았습니다.')).toBeVisible();
  await expect(page.locator('.search-result-row')).toHaveCount(1);
  await expect(page.locator('.search-result-row').first()).toContainText('테스트');
});

test('DOCX 결과 클릭은 active row와 viewer current 위치를 표시하고 초기화한다', async ({ page }) => {
  await page.goto('/');
  await upload(page, {
    name: 'search-click.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createSearchDocxBuffer()
  });
  await expect(page.locator('.word-document')).toBeVisible();

  await openSearch(page);
  await page.getByPlaceholder('검색어를 입력하세요').fill('테스트2');
  await page.getByRole('button', { name: '검색', exact: true }).click();

  const row = page.locator('.search-result-row').first();
  await row.click();
  await expect(row).toHaveClass(/active/);
  await expect(page.locator('.docx-search-current')).toHaveCount(1);

  await page.getByRole('button', { name: '초기화' }).click();
  await expect(page.locator('.search-result-row')).toHaveCount(0);
  await expect(page.locator('.docx-search-current')).toHaveCount(0);
  await expect(page.getByPlaceholder('검색어를 입력하세요')).toHaveValue('');
});

test('PDF 검색 결과에 실제 1페이지와 2페이지 및 줄 위치를 표시한다', async ({ page }) => {
  await page.goto('/');
  await upload(page, {
    name: 'search-pages.pdf',
    mimeType: 'application/pdf',
    buffer: createSearchPdfBuffer()
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();

  await openSearch(page);
  await expect(page.getByText('PDF', { exact: true })).toBeVisible();
  await page.getByPlaceholder('검색어를 입력하세요').fill('search target');
  await page.getByRole('button', { name: '검색', exact: true }).click();

  await expect(page.getByText('총 2건을 찾았습니다.')).toBeVisible();
  const rows = page.locator('.search-result-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('1페이지');
  await expect(rows.nth(0)).toContainText(/줄 \d+/);
  await expect(rows.nth(1)).toContainText('2페이지');

  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveClass(/active/);
});
