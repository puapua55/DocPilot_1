import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test('full and selected-page PDF downloads wait for scroll preview confirmation', async ({ page }) => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (const [index, width] of [501, 502, 503].entries()) {
    const sheet = source.addPage([width, 600]);
    sheet.drawText(`Preview page ${index + 1}`, { x: 48, y: 520, size: 25, font });
  }
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'preview-source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  await expect(page.locator('.pdf-page')).toHaveCount(3);

  let downloadCount = 0;
  page.on('download', () => { downloadCount += 1; });
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  const fullPreview = page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' });
  await expect(fullPreview).toBeVisible();
  await expect(fullPreview.locator('.pdf-download-preview-page')).toHaveCount(3);
  await expect(fullPreview.locator('.pdf-download-preview-page').first()).toHaveAttribute('data-rendered', 'true');
  expect(await fullPreview.locator('.pdf-download-preview-scroll').evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.screenshot({ path: 'test-results/pdf-download-preview.png' });
  expect(downloadCount).toBe(0);
  await fullPreview.getByRole('button', { name: '취소' }).click();
  await expect(fullPreview).toHaveCount(0);
  expect(downloadCount).toBe(0);

  const fullDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인' }).click();
  const fullFile = await fullDownload;
  expect(fullFile.suggestedFilename()).toBe('preview-source.pdf');
  const fullResult = await PDFDocument.load(await readFile(await fullFile.path()));
  expect(fullResult.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([501, 502, 503]);

  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('textbox', { name: '추출할 PDF 페이지 범위' }).fill('2-3');
  await page.getByRole('button', { name: '선택 페이지 추출' }).click();
  const extractPreview = page.getByRole('dialog', { name: '페이지 추출 미리보기' });
  await expect(extractPreview.locator('.pdf-download-preview-page')).toHaveCount(2);
  await expect(extractPreview.locator('.pdf-download-preview-page').first()).toHaveAttribute('data-rendered', 'true');
  expect(downloadCount).toBe(1);
  const extractDownload = page.waitForEvent('download');
  await extractPreview.getByRole('button', { name: '확인' }).click();
  const extractedFile = await extractDownload;
  expect(extractedFile.suggestedFilename()).toBe('preview-source_pages_2-3.pdf');
  const extractedResult = await PDFDocument.load(await readFile(await extractedFile.path()));
  expect(extractedResult.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([502, 503]);
});
