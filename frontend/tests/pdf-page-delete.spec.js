import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

test('deleting pages renumbers the viewer and changes subsequent downloads', async ({ page }) => {
  const source = await PDFDocument.create();
  for (let number = 1; number <= 5; number += 1) source.addPage([200 + number, 300]);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'five-pages.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save())
  });
  await expect(page.locator('.pdf-page')).toHaveCount(5);
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('textbox', { name: '삭제할 PDF 페이지 범위' }).fill('2, 4');
  await page.getByRole('button', { name: '선택 페이지 삭제' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(3);
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('button', { name: '적용 전으로 되돌리기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(5);
  await page.getByRole('button', { name: '다시 적용하기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(3);
  await page.getByRole('button', { name: '페이지 이동' }).click();
  await expect(page.getByRole('textbox', { name: '이동할 페이지 번호' })).toHaveValue('1');
  await expect(page.getByRole('status', { name: 'PDF 페이지 위치' })).toContainText('/3');

  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('textbox', { name: '삭제할 PDF 페이지 범위' }).fill('2');
  await page.getByRole('button', { name: '선택 페이지 삭제' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(2);
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('button', { name: '적용 전으로 되돌리기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(3);
  await page.getByRole('button', { name: '적용 전으로 되돌리기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(5);
  await page.getByRole('button', { name: '다시 적용하기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(3);
  await page.getByRole('button', { name: '다시 적용하기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(2);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인' }).click();
  const download = await downloadPromise;
  const result = await PDFDocument.load(await readFile(await download.path()));
  expect(result.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([201, 205]);
});

test('unsaved edits on a surviving page remain after deletion', async ({ page }) => {
  test.setTimeout(120_000);
  const source = await PDFDocument.create();
  source.addPage([500, 500]);
  source.addPage([500, 500]);
  await page.addInitScript(() => {
    window.docPilotFonts = { list: async () => [], resolve: async () => ({ found: false }) };
  });
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'edited-pages.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  const secondPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(secondPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByRole('button', { name: '텍스트 추가' }).click();
  await secondPage.scrollIntoViewIfNeeded();
  const bounds = await secondPage.boundingBox();
  const viewerBounds = await page.locator('.pdf-viewer-scroll').boundingBox();
  const startY = Math.max(bounds.y + 90, viewerBounds.y + 40);
  await page.mouse.move(bounds.x + 60, startY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 180, startY + 50, { steps: 8 });
  await page.mouse.up();
  const editor = secondPage.locator('.movable-text-edit-rich');
  await editor.fill('KEPT EDIT');
  await editor.press('Control+Enter');

  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('textbox', { name: '삭제할 PDF 페이지 범위' }).fill('1');
  await page.getByRole('button', { name: '선택 페이지 삭제' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(1);
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인' }).click();
  const bytes = await readFile(await (await downloadPromise).path());
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(1);
    const content = await (await pdf.getPage(1)).getTextContent();
    expect(content.items.map((item) => item.str).join(' ')).toContain('KEPT EDIT');
  } finally {
    await task.destroy();
  }

  await page.getByRole('button', { name: '적용 전으로 되돌리기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(2);
  const restoredDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인' }).click();
  const restoredBytes = await readFile(await (await restoredDownload).path());
  const restoredTask = getDocument({ data: new Uint8Array(restoredBytes), useSystemFonts: true });
  try {
    const restoredPdf = await restoredTask.promise;
    expect(restoredPdf.numPages).toBe(2);
    const restoredContent = await (await restoredPdf.getPage(2)).getTextContent();
    expect(restoredContent.items.map((item) => item.str).join(' ')).toContain('KEPT EDIT');
  } finally {
    await restoredTask.destroy();
  }
});
