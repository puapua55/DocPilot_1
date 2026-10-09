import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');

test('one checked PDF result creates one replacement at the source position', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(sourcePdf), 'The supplied PDF is unavailable');
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.locator('.feature-card').filter({ hasText: '텍스트 일괄 변경' }).click();
  await page.locator('#batch-replace-search-text').fill('PDF');
  await page.locator('#batch-replace-new-text').fill('TXT');
  await page.locator('.batch-replace-options button').click();
  const rows = page.locator('.batch-replace-result-row');
  await expect(rows.first()).toBeVisible();
  const target = rows.filter({ hasText: '2페이지' }).nth(1);
  await target.locator('input[type=checkbox]').check();
  expect(await page.locator('.pdf-page .highlight-layer[data-highlight-color="blue"] .highlight-box').count()).toBe(0);
  await page.locator('.batch-replace-list-actions button').last().click();
  const pageTwo = page.locator('.pdf-page[data-page-number="2"]');
  await expect(pageTwo.locator('.movable-text-object')).toHaveCount(1);
  const placement = await pageTwo.evaluate((element) => {
    const source = element.querySelector('.textLayer span[data-text-item-index="14"]');
    const originalX = JSON.parse(source.dataset.pdfSource).transform[4];
    const object = element.querySelector('.movable-text-object');
    return { originalX: originalX * element.clientWidth / 610,
      left: Number.parseFloat(object.style.left), text: object.textContent };
  });
  expect(placement.text).toContain('TXT');
  expect(Math.abs(placement.left - placement.originalX)).toBeLessThan(0.2);

  await page.locator('.batch-replace-panel .search-modal-close').click();
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.locator('#pdf-extract-selection').fill('2');
  await page.getByRole('button', { name: '선택 페이지 추출' }).click();
  const confirm = page.locator('.pdf-download-preview-confirm');
  await expect(confirm).toBeEnabled({ timeout: 120_000 });
  const downloadPromise = page.waitForEvent('download');
  await confirm.click();
  const downloaded = await downloadPromise;
  const loadingTask = getDocument({ data: new Uint8Array(readFileSync(await downloaded.path())) });
  try {
    const pdf = await loadingTask.promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    const items = content.items.filter((item) => typeof item.str === 'string');
    const match = items.find((item) => item.str === 'TXT' && Math.abs(item.transform[5] - 240.72) < 0.1);
    expect(match?.transform[4]).toBeCloseTo(455.4, 1);
    expect(match?.width).toBeCloseTo(14.2992, 1);
    expect(items.filter((item) => item.str === 'TXT')).toHaveLength(1);
    expect(items.filter((item) => item.str === 'PDF')).toHaveLength(4);
  } finally {
    await loadingTask.destroy();
  }

  await page.locator('.feature-card').filter({ hasText: '텍스트 일괄 변경' }).click();
  await page.locator('#batch-replace-search-text').fill('TXT');
  await page.locator('#batch-replace-new-text').fill('PDF');
  await page.locator('.batch-replace-options button').click();
  const changedRow = page.locator('.batch-replace-result-row').filter({ hasText: '2페이지' });
  await expect(changedRow).toHaveCount(1);
  await changedRow.click();
  const findBox = pageTwo.locator('.highlight-layer[data-highlight-color="blue"] .highlight-box');
  await expect(findBox).toHaveCount(1);
  const markerOffset = await pageTwo.evaluate((element) => {
    const marker = element.querySelector('.highlight-layer[data-highlight-color="blue"] .highlight-box');
    const object = element.querySelector('.movable-text-object');
    return Math.abs(marker.getBoundingClientRect().left - object.getBoundingClientRect().left);
  });
  expect(markerOffset).toBeLessThan(1);
  await changedRow.locator('input[type=checkbox]').check();
  await page.locator('.batch-replace-list-actions button').last().click();
  await expect(pageTwo.locator('.movable-text-object')).toHaveCount(1);
  await expect(pageTwo.locator('.movable-text-object')).toContainText('PDF');
  await page.locator('.batch-replace-panel .search-modal-close').click();
  await page.getByRole('button', { name: '선택 페이지 추출' }).click();
  await expect(confirm).toBeEnabled({ timeout: 120_000 });
  const secondDownloadPromise = page.waitForEvent('download');
  await confirm.click();
  const secondDownload = await secondDownloadPromise;
  const secondTask = getDocument({ data: new Uint8Array(readFileSync(await secondDownload.path())) });
  try {
    const pdf = await secondTask.promise;
    const content = await (await pdf.getPage(1)).getTextContent();
    const items = content.items.filter((item) => typeof item.str === 'string');
    expect(items.filter((item) => item.str === 'TXT')).toHaveLength(0);
    expect(items.filter((item) => item.str === 'PDF')).toHaveLength(5);
  } finally {
    await secondTask.destroy();
  }
});
