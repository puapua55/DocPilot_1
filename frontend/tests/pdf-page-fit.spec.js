import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('single fit button alternates width and full page while zoom shows the rendered scale', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const source = await PDFDocument.create();
  source.addPage([500, 900]);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'fit-modes.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  const fitButton = page.locator('.pdf-page-fit-toggle');
  const zoomValue = page.locator('.zoom-value');
  const pdfPage = page.locator('.pdf-page').first();
  const viewer = page.locator('.pdf-viewer-scroll');
  await expect(fitButton).toHaveText('너비 맞춤');
  await expect(pdfPage).toBeVisible();
  await expect.poll(async () => Math.round((await pdfPage.boundingBox()).width / 500 * 100)).toBe(Number((await zoomValue.innerText()).replace('%', '')));
  const widthPercent = Number((await zoomValue.innerText()).replace('%', ''));

  await fitButton.click();
  await expect(fitButton).toHaveText('페이지 맞춤');
  await expect.poll(async () => Number((await zoomValue.innerText()).replace('%', ''))).toBeLessThan(widthPercent);
  const pagePercent = Number((await zoomValue.innerText()).replace('%', ''));
  const pageHeight = (await pdfPage.boundingBox()).height;
  const viewerHeight = await viewer.evaluate((element) => element.clientHeight);
  expect(pageHeight).toBeLessThan(viewerHeight);

  await page.getByRole('button', { name: '확대', exact: true }).click();
  await expect.poll(async () => Number((await zoomValue.innerText()).replace('%', ''))).toBeGreaterThan(pagePercent);
  await fitButton.click();
  await expect(fitButton).toHaveText('너비 맞춤');
  await expect(zoomValue).toHaveText(`${widthPercent}%`);
  await page.screenshot({ path: 'test-results/pdf-fit-modes.png' });
});

test('fit toggle keeps the current scroll page and omits the page badge', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const source = await PDFDocument.create();
  for (let number = 0; number < 8; number += 1) source.addPage([500, 900]);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'fit-scroll-position.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  const pageInput = page.locator('.pdf-page-position-current');
  await expect(pageInput).toHaveValue('1');
  await pageInput.fill('5');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('5');
  const fitButton = page.locator('.pdf-page-fit-toggle');
  await fitButton.click();
  await expect(pageInput).toHaveValue('5');
  await page.waitForTimeout(500);
  await expect(pageInput).toHaveValue('5');
  await fitButton.click();
  await expect(pageInput).toHaveValue('5');
  await expect(page.locator('.pdf-page-debug-label')).toHaveCount(0);
});
