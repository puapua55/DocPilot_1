import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('viewer page counter follows scrolling and page navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const source = await PDFDocument.create();
  for (let number = 0; number < 4; number += 1) source.addPage([500, 650]);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'page-position.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  await expect(page.locator('.pdf-page')).toHaveCount(4);
  const counter = page.getByRole('status', { name: 'PDF 페이지 위치' });
  const pageInput = page.getByRole('textbox', { name: '이동할 페이지 번호' });
  await expect(pageInput).toHaveValue('1');
  await expect(counter).toContainText('/4');
  const viewer = page.locator('.pdf-viewer-scroll');
  const scrollToPage = async (number) => viewer.evaluate((element, targetNumber) => {
    const target = element.querySelector(`.pdf-page[data-page-number="${targetNumber}"]`);
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
  }, number);

  await scrollToPage(2);
  await expect(pageInput).toHaveValue('2');
  await scrollToPage(4);
  await expect(pageInput).toHaveValue('4');
  await pageInput.fill('2');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('2');
  const pageTwoPosition = await page.locator('.pdf-page[data-page-number="2"]').evaluate((element) => element.getBoundingClientRect().top);
  const viewerPosition = await viewer.evaluate((element) => element.getBoundingClientRect().top);
  expect(pageTwoPosition - viewerPosition).toBeLessThan(40);
  await pageInput.fill('9');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('2');
  await page.getByRole('button', { name: '페이지 이동', exact: true }).click();
  await pageInput.fill('4');
  await pageInput.press('Tab');
  await expect(pageInput).toHaveValue('4');
  await expect(page.locator('.pdf-page[data-page-number="4"]')).toBeVisible();
  await page.getByRole('group', { name: '페이지 이동' }).getByRole('button', { name: '이전' }).click();
  await expect(pageInput).toHaveValue('3');
  await page.screenshot({ path: 'test-results/pdf-page-position.png' });
});
