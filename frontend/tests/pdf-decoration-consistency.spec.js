import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile } from 'node:fs/promises';

test('viewer strike thickness matches PDF document units at different zoom levels', async ({ page }) => {
  const doc = await PDFDocument.create(); doc.addPage([500, 500]);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'strike.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  const sheet = page.locator('.pdf-page[data-page-number="1"]');
  await expect(sheet.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
  const b = await sheet.boundingBox();
  await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.2); await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.3, { steps: 8 }); await page.mouse.up();
  const editor = page.locator('.movable-text-edit-rich'); await editor.fill('ABCDEF'); await editor.press('Control+a');
  await page.getByRole('toolbar', { name: '텍스트 서식' }).getByRole('button', { name: '취소선', exact: true }).click();
  await editor.press('Control+Enter');
  for (const zoom of [false, true]) {
    if (zoom) { await page.getByRole('button', { name: '확대', exact: true }).click(); await page.getByRole('button', { name: '확대', exact: true }).click(); }
    const css = await sheet.locator('.movable-text-object span').filter({ hasText: /^ABCDEF$/ }).last().evaluate(el => {
      const s = getComputedStyle(el); const sheet = el.closest('.pdf-page');
      return { thickness: parseFloat(s.textDecorationThickness), scale: sheet.getBoundingClientRect().width / 500 };
    });
    await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인', exact: true }).click();
    const bytes = await readFile(await (await pending).path());
    const task = getDocument({ data: new Uint8Array(bytes) });
    try {
      const p = await (await task.promise).getPage(1), ops = await p.getOperatorList();
      const widths = ops.argsArray.filter((_, i) => ops.fnArray[i] === OPS.setLineWidth).map(a => a[0]);
      expect(widths.some(width => Math.abs(width - css.thickness / css.scale) < 0.01)).toBe(true);
    } finally { await task.destroy(); }
  }
});
