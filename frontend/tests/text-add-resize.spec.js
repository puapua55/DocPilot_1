import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

test('added text can be resized and moved without opening the editor in move mode', async ({ page }) => {
  test.setTimeout(120_000);
  const source = await PDFDocument.create();
  const sheet = source.addPage([500, 500]);
  sheet.drawText('ORIGINAL', {
    x: 100,
    y: 300,
    size: 18,
    font: await source.embedFont(StandardFonts.Helvetica)
  });
  const sourceBytes = await source.save();
  await page.addInitScript(() => {
    window.docPilotFonts = {
      list: async () => [],
      resolve: async () => ({ found: false })
    };
  });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'text-add-source.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(sourceBytes)
  });
  const pdfPage = page.locator('.pdf-page[data-page-number="1"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.getByRole('button', { name: '텍스트 추가' }).click();
  const bounds = await pdfPage.boundingBox();
  const scale = bounds.width / 500;
  await page.mouse.move(bounds.x + 92 * scale, bounds.y + 185 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 250 * scale, bounds.y + 235 * scale, { steps: 8 });
  await page.mouse.up();

  const editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('ADDED');
  await editor.press('Enter');
  await editor.type('MORE');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  const textBox = pdfPage.locator('.movable-text-object.is-added-text');
  await expect(textBox).toContainText('ADDED');
  await expect(pdfPage.locator('.movable-text-cover')).toHaveCount(0);

  await page.getByRole('button', { name: '텍스트 이동' }).click();
  await textBox.dblclick();
  await expect(editor).toHaveCount(0);
  await page.getByRole('button', { name: '텍스트 이동' }).click();
  await textBox.click();
  await expect(editor).toBeVisible();
  const before = await textBox.boundingBox();
  const handle = textBox.locator('.movable-text-resize-handle.is-se');
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 45, handleBox.y + handleBox.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  const after = await textBox.boundingBox();
  expect(after.width).toBeGreaterThan(before.width + 30);
  expect(after.height).toBeGreaterThan(before.height + 20);

  await editor.press('Control+Enter');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.viewer-download-button.pdf').click();
  const download = await downloadPromise;
  const pdfBytes = await readFile(await download.path());
  const saved = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
  const savedPage = await saved.getPage(1);
  const textContent = await savedPage.getTextContent();
  const text = textContent.items.map((item) => item.str).join(' ');
  expect(text).toContain('ORIGINAL');
  expect(text).toContain('ADDED');
  expect(text).toContain('MORE');
});
