import { test, expect } from '@playwright/test';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';

async function createHighlightDocxBuffer() {
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

function createHighlightPdfBuffer() {
  const pdf = new jsPDF();
  pdf.text('search target alpha', 20, 30);
  pdf.addPage();
  pdf.text('search target beta', 20, 30);
  return Buffer.from(pdf.output('arraybuffer'));
}

async function upload(page, file) {
  await page.locator('input[type="file"]').first().setInputFiles(file);
}

async function openHighlight(page) {
  await page.getByText('위치 하이라이트', { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function uploadDocx(page, name = '테스트1.docx') {
  await upload(page, {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createHighlightDocxBuffer()
  });
  await expect(page.locator('.word-document')).toBeVisible();
}

test('문서 없음 상태에서 하이라이트 안내를 표시한다', async ({ page }) => {
  await page.goto('/');
  await openHighlight(page);

  await expect(
    page.getByText('현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.')
  ).toBeVisible();
  await expect(page.getByText(/적용 결과: 총/)).toBeVisible();
});

test('DOCX 포함 하이라이트 결과와 위치 목록을 표시한다', async ({ page }) => {
  await page.goto('/');
  await uploadDocx(page);
  await openHighlight(page);

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('테스트1.docx', { exact: true })).toBeVisible();
  await expect(dialog.getByText('DOCX', { exact: true })).toBeVisible();

  await page.getByPlaceholder('하이라이트할 단어 또는 문장을 입력하세요').fill('테스트');
  await page.getByRole('button', { name: '하이라이트 적용' }).click();

  await expect(page.getByRole('dialog').getByText('총 4건을 하이라이트했습니다.')).toBeVisible();
  await expect(page.locator('.docx-highlight')).toHaveCount(4);
  await expect(page.locator('.docx-highlight[data-highlight-color="yellow"]')).toHaveCount(4);

  const rows = page.locator('.highlight-result-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('1페이지');
  await expect(rows.first()).toContainText('문단 1');
  await expect(rows.first()).toContainText('테스트1');
  await expect(rows.first()).toContainText('노랑');

  await rows.first().click();
  await expect(rows.first()).toHaveClass(/active/);
  await expect(page.locator('.docx-highlight-current')).toHaveCount(1);
});

test('DOCX 정확히 일치 하이라이트는 독립된 테스트만 적용한다', async ({ page }) => {
  await page.goto('/');
  await uploadDocx(page, 'highlight-exact.docx');
  await openHighlight(page);

  await page.getByPlaceholder('하이라이트할 단어 또는 문장을 입력하세요').fill('테스트');
  await page.getByLabel('정확히 일치').check();
  await page.getByRole('button', { name: '하이라이트 적용' }).click();

  await expect(page.getByRole('dialog').getByText('총 1건을 하이라이트했습니다.')).toBeVisible();
  await expect(page.locator('.docx-highlight')).toHaveCount(1);
  await expect(page.locator('.docx-highlight')).toHaveText('테스트');
  await expect(page.locator('.highlight-result-row')).toHaveCount(1);
});

test('DOCX 초록 색상과 전체 제거가 동작하며 초기화는 문서 하이라이트를 유지한다', async ({ page }) => {
  await page.goto('/');
  await uploadDocx(page, 'highlight-color.docx');
  await openHighlight(page);

  await page.getByPlaceholder('하이라이트할 단어 또는 문장을 입력하세요').fill('테스트2');
  await page.getByRole('button', { name: '초록' }).click();
  await page.getByRole('button', { name: '하이라이트 적용' }).click();

  await expect(page.locator('.docx-highlight[data-highlight-color="green"]')).toHaveCount(1);
  await expect(page.locator('.highlight-result-row').first()).toContainText('초록');

  await page.getByRole('button', { name: '초기화' }).click();
  await expect(page.locator('.highlight-result-row')).toHaveCount(0);
  await expect(page.locator('.docx-highlight[data-highlight-color="green"]')).toHaveCount(1);
  await expect(page.getByPlaceholder('하이라이트할 단어 또는 문장을 입력하세요')).toHaveValue('');

  await page.getByRole('button', { name: '전체 제거' }).click();
  await expect(page.locator('.docx-highlight')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByText('하이라이트를 모두 제거했습니다.')).toBeVisible();
});

test('PDF 하이라이트 결과에 실제 1페이지와 2페이지 및 색상을 표시한다', async ({ page }) => {
  await page.goto('/');
  await upload(page, {
    name: 'highlight-pages.pdf',
    mimeType: 'application/pdf',
    buffer: createHighlightPdfBuffer()
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();

  await openHighlight(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('PDF', { exact: true })).toBeVisible();

  await page.getByPlaceholder('하이라이트할 단어 또는 문장을 입력하세요').fill('search target');
  await page.getByRole('button', { name: '파랑' }).click();
  await page.getByRole('button', { name: '하이라이트 적용' }).click();

  await expect(page.getByRole('dialog').getByText('총 2건을 하이라이트했습니다.')).toBeVisible();
  const rows = page.locator('.highlight-result-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('1페이지');
  await expect(rows.nth(0)).toContainText(/줄 \d+/);
  await expect(rows.nth(0)).toContainText('파랑');
  await expect(rows.nth(1)).toContainText('2페이지');

  await expect(page.locator('.highlight-box[data-highlight-color="blue"]')).toHaveCount(2);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveClass(/active/);

  await page.getByRole('button', { name: '전체 제거' }).click();
  await expect(page.locator('.highlight-box')).toHaveCount(0);
});

test('PDF 텍스트 레이어에서 드래그로 글자를 선택할 수 있다', async ({ page }) => {
  await page.goto('/');
  await upload(page, {
    name: 'selectable-text.pdf',
    mimeType: 'application/pdf',
    buffer: createHighlightPdfBuffer()
  });

  const text = page.locator('.textLayer span').filter({ hasText: 'search target alpha' }).first();
  await expect(text).toBeVisible();

  const box = await text.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toContain('search target alpha');
});
