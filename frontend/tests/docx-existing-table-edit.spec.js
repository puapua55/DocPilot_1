import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

test('existing Word table remains selected and its cell can be edited', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles('../테스트1_docx_converted.docx');
  const table = page.locator('.docx-content section.docx table').first();
  await expect(table).toHaveAttribute('data-docx-table-id', /original-/);
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  await table.locator('td, th').first().click();
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  await table.dispatchEvent('click');
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  await page.locator('.docx-table-toolbar').getByLabel('셀 색').fill('#ffcc00');
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  const secondTable = page.locator('.docx-content section.docx table').nth(1);
  await secondTable.locator('td, th').first().click();
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  const first = table.locator('td, th').first();
  await first.click();
  await page.keyboard.type('수정');
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('.viewer-download-button.docx').click()
  ]);
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const xml = await zip.file('word/document.xml').async('string');
  expect(xml).toContain('수정');
  expect(xml).toContain('FFCC00');
});

test('a small mouse movement during a table click keeps the editing toolbar open', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles('../테스트1_docx_converted.docx');
  const cell = page.locator('.docx-content section.docx table').first().locator('td, th').first();
  await expect(cell.locator('p').first()).toHaveAttribute('data-docx-paragraph-index', /\d+/);
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  await expect(page.locator('.docx-table-toolbar')).toBeHidden();
  const before = await cell.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  const afterDown = await cell.boundingBox();
  expect(Math.abs(afterDown.y - before.y)).toBeLessThan(1);
  await page.mouse.move(before.x + before.width / 2 + 2, before.y + before.height / 2 + 2);
  await page.mouse.up();
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  await page.locator('.docx-content section.docx').first().click({ position: { x: 20, y: 300 } });
  await expect(page.locator('.docx-table-toolbar')).toBeHidden();
});

test('dragging Word table cells still selects a formatting range', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles('../테스트1_docx_converted.docx');
  const table = page.locator('.docx-content section.docx table').first();
  await expect(table).toHaveAttribute('data-docx-table-id', /original-/);
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  const start = await table.locator('td, th').first().boundingBox();
  const end = await table.locator('td, th').last().boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.docx-table-toolbar')).toContainText('1~2행, 1~2열');
  await expect(table.locator('.docx-table-cell-selected')).toHaveCount(4);
});
