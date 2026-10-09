import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

test('inserting another PDF updates page order, later deletion, undo, redo, and download', async ({ page }) => {
  const source = await PDFDocument.create();
  for (const width of [201, 202, 203]) source.addPage([width, 300]);
  const addition = await PDFDocument.create();
  for (const width of [301, 302]) addition.addPage([width, 300]);
  const additionBytes = Buffer.from(await addition.save());

  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  await expect(page.locator('.pdf-page')).toHaveCount(3);
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('button', { name: '삽입', exact: true }).click();
  await page.locator('#pdf-insert-file').setInputFiles({
    name: 'addition.pdf', mimeType: 'application/pdf', buffer: additionBytes
  });
  await page.getByRole('combobox', { name: '삽입 위치' }).selectOption('after');
  await page.getByRole('spinbutton', { name: '몇 페이지 뒤' }).fill('1');
  await page.getByRole('button', { name: 'PDF 삽입', exact: true }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(5);

  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('textbox', { name: '삭제할 PDF 페이지 범위' }).fill('4');
  await page.getByRole('button', { name: '선택 페이지 삭제' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(4);
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('button', { name: '적용 전으로 되돌리기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(5);
  await page.getByRole('button', { name: '적용 전으로 되돌리기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(3);
  await page.getByRole('button', { name: '다시 적용하기' }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(5);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인' }).click();
  const result = await PDFDocument.load(await readFile(await (await downloadPromise).path()));
  expect(result.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([201, 301, 302, 202, 203]);
});

test('unsaved edits remain on their shifted page after insertion', async ({ page }) => {
  test.setTimeout(120_000);
  const source = await PDFDocument.create();
  source.addPage([500, 500]);
  source.addPage([500, 500]);
  const addition = await PDFDocument.create();
  addition.addPage([400, 400]);
  await page.addInitScript(() => {
    window.docPilotFonts = { list: async () => [], resolve: async () => ({ found: false }) };
  });
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'edited-source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  const secondPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(secondPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByRole('button', { name: '텍스트 추가' }).click();
  await secondPage.scrollIntoViewIfNeeded();
  const bounds = await secondPage.boundingBox();
  const viewerBounds = await page.locator('.pdf-viewer-scroll').boundingBox();
  const startY = Math.max(bounds.y + 90, viewerBounds.y + 40);
  await page.mouse.move(bounds.x + 60, startY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 180, startY + 50, { steps: 8 });
  await page.mouse.up();
  const editor = secondPage.locator('.movable-text-edit-rich');
  await editor.fill('SHIFTED EDIT');
  await editor.press('Control+Enter');

  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('button', { name: '삽입', exact: true }).click();
  await page.locator('#pdf-insert-file').setInputFiles({
    name: 'inserted.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await addition.save())
  });
  await page.getByRole('combobox', { name: '삽입 위치' }).selectOption('front');
  await page.getByRole('button', { name: 'PDF 삽입', exact: true }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(3);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인' }).click();
  const bytes = await readFile(await (await downloadPromise).path());
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const text = await (await pdf.getPage(3)).getTextContent();
    expect(text.items.map((item) => item.str).join(' ')).toContain('SHIFTED EDIT');
  } finally {
    await task.destroy();
  }
});

test('selecting 맨 뒤 appends every page of the added PDF', async ({ page }) => {
  const source = await PDFDocument.create();
  source.addPage([201, 300]);
  const addition = await PDFDocument.create();
  addition.addPage([301, 300]);
  addition.addPage([302, 300]);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  await expect(page.locator('.pdf-page')).toHaveCount(1);
  await page.getByRole('button', { name: '편집', exact: true }).click();
  await page.getByRole('button', { name: '페이지 작업', exact: true }).click();
  await page.getByRole('button', { name: '삽입', exact: true }).click();
  await page.locator('#pdf-insert-file').setInputFiles({
    name: 'addition.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await addition.save())
  });
  const position = page.getByRole('combobox', { name: '삽입 위치' });
  await position.selectOption('end');
  await expect(page.getByRole('spinbutton', { name: '몇 페이지 뒤' })).toHaveCount(0);
  await page.getByRole('button', { name: 'PDF 삽입', exact: true }).click();
  await expect(page.locator('.pdf-page')).toHaveCount(3);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인' }).click();
  const result = await PDFDocument.load(await readFile(await (await downloadPromise).path()));
  expect(result.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([201, 301, 302]);
});
