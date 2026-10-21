import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sourcePath = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');

async function selectPart(page, bytes, word, startOnText = false) {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'partial-area.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  const sheet = page.locator('.pdf-page[data-page-number="1"]');
  await expect(sheet.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.getByRole('button', { name: '영역지정', exact: true }).click();
  const span = sheet.locator('.textLayer span[data-text-item-index]').filter({ hasText: word }).first();
  await span.scrollIntoViewIfNeeded();
  const rect = await span.evaluate((element, text) => {
    const start = element.textContent.indexOf(text);
    const range = document.createRange();
    range.setStart(element.firstChild, start);
    range.setEnd(element.firstChild, start + text.length);
    const r = range.getBoundingClientRect();
    const p = element.closest('.pdf-page').getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      relative: { x: (r.left - p.left) / p.width, y: (r.top - p.top) / p.height, width: r.width / p.width, height: r.height / p.height } };
  }, word);
  await page.mouse.move(rect.left + (startOnText ? 0.2 : -1), rect.top + (startOnText ? 1 : -3));
  await page.mouse.down();
  await page.mouse.move(rect.right + 0.3, rect.bottom + 2, { steps: 7 });
  await page.mouse.up();
  const editor = sheet.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText(word);
  await expect(sheet.locator('.movable-text-object')).toHaveCount(1);
  return { editor, rect: rect.relative };
}
async function download(page) {
  await page.locator('.viewer-download-actions .viewer-download-button.pdf').first().click();
  const pending = page.waitForEvent('download');
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인', exact: true }).click();
  return readFile(await (await pending).path());
}
async function compareOutsideSelection(page, source, saved, rect, testInfo) {
  const result = await page.evaluate(async ({ source, saved, rect }) => {
    const { loadPdfDocument } = await import('/src/services/pdfService.js');
    const render = async (bytes) => {
      const { pdf, loadingTask } = await loadPdfDocument(Uint8Array.from(bytes).buffer);
      try {
        const sheet = await pdf.getPage(1);
        const viewport = sheet.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        await sheet.render({ canvasContext: context, viewport }).promise;
        return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height, png: canvas.toDataURL() };
      } finally { await loadingTask.destroy(); }
    };
    const first = await render(source);
    const second = await render(saved);
    let outside = 0; let inside = 0;
    for (let y = 0; y < first.height; y += 1) for (let x = 0; x < first.width; x += 1) {
      const index = (y * first.width + x) * 4;
      const changed = [0, 1, 2].some((channel) => Math.abs(first.data[index + channel] - second.data[index + channel]) > 12);
      if (!changed) continue;
      if (x >= rect.x * first.width - 5 && x <= (rect.x + rect.width) * first.width + 5
        && y >= rect.y * first.height - 5 && y <= (rect.y + rect.height) * first.height + 5) inside += 1;
      else outside += 1;
    }
    return { inside, outside, before: first.png, after: second.png };
  }, { source: Array.from(source), saved: Array.from(saved), rect });
  if (result.outside >= 10) {
    await writeFile(testInfo.outputPath('before.png'), Buffer.from(result.before.split(',')[1], 'base64'));
    await writeFile(testInfo.outputPath('after.png'), Buffer.from(result.after.split(',')[1], 'base64'));
    await writeFile(testInfo.outputPath('saved.pdf'), saved);
  }
  return result;
}

test('a partial area can start on a text span and changes only the chosen word', async ({ page }, testInfo) => {
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]).drawText('Document search and editing program', { x: 30, y: 160, size: 22 });
  const source = await doc.save();
  const { editor, rect } = await selectPart(page, source, 'and', true);
  await editor.fill('or');
  const saved = await download(page);
  const difference = await compareOutsideSelection(page, source, saved, rect, testInfo);
  expect(difference.inside).toBeGreaterThan(10);
  expect(difference.outside).toBeLessThan(10);
});

test('a changed word joins its paragraph editor and the edited line remains area selectable', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]).drawText('Document search and editing program', { x: 30, y: 160, size: 22 });
  const source = await doc.save();
  const { editor } = await selectPart(page, source, 'and', true);
  await editor.fill('or');
  await editor.press('Enter');
  const sheet = page.locator('.pdf-page[data-page-number="1"]');
  const sourceSpan = sheet.locator('.textLayer span[data-text-item-index]').filter({ hasText: 'Document search' }).first();
  const start = await sourceSpan.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 8);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(start.x, start.y);
  const paragraph = sheet.locator('.movable-text-edit-rich');
  await expect(paragraph).toBeVisible();
  await expect(paragraph).toHaveText('Document search or editing program');
  await paragraph.fill('Document search or editing example');
  await paragraph.press('Enter');
  await expect(sheet.locator('.movable-text-object:not(.is-selection-draft)')).toHaveCount(1);

  const word = await sheet.locator('.movable-text-object:not(.is-selection-draft)').evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf('editing');
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + 7);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }
    return null;
  });
  expect(word).toBeTruthy();
  await page.mouse.move(word.left - 1, word.top - 3);
  await page.mouse.down();
  await page.mouse.move(word.right + 1, word.bottom + 2, { steps: 7 });
  await page.mouse.up();
  const second = sheet.locator('.movable-text-edit-rich');
  await expect(second).toBeVisible();
  await expect(second).toHaveText('editing');
});

test('the actual cover title allows selecting only 프로그램 without rewriting an unchanged selection', async ({ page }) => {
  test.skip(!existsSync(sourcePath), 'Local cover PDF is unavailable');
  const source = await readFile(sourcePath);
  await selectPart(page, source, '프로그램');
  expect((await download(page)).equals(source)).toBe(true);
});

test('the actual cover title allows changing only 및 while keeping the rest in place', async ({ page }, testInfo) => {
  test.skip(!existsSync(sourcePath), 'Local cover PDF is unavailable');
  const source = await readFile(sourcePath);
  const { editor, rect } = await selectPart(page, source, '및', true);
  await editor.fill('와');
  const difference = await compareOutsideSelection(page, source, await download(page), rect, testInfo);
  expect(difference.inside).toBeGreaterThan(10);
  expect(difference.outside).toBeLessThan(10);
});

test('explicit blue highlights remain in the saved PDF while hover markings are excluded', async ({ page }, testInfo) => {
  const doc = await PDFDocument.create();
  doc.addPage([500, 300]).drawText('Document search and editing program', { x: 30, y: 160, size: 22 });
  const source = await doc.save();
  const { editor, rect } = await selectPart(page, source, 'program');
  await editor.press('Enter');
  await page.getByText('위치 하이라이트', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.getByPlaceholder('하이라이트할 단어 또는 문장을 입력하세요').fill('program');
  await dialog.getByRole('button', { name: '검색', exact: true }).click();
  await dialog.locator('.highlight-result-row').first().click();
  await dialog.locator('.highlight-result-color-select').first().selectOption('blue');
  await dialog.getByRole('button', { name: '적용', exact: true }).click();
  await expect(dialog).toContainText('총 1건');
  await dialog.locator('.search-modal-close').click();
  const difference = await compareOutsideSelection(page, source, await download(page), rect, testInfo);
  expect(difference.inside).toBeGreaterThan(10);
  expect(difference.outside).toBeLessThan(10);
});
