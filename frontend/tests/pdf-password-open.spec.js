import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createPdfToolkit } from 'pdfstudio';

test('password-protected PDF prompts, retries, cancels, and opens with the right password', async ({ page }) => {
  test.setTimeout(90_000);
  const toolkit = await createPdfToolkit();
  const source = await PDFDocument.create();
  source.addPage([300, 400]);
  const encrypted = await toolkit.lock(await source.save(), {
    userPassword: 'open-secret',
    ownerPassword: 'owner-secret',
    keyLength: 256,
    permissions: { print: 'none' }
  });
  const chooseFile = () => page.locator('.upload-panel input[type=file]').setInputFiles({
    name: 'protected.pdf', mimeType: 'application/pdf', buffer: Buffer.from(encrypted)
  });

  await page.goto('/');
  await chooseFile();
  const dialog = page.getByRole('dialog', { name: 'PDF 비밀번호 입력' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.upload-panel')).toBeVisible();

  await chooseFile();
  await dialog.getByRole('textbox', { name: 'PDF 열기 비밀번호' }).fill('incorrect');
  await dialog.getByRole('button', { name: '확인' }).click();
  await expect(dialog.getByRole('alert')).toContainText('비밀번호가 올바르지 않습니다');
  await dialog.getByRole('textbox', { name: 'PDF 열기 비밀번호' }).fill('open-secret');
  await dialog.getByRole('button', { name: '확인' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.pdf-page-position-bar')).toContainText('1');

  const additional = await PDFDocument.create();
  additional.addPage([250, 350]);
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.locator('.pdf-page-tools-toggle').click();
  await page.locator('.pdf-page-tools-tabs button').filter({ hasText: '삽입' }).click();
  await page.locator('#pdf-insert-file').setInputFiles({
    name: 'additional.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await additional.save())
  });
  await page.locator('.pdf-page-insert-actions .viewer-download-button').click();
  await expect(page.locator('.pdf-page-position-bar')).toContainText('2');

  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  await expect(page.getByRole('radio', { name: /원본 설정 승계/ })).toBeChecked();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.pdf-download-preview-confirm').click();
  const output = new Uint8Array(await readFile(await (await downloadPromise).path()));
  expect(await toolkit.requiresPassword(output)).toBe(true);
  const info = await toolkit.getInfo(output, { password: 'owner-secret' });
  expect(info.pageCount).toBe(2);
  expect(info.encryption.ownerPasswordMatched).toBe(true);
  expect(info.encryption.permissions.print).toBe(false);
});
