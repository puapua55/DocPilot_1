import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');

test('batch replacement stays on the source PDF text baseline in the viewer', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(sourcePdf), 'The supplied PDF is unavailable');

  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.locator('.feature-card').filter({ hasText: '텍스트 일괄 변경' }).click();
  await page.locator('#batch-replace-search-text').fill('PDF 및 Word');
  await page.locator('#batch-replace-new-text').fill('Word 및 PDF');
  await page.locator('.batch-replace-options button').click();
  const target = page.locator('.batch-replace-result-row').filter({ hasText: '2페이지' }).first();
  await expect(target).toBeVisible();
  await target.locator('input[type=checkbox]').check();
  await page.locator('.batch-replace-list-actions button').last().click();

  const baseline = await page.locator('.pdf-page[data-page-number="2"] .movable-text-object').evaluate((element) => {
    const pdfPage = element.closest('.pdf-page');
    const pageRect = pdfPage.getBoundingClientRect();
    const scale = pageRect.width / 610;
    const marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;border:0';
    element.append(marker);
    const value = (marker.getBoundingClientRect().top - pageRect.top) / scale;
    marker.remove();
    return value;
  });
  // Page 2 is 342pt tall and the source phrase has a PDF baseline at y=250.92pt.
  expect(baseline).toBeCloseTo(342 - 250.92, 0);
});
