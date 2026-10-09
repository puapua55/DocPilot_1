import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('image attachment uses the page currently shown in scroll and page modes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const source = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) source.addPage([500, 650]);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'image-pages.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  await expect(page.locator('.pdf-page')).toHaveCount(3);
  await page.getByRole('button', { name: '편집', exact: true }).click();
  const imageBytes = Buffer.from((await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    canvas.getContext('2d').fillRect(0, 0, 24, 24);
    return canvas.toDataURL('image/png');
  })).split(',')[1], 'base64');
  const imageFile = { name: 'marker.png', mimeType: 'image/png', buffer: imageBytes };
  const pageInput = page.locator('.pdf-page-position-bar input');

  await pageInput.fill('2');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('2');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '이미지 첨부' }).click();
  await (await chooserPromise).setFiles(imageFile);
  await expect(page.locator('.pdf-page[data-page-number="2"] .pdf-image-object')).toHaveCount(1);
  await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-image-object')).toHaveCount(0);

  await page.locator('.pdf-view-mode-toggle button').last().click();
  await pageInput.fill('3');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('3');
  await page.locator('.pdf-image-input').setInputFiles(imageFile);
  await expect(page.locator('.pdf-page[data-page-number="3"] .pdf-image-object')).toHaveCount(1);
  await expect(page.locator('.pdf-page[data-page-number="2"] .pdf-image-object')).toHaveCount(1);
});
