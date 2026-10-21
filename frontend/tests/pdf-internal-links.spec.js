import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { readInternalDestination } from '../src/services/pdfInternalLinks.js';
import { createPdfToolkit } from 'pdfstudio';

async function open(page) {
  const doc = await PDFDocument.create();
  const pages = [doc.addPage([500, 900]), doc.addPage([500, 900]), doc.addPage([500, 900])];
  pages.forEach((sheet, i) => sheet.drawText(`Chapter ${i + 1}`, { x: 40, y: 500, size: 20 }));
  doc.catalog.set(PDFName.of('Names'), doc.context.obj({ Dests: { Names: [PDFString.of('chapter'), [pages[2].ref, PDFName.of('XYZ'), 40, 500, null]] } }));
  pages[0].node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [30, 800, 180, 830], A: { S: 'GoTo', D: PDFString.of('chapter') } })));
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'internal-links.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.pdf-internal-link').first()).toHaveAttribute('href', '#pdf-page-3');
}
async function ctrlClick(page, link) {
  await page.keyboard.down('Control');
  await link.click();
  await page.keyboard.up('Control');
}
async function download(page) {
  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  const pending = page.waitForEvent('download');
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인', exact: true }).click();
  return readFile(await (await pending).path());
}

test('named destinations use Ctrl+click and preserve title position in both viewing modes', async ({ page }) => {
  await open(page);
  const link = page.locator('.pdf-page[data-page-number="1"] .pdf-internal-link');
  const r = await link.boundingBox();
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await expect(page.locator('.pdf-page-position-current')).toHaveValue('1');
  await ctrlClick(page, link);
  await expect(page.locator('.pdf-page-position-current')).toHaveValue('3');
  await expect.poll(() => page.locator('.pdf-page[data-page-number="3"]').evaluate((el) => {
    const viewer = el.closest('.pdf-viewer-scroll');
    return Math.abs(el.getBoundingClientRect().top + el.clientHeight * 400 / 900 - viewer.getBoundingClientRect().top - 24);
  })).toBeLessThan(8);
  await page.locator('.pdf-view-mode-toggle button').last().click();
  await page.locator('.pdf-page-position-current').fill('1');
  await page.locator('.pdf-page-position-current').press('Enter');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await ctrlClick(page, page.locator('.pdf-page[data-page-number="1"] .pdf-internal-link'));
  await expect(page.locator('.pdf-page-position-current')).toHaveValue('3');
  await expect(page.locator('.pdf-view-mode-toggle button').last()).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.pdf-page[data-page-number="3"]').evaluate((el) => {
    const viewer = el.closest('.pdf-viewer-scroll');
    const top = el.getBoundingClientRect().top + el.clientHeight * 400 / 900;
    return top >= viewer.getBoundingClientRect().top - 5 && top <= viewer.getBoundingClientRect().bottom;
  })).toBe(true);
});

test('internal link target changes, undo and removal persist in downloaded PDF', async ({ page }) => {
  await open(page);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  const link = page.locator('.pdf-page[data-page-number="1"] .pdf-internal-link');
  const rect = await link.boundingBox();
  await page.mouse.click(rect.x + 10, rect.y + 10, { button: 'right' });
  await page.getByRole('menuitem', { name: '이동 대상 변경' }).click();
  const dialog = page.getByRole('dialog', { name: '내부 링크 설정' });
  await dialog.getByRole('spinbutton').fill('2');
  await dialog.getByRole('button', { name: '확인', exact: true }).click();
  await expect(link).toHaveAttribute('href', '#pdf-page-2');
  await page.getByRole('button', { name: '적용 전으로 되돌리기', exact: true }).click();
  await expect(link).toHaveAttribute('href', '#pdf-page-3');
  await page.getByRole('button', { name: '다시 적용하기', exact: true }).click();
  await expect(link).toHaveAttribute('href', '#pdf-page-2');
  const bytes = await download(page);
  const doc = await PDFDocument.load(bytes);
  const annotation = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  expect(readInternalDestination(doc, annotation).index).toBe(1);
  await page.mouse.click(rect.x + 10, rect.y + 10, { button: 'right' });
  await page.getByRole('menuitem', { name: '내부 링크 제거', exact: true }).click();
  await expect(link).toHaveCount(0);
  const removed = await PDFDocument.load(await download(page));
  expect(removed.getPage(0).node.Annots()?.size() || 0).toBe(0);
});

