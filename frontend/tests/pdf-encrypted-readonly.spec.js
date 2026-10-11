import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { createPdfToolkit } from 'pdfstudio';

async function makePdf() {
  const document = await PDFDocument.create();
  document.addPage([300, 400]);
  return document.save();
}

async function openPdf(page, name, bytes) {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name, mimeType: 'application/pdf', buffer: Buffer.from(bytes)
  });
  await expect(page.locator('.pdf-page')).toHaveCount(1);
}

test('PDF encrypted without an opening password is read-only', async ({ page }) => {
  const toolkit = await createPdfToolkit();
  const encrypted = await toolkit.lock(await makePdf(), {
    userPassword: '', ownerPassword: 'owner-secret', keyLength: 256
  });
  await openPdf(page, 'encrypted.pdf', encrypted);
  await expect(page.getByText('암호화 PDF · 편집 제한')).toBeVisible();
  await expect(page.locator('.pdf-edit-mode-toggle button').last()).toBeDisabled();
  await expect(page.locator('.feature-card').filter({ hasText: '위치 하이라이트' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.feature-card').filter({ hasText: '텍스트 일괄 변경' })).toHaveAttribute('aria-disabled', 'true');
  await page.locator('.pdf-page-tools-toggle').click();
  await expect(page.locator('.pdf-page-tools-tabs button')).toHaveCount(1);
  await expect(page.locator('.viewer-download-actions .viewer-download-button.pdf').first()).toBeEnabled();
});

test('ordinary PDF still offers editing', async ({ page }) => {
  await openPdf(page, 'plain.pdf', await makePdf());
  await expect(page.locator('.pdf-edit-mode-toggle button').last()).toBeEnabled();
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await expect(page.locator('.pdf-edit-mode-toggle button').last()).toHaveAttribute('aria-pressed', 'true');
});

test('PDF opened with a password remains editable', async ({ page }) => {
  const toolkit = await createPdfToolkit();
  const encrypted = await toolkit.lock(await makePdf(), {
    userPassword: 'open-secret', ownerPassword: 'owner-secret', keyLength: 256
  });
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'password.pdf', mimeType: 'application/pdf', buffer: Buffer.from(encrypted)
  });
  const passwordDialog = page.getByRole('dialog', { name: 'PDF 비밀번호 입력' });
  await passwordDialog.getByRole('textbox', { name: 'PDF 열기 비밀번호' }).fill('open-secret');
  await passwordDialog.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(1);
  await expect(page.locator('.pdf-edit-mode-toggle button').last()).toBeEnabled();
});
