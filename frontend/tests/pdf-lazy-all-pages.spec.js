import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

async function createMultiPagePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 8; pageNumber += 1) {
    const page = pdf.addPage([500, 500]);
    page.drawText(`TARGET STATIC PAGE ${pageNumber}`, { x: 80, y: 400, size: 18, font });
  }
  return Buffer.from(await pdf.save());
}

test('lazy pages preserve all-page highlights and batch replacements', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    window.docPilotFonts = {
      list: async () => [],
      resolve: async () => ({ found: false })
    };
  });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'lazy-pages.pdf',
    mimeType: 'application/pdf',
    buffer: await createMultiPagePdf()
  });
  await expect(page.locator('.pdf-page-viewport-slot')).toHaveCount(8);
  await expect(page.locator('.pdf-page[data-page-number="1"] .textLayer')).toHaveAttribute('data-rendered', 'true');
  expect(await page.locator('.pdf-page').count()).toBeLessThanOrEqual(5);

  await page.locator('.pdf-edit-mode-toggle button').last().click();

  await page.getByText('위치 하이라이트', { exact: true }).click();
  await page.getByLabel('하이라이트할 단어 또는 문장').fill('STATIC');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByText('검색 결과: 총').locator('..')).toContainText('8');
  await page.getByRole('button', { name: '전체 선택', exact: true }).click();
  await page.getByLabel('전체 검색 결과 하이라이트 색상').selectOption('yellow');
  await page.getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByText('8건에 하이라이트를 적용했습니다.')).toBeVisible();
  await page.getByRole('button', { name: '위치 하이라이트 모달 닫기' }).click();

  await page.getByText('텍스트 일괄 변경', { exact: true }).click();
  await page.getByLabel('찾을 텍스트').fill('TARGET');
  await page.getByLabel('변경할 텍스트').fill('CHANGED');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByText('8건을 찾았습니다. 변경할 항목을 선택하세요.')).toBeVisible();
  await page.getByRole('button', { name: '전체 선택', exact: true }).click();
  await page.getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByText('8건을 적용했습니다.')).toBeVisible();
  await page.getByRole('button', { name: '텍스트 일괄 변경 모달 닫기' }).click();

  expect(await page.locator('.pdf-page').count()).toBeLessThanOrEqual(5);
  await page.getByRole('button', { name: '페이지 이동', exact: true }).click();
  const pageInput = page.getByLabel('이동할 페이지 번호');
  await pageInput.fill('8');
  await pageInput.press('Enter');
  const lastPage = page.locator('.pdf-page[data-page-number="8"]');
  await expect(lastPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await expect(lastPage.locator('.movable-text-object')).toContainText('CHANGED');
  await expect(lastPage.locator('.highlight-box')).not.toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.viewer-download-button.pdf').click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인', exact: true }).click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  const saved = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  expect(saved.numPages).toBe(8);
  const savedLastPage = await saved.getPage(8);
  const content = await savedLastPage.getTextContent();
  const savedText = content.items.map((item) => item.str).join(' ');
  expect(savedText).toContain('CHANGED');

  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'lazy-pages-saved.pdf', mimeType: 'application/pdf', buffer: bytes
  });
  await expect(page.locator('.pdf-page-viewport-slot')).toHaveCount(8);
  await page.getByRole('button', { name: '페이지 이동', exact: true }).click();
  const savedPageInput = page.getByLabel('이동할 페이지 번호');
  await savedPageInput.fill('8');
  await savedPageInput.press('Enter');
  const savedCanvas = page.locator('.pdf-page[data-page-number="8"] .pdf-canvas');
  await expect(savedCanvas).toBeVisible();
  const yellowPixels = await savedCanvas.evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 210 && data[index + 1] > 190 && data[index + 2] < 190) count += 1;
    }
    return count;
  });
  expect(yellowPixels).toBeGreaterThan(20);
});