test('right-clicking a hovered text box opens the internal link menu before the page dialog', async ({ page }) => {
  await open(page);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await expect(page.getByRole('button', { name: '내부 링크 영역', exact: true })).toHaveCount(0);
  const text = page.locator('.pdf-page[data-page-number="1"] .textLayer span').filter({ hasText: 'Chapter 1' }).first();
  await text.hover();
  const highlight = page.locator('.pdf-page[data-page-number="1"] .highlight-box[data-highlight-color="blue"]').first();
  await expect(highlight).toBeVisible();
  const highlightedRect = await highlight.boundingBox();
  await text.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '내부 링크 메뉴' })).toBeVisible();
  await page.getByRole('menuitem', { name: '내부 링크 설정' }).click();
  const dialog = page.getByRole('dialog', { name: '내부 링크 설정' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('menu', { name: '내부 링크 메뉴' })).toHaveCount(0);
  await dialog.getByRole('spinbutton').fill('2');
  await dialog.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-internal-link')).toHaveCount(2);
  const linkedRect = await page.locator('.pdf-page[data-page-number="1"] .pdf-internal-link[href="#pdf-page-2"]').boundingBox();
  expect(Math.abs(linkedRect.width - highlightedRect.width)).toBeLessThan(1);
  expect(Math.abs(linkedRect.height - highlightedRect.height)).toBeLessThan(1);
  const bytes = await download(page);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'saved.pdf', mimeType: 'application/pdf', buffer: bytes });
  const link = page.locator('.pdf-page[data-page-number="1"] .pdf-internal-link[href="#pdf-page-2"]');
  await expect(link).toHaveCount(1);
  await ctrlClick(page, link);
  await expect(page.locator('.pdf-page-position-current')).toHaveValue('2');
});

test('selected source text exposes the internal link setting without changing its text', async ({ page }) => {
  await open(page);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  const span = page.locator('.pdf-page[data-page-number="1"] .textLayer span').filter({ hasText: 'Chapter 1' }).first();
  await expect(span).toBeVisible();
  await span.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await span.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '내부 링크 설정' }).click();
  const dialog = page.getByRole('dialog', { name: '내부 링크 설정' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('spinbutton').fill('2');
  await dialog.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.locator('.pdf-page[data-page-number="1"] .pdf-internal-link[href="#pdf-page-2"]')).toHaveCount(1);
  await expect(span).toHaveText('Chapter 1');
  await span.click();
  await expect(page.locator('.movable-text-edit-rich')).toBeVisible();
});

test('an edited text box is the internal link area', async ({ page }) => {
  await open(page);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  const sheet = page.locator('.pdf-page[data-page-number="1"]');
  await sheet.locator('.textLayer span').filter({ hasText: 'Chapter 1' }).first().click();
  const editor = sheet.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('Chapter One');
  await editor.press('Enter');
  const box = sheet.locator('.movable-text-object:not(.is-selection-draft)');
  const bounds = await box.boundingBox();
  await box.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '내부 링크 메뉴' })).toBeVisible();
  await page.getByRole('menuitem', { name: '내부 링크 설정' }).click();
  const dialog = page.getByRole('dialog', { name: '내부 링크 설정' });
  await dialog.getByRole('spinbutton').fill('2');
  await dialog.getByRole('button', { name: '확인', exact: true }).click();
  const link = sheet.locator('.pdf-internal-link[href="#pdf-page-2"]');
  const linked = await link.boundingBox();
  expect(Math.abs(linked.width - bounds.width)).toBeLessThan(1);
  expect(Math.abs(linked.height - bounds.height)).toBeLessThan(1);
  await page.locator('.pdf-edit-mode-toggle button').first().click();
  await ctrlClick(page, link);
  await expect(page.locator('.pdf-page-position-current')).toHaveValue('2');
});

test('raster fallback preserves internal links when encrypted pages are extracted', async ({ page }) => {
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 400]);
  const second = doc.addPage([300, 400]);
  first.drawText('Contents', { x: 20, y: 300 });
  second.drawText('Target', { x: 20, y: 250 });
  first.node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 290, 150, 325], Dest: [second.ref, PDFName.of('XYZ'), 20, 250, null] })));
  const toolkit = await createPdfToolkit();
  const encrypted = await toolkit.lock(await doc.save(), { userPassword: '', ownerPassword: 'test-owner', keyLength: 256 });
  await page.goto('/');
  const bytes = await page.evaluate(async (source) => {
    const { extractPdfPages } = await import('/src/services/pdfPageExtract.js');
    return Array.from(await extractPdfPages(Uint8Array.from(source), [2, 1]));
  }, Array.from(encrypted));
  const output = await PDFDocument.load(Uint8Array.from(bytes));
  const annotation = output.context.lookup(output.getPage(1).node.Annots().get(0));
  const destination = readInternalDestination(output, annotation);
  expect(destination.index).toBe(0);
  expect(destination.values[2].asNumber()).toBe(250);
});

test('confirming an unchanged target preserves its original title coordinates', async ({ page }, testInfo) => {
  await open(page);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  const rect = await page.locator('.pdf-internal-link').first().boundingBox();
  await page.mouse.click(rect.x + 10, rect.y + 10, { button: 'right' });
  await page.getByRole('menuitem', { name: '이동 대상 변경' }).click();
  const dialog = page.getByRole('dialog', { name: '내부 링크 설정' });
  await expect(dialog.getByRole('spinbutton')).toHaveValue('3');
  await dialog.screenshot({ path: testInfo.outputPath('internal-link-dialog.png') });
  await dialog.getByRole('button', { name: '확인', exact: true }).click();
  const doc = await PDFDocument.load(await download(page));
  const destination = readInternalDestination(doc, doc.context.lookup(doc.getPage(0).node.Annots().get(0)));
  expect(destination.index).toBe(2);
  expect(destination.values[0].decodeText()).toBe('XYZ');
  expect(destination.values[1].asNumber()).toBe(40);
  expect(destination.values[2].asNumber()).toBe(500);
});
