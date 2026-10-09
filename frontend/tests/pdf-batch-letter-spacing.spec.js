import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');

test('batch replacement fills the original text width in exported PDF', async ({ page }) => {
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
  const replacedPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(replacedPage.locator('.movable-text-object')).toHaveCount(1);
  const editorSpacing = await replacedPage.locator('.movable-text-object').evaluate((element) => ({
    letterSpacing: Number.parseFloat(getComputedStyle(element).letterSpacing),
    boxWidth: element.getBoundingClientRect().width * 610 / element.closest('.pdf-page').clientWidth
  }));
  expect(editorSpacing.letterSpacing).toBeGreaterThan(0);
  expect(editorSpacing.boxWidth).toBeCloseTo(52.54, 0);

  await page.locator('.batch-replace-panel .search-modal-close').click();
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.locator('#pdf-extract-selection').fill('2');
  await page.getByRole('button', { name: '선택 페이지 추출' }).click();
  const confirm = page.locator('.pdf-download-preview-confirm');
  await expect(confirm).toBeEnabled({ timeout: 120_000 });
  const downloadPromise = page.waitForEvent('download');
  await confirm.click();
  const download = await downloadPromise;

  const loadingTask = getDocument({ data: new Uint8Array(readFileSync(await download.path())) });
  try {
    const pdf = await loadingTask.promise;
    const items = (await (await pdf.getPage(1)).getTextContent()).items;
    const heading = items.find((item) => item.str === 'Word 및 PDF'
      && Math.abs(item.transform[4] - 383.16) < 1);
    expect(heading).toBeDefined();
    // The source phrase spans x=383.16 through the end of Word at x=435.70.
    expect(heading.width).toBeCloseTo(52.54, 0);
    const nextText = items.find((item) => item.str === '문서 활용 증가'
      && Math.abs(item.transform[5] - heading.transform[5]) < 0.1);
    expect(nextText?.transform[4]).toBeCloseTo(438.72, 0);
  } finally {
    await loadingTask.destroy();
  }
});
