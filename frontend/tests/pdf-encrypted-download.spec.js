import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createPdfToolkit } from 'pdfstudio';

async function onePage(width = 300) {
  const pdf = await PDFDocument.create();
  pdf.addPage([width, 400]);
  return pdf.save();
}

async function openPdf(page, name, bytes) {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name, mimeType: 'application/pdf', buffer: Buffer.from(bytes)
  });
}

async function insertPdf(page, name, bytes) {
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.locator('.pdf-page-tools-toggle').click();
  await page.locator('.pdf-page-tools-tabs button').filter({ hasText: '삽입' }).click();
  await page.locator('#pdf-insert-file').setInputFiles({
    name, mimeType: 'application/pdf', buffer: Buffer.from(bytes)
  });
  await page.locator('.pdf-page-insert-actions .viewer-download-button').click();
}

async function downloadPdf(page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('.pdf-download-preview-confirm').click();
  return new Uint8Array(await readFile(await (await downloadPromise).path()));
}

test('plain PDF can still use a new password', async ({ page }) => {
  const toolkit = await createPdfToolkit();
  await openPdf(page, 'plain.pdf', await onePage());
  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  await page.locator('.pdf-download-encryption-toggle input').check();
  await page.locator('.pdf-download-encryption-fields input').first().fill('secret123');
  await page.locator('.pdf-download-encryption-fields input').last().fill('secret123');
  const bytes = await downloadPdf(page);
  expect(await toolkit.isEncrypted(bytes)).toBe(true);
  expect(await toolkit.requiresPassword(bytes)).toBe(true);
});

test('one encrypted source automatically supplies encryption and permissions', async ({ page }) => {
  test.setTimeout(90_000);
  const toolkit = await createPdfToolkit();
  const encrypted = await toolkit.lock(await onePage(250), {
    userPassword: '', ownerPassword: 'owner-secret', keyLength: 256,
    permissions: { print: 'none', extract: false, modify: 'none' }
  });
  await openPdf(page, 'plain.pdf', await onePage());
  await insertPdf(page, 'restricted.pdf', encrypted);
  await expect(page.locator('.pdf-page-position-bar')).toContainText('2');
  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  await expect(page.getByRole('radio', { name: /원본 설정 승계/ })).toBeChecked();
  const bytes = await downloadPdf(page);
  const info = await toolkit.getInfo(bytes);
  expect(info.pageCount).toBe(2);
  expect(info.encrypted).toBe(true);
  expect(await toolkit.requiresPassword(bytes)).toBe(false);
  expect(info.encryption.permissions.print).toBe(false);
  expect(info.encryption.permissions.extract).toBe(false);
  expect((await toolkit.getInfo(bytes, { password: 'owner-secret' })).encryption.ownerPasswordMatched).toBe(true);
});

test('two encrypted sources prompt for the settings to inherit', async ({ page }) => {
  test.setTimeout(90_000);
  const toolkit = await createPdfToolkit();
  const first = await toolkit.lock(await onePage(250), {
    userPassword: '', ownerPassword: 'first-owner', keyLength: 256,
    permissions: { print: 'none', extract: false }
  });
  const second = await toolkit.lock(await onePage(300), {
    userPassword: '', ownerPassword: 'second-owner', keyLength: 256,
    permissions: { print: 'full', extract: true }
  });
  await openPdf(page, 'first.pdf', first);
  await insertPdf(page, 'second.pdf', second);
  const choice = page.getByRole('dialog', { name: '합본 암호화 설정 선택' });
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: /삽입할 PDF 설정/ }).click();
  await expect(page.locator('.pdf-page-position-bar')).toContainText('2');
  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  await expect(page.getByRole('radio', { name: /원본 설정 승계.*second\.pdf/ })).toBeChecked();
  const bytes = await downloadPdf(page);
  const info = await toolkit.getInfo(bytes);
  expect(info.pageCount).toBe(2);
  expect(info.encryption.permissions.print).toBe(true);
  expect(info.encryption.permissions.extract).toBe(true);
  expect((await toolkit.getInfo(bytes, { password: 'second-owner' })).encryption.ownerPasswordMatched).toBe(true);
  await expect(toolkit.getInfo(bytes, { password: 'first-owner' })).rejects.toThrow();
});

test('encrypted viewer PDF passes its settings through a plain PDF insertion', async ({ page }) => {
  test.setTimeout(90_000);
  const toolkit = await createPdfToolkit();
  const encrypted = await toolkit.lock(await onePage(250), {
    userPassword: '', ownerPassword: 'viewer-owner', keyLength: 256,
    permissions: { print: 'none', extract: false }
  });
  await openPdf(page, 'encrypted.pdf', encrypted);
  await insertPdf(page, 'plain.pdf', await onePage());
  await expect(page.getByRole('dialog', { name: '합본 암호화 설정 선택' })).toHaveCount(0);
  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  await expect(page.getByRole('radio', { name: /원본 설정 승계.*encrypted\.pdf/ })).toBeChecked();
  const bytes = await downloadPdf(page);
  expect((await toolkit.getInfo(bytes, { password: 'viewer-owner' })).encryption.ownerPasswordMatched).toBe(true);
  expect(await toolkit.pageCount(bytes)).toBe(2);
});
