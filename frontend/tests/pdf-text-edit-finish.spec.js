import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

async function openEditablePdf(page) {
  const source = await PDFDocument.create();
  const sheet = source.addPage([500, 500]);
  sheet.drawText('ORIGINAL', {
    x: 80,
    y: 350,
    size: 18,
    font: await source.embedFont(StandardFonts.Helvetica)
  });
  await page.addInitScript(() => {
    window.docPilotFonts = {
      list: async () => [],
      resolve: async () => ({ found: false })
    };
  });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'text-edit-finish.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save())
  });
  const pdfPage = page.locator('.pdf-page[data-page-number="1"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  return pdfPage;
}

async function expectAltEnterLineBreak(editor, firstLine, secondLine) {
  await editor.fill(firstLine);
  await editor.press('Alt+Enter');
  await editor.pressSequentially(secondLine);
  await expect.poll(() => editor.evaluate((element) => element.innerText.replaceAll('\r', '')))
    .toBe(`${firstLine}\n${secondLine}`);
}

test('existing and added PDF text use Alt+Enter for a line break and Enter to finish', async ({ page }) => {
  const pdfPage = await openEditablePdf(page);

  await pdfPage.locator('.textLayer span').filter({ hasText: 'ORIGINAL' }).first().click();
  let editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await expectAltEnterLineBreak(editor, 'EDITED', 'SECOND');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);

  await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
  const bounds = await pdfPage.boundingBox();
  await page.mouse.move(bounds.x + 260, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 420, bounds.y + 170, { steps: 6 });
  await page.mouse.up();
  editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await expectAltEnterLineBreak(editor, 'ADDED', 'LINE');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
});

test('clicking outside finishes both existing and added PDF text editing', async ({ page }) => {
  const pdfPage = await openEditablePdf(page);

  await pdfPage.locator('.textLayer span').filter({ hasText: 'ORIGINAL' }).first().click();
  let editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('EDITED');
  await page.mouse.click(5, 5);
  await expect(editor).toHaveCount(0);

  await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
  const bounds = await pdfPage.boundingBox();
  await page.mouse.move(bounds.x + 260, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 420, bounds.y + 170, { steps: 6 });
  await page.mouse.up();
  editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('ADDED');
  await page.mouse.click(5, 5);
  await expect(editor).toHaveCount(0);
});
