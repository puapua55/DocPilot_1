import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

test('Word 표 추가는 뷰어에 나타나고 DOCX에 저장된다', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles('Welcome to Word (2).docx');
  await expect(page.locator('.docx-content section.docx').first()).toBeVisible();
  const originalTableCount = await page.locator('.docx-content section.docx table').count();
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  const firstPage = page.locator('.docx-content section.docx').first();
  const bounds = await firstPage.boundingBox();
  await firstPage.click({ position: { x: bounds.width - 24, y: bounds.height - 24 } });
  await expect(page.locator('.docx-content [contenteditable="true"]')).toHaveCount(1);
  await page.keyboard.type('새 문단');
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '표 추가' }).click();
  await page.getByRole('button', { name: '2행 4열 표 추가' }).click();
  await expect(page.locator('.docx-added-table')).toHaveCount(1);
  await expect(page.locator('.docx-added-table td')).toHaveCount(8);
  await page.locator('.docx-added-table td').first().click();
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  await page.keyboard.type('표 값');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.viewer-download-button.docx').click()
  ]);
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const xml = await zip.file('word/document.xml').async('string');
  expect(xml).toContain('새 문단');
  expect(xml).toContain('표 값');
  expect((xml.match(/<w:tbl\b/g) || []).length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '다시 선택' }).click();
  await page.getByRole('button', { name: '예' }).click();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'word-table-edited.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await readFile(await download.path())
  });
  await expect(page.locator('.docx-content section.docx table')).toHaveCount(originalTableCount + 1);
});
