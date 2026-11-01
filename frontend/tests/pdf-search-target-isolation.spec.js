import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const presentationPdf = path.resolve('..', 'DocPilot_발표자료.pdf');

async function searchInModal(modal, inputSelector, keyword = '문서') {
  await modal.locator(inputSelector).fill(keyword);
  await modal.getByRole('button', { name: '검색', exact: true }).click();
}

function page19Line(modal, rowSelector, lineNumber) {
  return modal.locator(rowSelector).filter({ hasText: `19페이지 · 줄 ${lineNumber}` });
}

test('PDF search, highlight, and batch replacement keep one selected occurrence isolated', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!existsSync(presentationPdf), 'The supplied presentation PDF is unavailable');

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(presentationPdf);
  await expect(page.locator('.pdf-viewer')).toBeVisible();

  await page.locator('.feature-card').nth(0).click();
  const searchModal = page.locator('.search-panel');
  await searchInModal(searchModal, '#document-search-input');
  const page19 = page.locator('.pdf-page[data-page-number="19"]');
  for (const lineNumber of [2, 5, 9]) {
    const searchTarget = page19Line(searchModal, '.search-result-row', lineNumber);
    await expect(searchTarget).toHaveCount(1);
    await searchTarget.click();
    await expect(page19).toBeVisible();
    await expect(page19.locator('.highlight-layer[data-highlight-color="blue"] .highlight-box')).toHaveCount(1);
  }
  await searchModal.locator('.search-modal-close').click();

  await page.locator('.feature-card').nth(1).click();
  const highlightModal = page.locator('.highlight-panel');
  await searchInModal(highlightModal, '#document-highlight-input');
  const highlightTarget = page19Line(highlightModal, '.highlight-result-row', 5);
  await expect(highlightTarget).toHaveCount(1);
  await highlightTarget.click();
  await highlightTarget.locator('select').selectOption('yellow');
  await highlightModal.locator('.highlight-result-actions .highlight-button').click();
  await expect(page19.locator('.highlight-layer[data-pdf-persistent-highlight="true"] .highlight-box')).toHaveCount(1);
  await highlightModal.locator('.search-modal-close').click();

  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.locator('.feature-card').nth(2).click();
  const batchModal = page.locator('.batch-replace-panel');
  await batchModal.locator('#batch-replace-search-text').fill('문서');
  await batchModal.locator('#batch-replace-new-text').fill('문건');
  await batchModal.locator('.batch-replace-options .search-modal-button').click();
  const batchTarget = page19Line(batchModal, '.batch-replace-result-row', 9);
  await expect(batchTarget).toHaveCount(1);
  await batchTarget.locator('input[type="checkbox"]').check();
  await batchModal.locator('.batch-replace-list-actions .search-modal-button').last().click();
  await expect(page19.locator('.movable-text-object')).toHaveCount(1);
  await expect(page19.locator('.movable-text-object')).toContainText('문건');
});
