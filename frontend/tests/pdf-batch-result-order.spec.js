import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');

test('replacement results sort by page and line rather than creation time', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(sourcePdf), 'The supplied PDF is unavailable');
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.locator('.feature-card').filter({ hasText: '텍스트 일괄 변경' }).click();
  await page.locator('#batch-replace-search-text').fill('PDF');
  await page.locator('#batch-replace-new-text').fill('TXT');
  await page.locator('.batch-replace-options button').click();

  for (const [label, pageNumber, count] of [
    ['6페이지 · 줄 2', 6, 1],
    ['2페이지 · 줄 3', 2, 1],
    ['2페이지 · 줄 2', 2, 2]
  ]) {
    const row = page.locator('.batch-replace-result-row').filter({
      has: page.locator('small').filter({ hasText: new RegExp(`^${label}$`) })
    });
    await expect(row).toHaveCount(1);
    await row.locator('input[type=checkbox]').check();
    await page.locator('.batch-replace-list-actions button').last().click();
    await expect(page.locator(`.pdf-page[data-page-number="${pageNumber}"] .movable-text-object`)).toHaveCount(count);
  }

  await page.locator('.batch-replace-panel .search-modal-close').click();
  await page.locator('.feature-card').filter({ hasText: '텍스트 일괄 변경' }).click();
  await page.locator('#batch-replace-search-text').fill('TXT');
  await page.locator('#batch-replace-new-text').fill('PDF');
  await page.locator('.batch-replace-options button').click();
  const labels = await page.locator('.batch-replace-result-row small').allTextContents();
  expect(labels).toEqual([
    expect.stringContaining('2페이지 · 줄 2'),
    expect.stringContaining('2페이지 · 줄 3'),
    expect.stringContaining('6페이지 · 줄 2')
  ]);
});
