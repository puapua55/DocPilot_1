import { test, expect } from '@playwright/test';
import { jsPDF } from 'jspdf';

test('PDF 로딩 실패를 표시하고 다른 PDF를 다시 열 수 있다', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'broken.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('This is not a valid PDF document.')
  });
  await expect(page.getByRole('alert')).toContainText('PDF');

  await page.getByRole('button', { name: '다시 선택' }).click();
  const pdf = new jsPDF();
  pdf.text('Viewer recovered', 20, 20);
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'valid.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.output('arraybuffer'))
  });
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  await expect(page.locator('.textLayer')).toContainText('Viewer recovered');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
