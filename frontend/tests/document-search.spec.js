import { test, expect } from '@playwright/test';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';

async function createSearchDocxBuffer(body = `
    <w:p><w:r><w:t>테스트1</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트2</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트3</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트</w:t></w:r></w:p>
    <w:p><w:r><w:t>검색과 무관한 문단</w:t></w:r></w:p>
`) {
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
    ${body}
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

test('DOCX 표 셀의 검색 결과는 중복되지 않고 표 폭과 문단 정렬을 반영한다', async ({ page }) => {
  await page.goto('/');
  await upload(page, {
    name: 'table-layout.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createSearchDocxBuffer(`
      <w:tbl>
        <w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr>
        <w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>
        <w:tr>
          <w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>중복 값 1</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>중복 값 2</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `)
  });
  await expect(page.locator('.word-document')).toBeVisible();

  const table = page.locator('.word-document table');
  await expect(table).toHaveAttribute('data-docx-table-width', 'true');
  await expect(table).toHaveAttribute('style', /width: 624px/);
  await expect(page.getByText('중복 값 1', { exact: true })).toHaveCSS('text-align', 'center');
  await expect(page.getByText('중복 값 2', { exact: true })).toHaveCSS('text-align', 'right');

  await openSearch(page);
  await page.getByPlaceholder('검색어를 입력하세요').fill('중복');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.locator('.search-result-row')).toHaveCount(2);
});

test('빈 문단 뒤의 다음 페이지 표에도 원본 문단 정렬을 적용한다', async ({ page }) => {
  await page.goto('/');
  await upload(page, {
    name: 'later-page-table.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createSearchDocxBuffer(`
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>첫 페이지 표</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      ${'<w:p></w:p>'.repeat(8)}
      <w:tbl><w:tr>
        <w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>두번째 가운데</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>두번째 오른쪽</w:t></w:r></w:p></w:tc>
      </w:tr></w:tbl>
    `)
  });

  await expect(page.getByText('두번째 가운데', { exact: true })).toHaveCSS('text-align', 'center');
  await expect(page.getByText('두번째 오른쪽', { exact: true })).toHaveCSS('text-align', 'right');
});

test('표 사이의 긴 빈 문단 구간은 실제 빈 페이지로 유지한다', async ({ page }) => {
  await page.goto('/');
  await upload(page, {
    name: 'blank-page.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createSearchDocxBuffer(`
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>첫 표</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      ${'<w:p></w:p>'.repeat(37)}
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>세번째 페이지 표</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    `)
  });

  const pages = page.locator('.word-document');
  await expect(pages).toHaveCount(3);
  await expect(pages.nth(1)).toHaveText('');
  await expect(pages.nth(2)).toContainText('세번째 페이지 표');

  const viewControls = page.getByRole('group', { name: '보기 방식 선택' });
  await expect(viewControls).toBeVisible();
  await viewControls.getByRole('button', { name: '페이지 이동' }).click();
  await expect(page.locator('.docx-page-frame:not([hidden]) .word-document')).toHaveCount(1);
  await expect(page.locator('.docx-current-page-indicator')).toHaveText('1 / 3');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.locator('.docx-current-page-indicator')).toHaveText('2 / 3');
  const pageInput = page.getByLabel('이동할 페이지');
  await pageInput.fill('3');
  await pageInput.press('Enter');
  await expect(page.locator('.docx-current-page-indicator')).toHaveText('3 / 3');
  await pageInput.fill('9');
  await pageInput.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('현재 문서에 존재하지 않는 페이지입니다.');
  await viewControls.getByRole('button', { name: '스크롤' }).click();
  await expect(page.locator('.docx-page-frame:not([hidden]) .word-document')).toHaveCount(3);
});

test('모달은 배경을 클릭해도 닫히지 않고 X 버튼으로만 닫힌다', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);

  await page.locator('.modal-backdrop').click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.getByRole('button', { name: '검색 모달 닫기' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
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
