import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function openTwoPagePdf(page) {
  const doc = await PDFDocument.create();
  doc.addPage([500, 500]);
  doc.addPage([500, 500]);
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'copy-paste-test.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save())
  });
  await expect(page.locator('.textLayer').first()).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
}

test('PDF text box can be copied from its context menu and pasted on the same or another page', async ({ page }) => {
  await openTwoPagePdf(page);
  await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
  const first = page.locator('.pdf-page[data-page-number="1"]');
  const bounds = await first.boundingBox();
  const scale = bounds.width / 500;
  await page.mouse.move(bounds.x + 30 * scale, bounds.y + 60 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 300 * scale, bounds.y + 120 * scale, { steps: 5 });
  await page.mouse.up();
  const editor = page.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('copy me');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);

  const original = first.locator('.movable-text-object.is-added-text');
  await expect(original).toHaveCount(1);
  const originalId = await original.getAttribute('data-movable-text-id');
  // Nothing is copied yet, so an empty page area has no paste entry.
  await first.click({ button: 'right', position: { x: 300 * scale, y: 400 * scale } });
  await expect(page.getByRole('menuitem', { name: '붙여넣기', exact: true })).toHaveCount(0);

  await original.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '복사', exact: true }).click();

  // A text box can also be the target for a paste context menu.
  await original.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '붙여넣기', exact: true }).click();
  await expect(first.locator('.movable-text-object.is-added-text')).toHaveCount(2);

  // Same page.
  await first.click({ button: 'right', position: { x: 250 * scale, y: 300 * scale } });
  await page.getByRole('menuitem', { name: '붙여넣기', exact: true }).click();
  await expect(first.locator('.movable-text-object.is-added-text')).toHaveCount(3);

  // Another page.
  const second = page.locator('.pdf-page[data-page-number="2"]');
  await second.scrollIntoViewIfNeeded();
  await second.click({ button: 'right', position: { x: 100 * scale, y: 200 * scale } });
  await page.getByRole('menuitem', { name: '붙여넣기', exact: true }).click();
  const pasted = second.locator('.movable-text-object.is-added-text');
  await expect(pasted).toHaveCount(1);
  await expect(pasted).toContainText('copy me');
  // The source box is left unchanged.
  await expect(first.locator(`.movable-text-object[data-movable-text-id="${originalId}"]`)).toContainText('copy me');
});
