import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';

async function createDocxBuffer() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>테스트1</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트2</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트3</w:t></w:r></w:p>
    <w:p><w:r><w:t>테스트</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`);
  zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

function createPdfBuffer() {
  const pdf = new jsPDF();
  pdf.text('replace target1', 20, 30);
  pdf.addPage();
  pdf.text('replace target', 20, 30);
  return Buffer.from(pdf.output('arraybuffer'));
}

async function uploadDocx(page, name = 'replace-test.docx') {
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await createDocxBuffer()
  });
  await expect(page.locator('.word-document')).toBeVisible();
}

async function uploadPdf(page) {
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'replace-test.pdf',
    mimeType: 'application/pdf',
    buffer: createPdfBuffer()
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
}

async function openReplace(page) {
  await page.getByRole('button', { name: /즉시 텍스트 교체/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function fillReplace(page, originalText, newText) {
  await page.getByLabel('기존 단어').fill(originalText);
  await page.getByLabel('변경 단어').fill(newText);
}

test('문서 없음과 입력값 오류 안내를 표시한다', async ({ page }) => {
  await page.goto('/');
  await openReplace(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('현재 선택된 문서가 없습니다. 먼저 PDF 또는 DOCX 파일을 업로드해주세요.')).toBeVisible();
  await page.getByRole('button', { name: '텍스트 교체 모달 닫기' }).click();

  await uploadDocx(page);
  await openReplace(page);
  await page.getByRole('button', { name: '대상 확인' }).click();
  await expect(page.getByRole('dialog').getByText('교체할 기존 단어를 입력해주세요.')).toBeVisible();

  await page.getByLabel('기존 단어').fill('테스트');
  await page.getByRole('button', { name: '대상 확인' }).click();
  await expect(page.getByRole('dialog').getByText('변경할 단어를 입력해주세요.')).toBeVisible();
});

test('DOCX 대상 확인은 화면과 파일을 변경하지 않는다', async ({ page }) => {
  await page.goto('/');
  await uploadDocx(page);
  let downloadCount = 0;
  page.on('download', () => { downloadCount += 1; });

  await openReplace(page);
  await fillReplace(page, '테스트', '시험');
  await page.getByRole('button', { name: '대상 확인' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('총 4건의 교체 대상을 찾았습니다.')).toBeVisible();
  await expect(page.locator('.replace-result-row')).toHaveCount(4);
  await expect(page.locator('.replace-result-row').first()).toContainText('1페이지');
  await expect(page.locator('.replace-result-row').first()).toContainText('문단 1');
  await expect(page.locator('.replace-result-row').first()).toContainText('테스트1');
  await expect(page.locator('.replace-result-row').first()).toContainText('시험1');
  await expect(page.locator('.word-document')).toContainText('테스트1');
  await expect(page.locator('.word-document')).not.toContainText('시험1');
  expect(downloadCount).toBe(0);
});

test('DOCX 화면 적용은 현재 뷰어만 바꾸고 정확히 일치를 지원한다', async ({ page }) => {
  await page.goto('/');
  await uploadDocx(page);
  let downloadCount = 0;
  page.on('download', () => { downloadCount += 1; });

  await openReplace(page);
  await fillReplace(page, '테스트', '시험');
  await page.getByLabel('정확히 일치').check();
  await page.getByRole('button', { name: '화면에 적용' }).click();

  await expect(page.getByRole('dialog').getByText('화면에 총 1건을 적용했습니다.')).toBeVisible();
  const viewerText = await page.locator('.word-document').innerText();
  expect(viewerText).toContain('테스트1');
  expect(viewerText).toContain('테스트2');
  expect(viewerText).toContain('테스트3');
  expect(viewerText.split(/\s+/)).toContain('시험');
  expect(downloadCount).toBe(0);
});

test('DOCX 변환 다운로드는 원본 ZIP을 기준으로 실제 파일을 생성하고 exact를 유지한다', async ({ page }) => {
  await page.goto('/');
  await uploadDocx(page, 'exact-convert.docx');
  await openReplace(page);
  await fillReplace(page, '테스트', '시험');
  await page.getByLabel('정확히 일치').check();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '변환 파일 다운로드' }).click();
  await expect(page.getByRole('button', { name: '변환 중...' })).toBeDisabled();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('exact-convert_docx_converted.docx');
  const buffer = await readFile(await download.path());
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const documentXml = await zip.file('word/document.xml').async('string');
  const stylesXml = await zip.file('word/styles.xml').async('string');

  expect(documentXml).toContain('테스트1');
  expect(documentXml).toContain('테스트2');
  expect(documentXml).toContain('테스트3');
  expect(documentXml).toContain('시험');
  expect(stylesXml).toContain('TableGrid');
  await expect(page.getByRole('dialog').getByText(/변환 파일이 생성되었습니다: exact-convert_docx_converted\.docx/)).toBeVisible();
});

test('PDF 대상 확인과 화면 적용은 exact 기준으로 preview overlay만 변경한다', async ({ page }) => {
  await page.goto('/');
  await uploadPdf(page);
  let downloadCount = 0;
  page.on('download', () => { downloadCount += 1; });

  await openReplace(page);
  await fillReplace(page, 'replace target', 'changed');
  await page.getByLabel('정확히 일치').check();
  await page.getByRole('button', { name: '대상 확인' }).click();

  await expect(page.getByRole('dialog').getByText('총 1건의 교체 대상을 찾았습니다.')).toBeVisible();
  await expect(page.locator('.replace-result-row')).toHaveCount(1);
  await expect(page.locator('.replace-result-row').first()).toContainText('2페이지');

  await page.getByRole('button', { name: '화면에 적용' }).click();
  await expect(page.getByRole('dialog').getByText('화면에 총 1건을 적용했습니다.')).toBeVisible();
  await expect(page.locator('.replacement-text')).toHaveCount(1);
  await expect(page.locator('.replacement-text')).toContainText('changed');
  expect(downloadCount).toBe(0);
});

test('PDF 변환 파일 다운로드는 실제 PDF download를 발생시킨다', async ({ page }) => {
  await page.goto('/');
  await uploadPdf(page);
  await openReplace(page);
  await fillReplace(page, 'replace target', 'changed');
  await page.getByLabel('정확히 일치').check();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '변환 파일 다운로드' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('replace-test_html_converted.pdf');
  const buffer = await readFile(await download.path());
  expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  await expect(page.getByRole('dialog').getByText(/변환 파일이 생성되었습니다: replace-test_html_converted\.pdf/)).toBeVisible();
});
