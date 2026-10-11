import { test, expect } from '@playwright/test';
import { jsPDF } from 'jspdf';

test('PDF batch replacement keeps page mode and updates a different page', async ({ page }) => {
  const pdf = new jsPDF();
  pdf.text('target one', 20, 20);
  pdf.addPage();
  pdf.text('target two', 20, 20);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'batch-page-mode.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-page')).toHaveCount(2);
  await page.getByRole('button', { name: '페이지 이동', exact: true }).click();
  const pageMode = page.getByRole('button', { name: '페이지 이동', exact: true });
  await expect(pageMode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '이동할 페이지 번호' })).toHaveValue('1');

  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.locator('.feature-card').filter({ hasText: '텍스트 일괄 변경' }).click();
  await page.locator('#batch-replace-search-text').fill('target');
  await page.locator('#batch-replace-new-text').fill('update');
  await page.locator('.batch-replace-options button').click();
  await expect(page.locator('.batch-replace-result-row')).toHaveCount(2);
  await page.locator('.batch-replace-list-actions button').first().click();
  await page.locator('.batch-replace-list-actions button').last().click();

  await expect(page.locator('.pdf-page[data-page-number="1"] .movable-text-object')).toHaveCount(1);
  await expect(page.locator('.pdf-page[data-page-number="2"] .movable-text-object')).toHaveCount(1);
  await expect(pageMode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '이동할 페이지 번호' })).toHaveValue('1');
  await expect(page.locator('.pdf-page[data-page-number="1"]')).toBeVisible();
  await expect(page.locator('.pdf-page[data-page-number="2"]')).toBeHidden();

  await page.locator('.batch-replace-panel .search-modal-close').click();
  await page.getByRole('group', { name: '페이지 이동' }).getByRole('button', { name: '다음' }).click();
  await expect(page.locator('.pdf-page[data-page-number="2"] .movable-text-object')).toContainText('update');
});
