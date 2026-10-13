import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');

test.beforeEach(() => {
  test.skip(!existsSync(sourcePdf), 'Local PDF layout regression fixture is unavailable');
});

test('selecting a PDF line without editing keeps the downloaded source unchanged', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-page-position-current').fill('2');
  await page.locator('.pdf-page-position-current').press('Enter');
  const pdfPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await pdfPage.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: '문서 내 특정 내용을 빠르게' }).first().click();
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();

  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  const preview = page.locator('.pdf-download-preview-dialog');
  await expect(preview).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'), preview.locator('.pdf-download-preview-confirm').click()
  ]);
  const source = await readFile(sourcePdf);
  const saved = await readFile(await download.path());
  expect(saved.equals(source)).toBe(true);
  await expect(pdfPage.locator('.movable-text-object')).toHaveCount(0);
});

test('area-selecting several original lines without edits does not rewrite them', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-page-position-current').fill('2');
  await page.locator('.pdf-page-position-current').press('Enter');
  const pdfPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  const target = pdfPage.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: '문서 내 특정 내용을 빠르게' }).first();
  const line = await target.boundingBox();
  const pageBox = await pdfPage.boundingBox();
  await page.mouse.move(pageBox.x + 20, line.y - 4);
  await page.mouse.down();
  await page.mouse.move(line.x + line.width + 8, line.y + 42, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => pdfPage.locator('.movable-text-object').count()).toBeGreaterThan(1);
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.press('Enter');

  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  const preview = page.locator('.pdf-download-preview-dialog');
  await expect(preview).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'), preview.locator('.pdf-download-preview-confirm').click()
  ]);
  expect((await readFile(await download.path())).equals(await readFile(sourcePdf))).toBe(true);
});

test('an actual text edit is still included in the downloaded PDF', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-page-position-current').fill('2');
  await page.locator('.pdf-page-position-current').press('Enter');
  const pdfPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await pdfPage.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: '문서 내 특정 내용을 빠르게' }).first().click();
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('PDF 편집 검증 문장');
  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  const preview = page.locator('.pdf-download-preview-dialog');
  await expect(preview).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'), preview.locator('.pdf-download-preview-confirm').click()
  ]);
  const saved = await readFile(await download.path());
  expect(saved.equals(await readFile(sourcePdf))).toBe(false);
  const task = getDocument({ data: Uint8Array.from(saved), useSystemFonts: true });
  try {
    const document = await task.promise;
    const content = await (await document.getPage(2)).getTextContent();
    expect(content.items.map((item) => item.str).join('')).toContain('PDF 편집 검증 문장');
  } finally {
    await task.destroy();
  }
});

test('editing a paragraph line keeps its PDF baseline and the surrounding lines', async ({ page }) => {
  test.setTimeout(120_000);
  const originalBytes = await readFile(sourcePdf);
  const originalTask = getDocument({ data: Uint8Array.from(originalBytes), useSystemFonts: true });
  const originalDocument = await originalTask.promise;
  const originalItems = (await (await originalDocument.getPage(2)).getTextContent()).items;
  const sourceLine = originalItems.find((item) => item.str.startsWith('문서나 편집이 제한된 문서는'));
  expect(sourceLine).toBeTruthy();
  await originalTask.destroy();

  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-page-position-current').fill('2');
  await page.locator('.pdf-page-position-current').press('Enter');
  const pdfPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await pdfPage.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: '문서나 편집이 제한된 문서는' }).first().click();
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('문서나 편집이 제한된 문서는 사용자가 직접 내용을 확인하거나 강조 표시할 수 있습니다');

  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  const preview = page.locator('.pdf-download-preview-dialog');
  await expect(preview).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'), preview.locator('.pdf-download-preview-confirm').click()
  ]);
  const changedTask = getDocument({
    data: Uint8Array.from(await readFile(await download.path())), useSystemFonts: true
  });
  try {
    const changedDocument = await changedTask.promise;
    const changedItems = (await (await changedDocument.getPage(2)).getTextContent()).items;
    const editedLine = changedItems.find((item) => item.str.replaceAll(' ', '').startsWith('문서나편집이제한된문서는'));
    expect(editedLine).toBeTruthy();
    expect(Math.abs(editedLine.transform[4] - sourceLine.transform[4])).toBeLessThan(0.1);
    expect(Math.abs(editedLine.transform[5] - sourceLine.transform[5])).toBeLessThan(0.1);
    expect(editedLine.width).toBeLessThanOrEqual(sourceLine.width + 1);
    for (const original of originalItems.filter((item) => item.str.includes('찾고 수정해야 하는 상황이'))) {
      const unchanged = changedItems.find((item) => item.str === original.str);
      expect(unchanged?.transform[4]).toBeCloseTo(original.transform[4], 2);
      expect(unchanged?.transform[5]).toBeCloseTo(original.transform[5], 2);
    }
  } finally {
    await changedTask.destroy();
  }
});

test('editing one line from an area selection leaves the other paragraph lines untouched', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-page-position-current').fill('2');
  await page.locator('.pdf-page-position-current').press('Enter');
  const pdfPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  const line = await pdfPage.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: '문서 내 특정 내용을 빠르게' }).first().boundingBox();
  const pageBox = await pdfPage.boundingBox();
  await page.mouse.move(pageBox.x + 20, line.y - 4);
  await page.mouse.down();
  await page.mouse.move(line.x + line.width + 8, line.y + 42, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => pdfPage.locator('.movable-text-object').count()).toBeGreaterThan(1);
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('PDF 및 Word 문서를 확인합니다');
  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  const preview = page.locator('.pdf-download-preview-dialog');
  await expect(preview).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'), preview.locator('.pdf-download-preview-confirm').click()
  ]);
  const sourceTask = getDocument({ data: Uint8Array.from(await readFile(sourcePdf)), useSystemFonts: true });
  const changedTask = getDocument({ data: Uint8Array.from(await readFile(await download.path())), useSystemFonts: true });
  try {
    const sourceItems = (await (await (await sourceTask.promise).getPage(2)).getTextContent()).items;
    const changedItems = (await (await (await changedTask.promise).getPage(2)).getTextContent()).items;
    const original = sourceItems.find((item) => item.str.startsWith('문서나 편집이 제한된 문서는'));
    const unchanged = changedItems.find((item) => item.str === original.str);
    expect(unchanged).toBeTruthy();
    expect(unchanged.transform[4]).toBeCloseTo(original.transform[4], 2);
    expect(unchanged.transform[5]).toBeCloseTo(original.transform[5], 2);
  } finally {
    await sourceTask.destroy();
    await changedTask.destroy();
  }
});
