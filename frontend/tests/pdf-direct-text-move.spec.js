import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

async function upload(page) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([600, 800]);
  sheet.drawText('Move me', { x: 60, y: 700, size: 20, font });
  sheet.drawText('Keep me', { x: 60, y: 640, size: 20, font });
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'simple-move.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save())
  });
  await expect(page.locator('.textLayer').first()).toHaveAttribute('data-rendered', 'true');
}

async function selectText(page, partial = false) {
  await page.locator('.textLayer span').filter({ hasText: 'Move me' }).evaluate((span, partial) => {
    const range = document.createRange();
    if (partial) { range.setStart(span.firstChild, 0); range.setEnd(span.firstChild, 4); }
    else range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, partial);
}

async function savedText(page) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF 다운로드', exact: true }).click();
  const bytes = readFileSync(await (await download).path());
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    return (await (await pdf.getPage(1)).getTextContent()).items.filter((item) => item.str?.trim());
  } finally { await task.destroy(); }
}

test('select, drag, zoom and download removes original run at every scale', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await upload(page);
  await selectText(page);
  await expect(page.locator('.movable-text-object')).toHaveCount(0);
  await page.getByRole('button', { name: '텍스트 이동', exact: true }).click();
  await selectText(page);
  const object = page.locator('.movable-text-object');
  await expect(object).toHaveCount(1);
  const box = await object.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 70, { steps: 8 });
  await page.mouse.up();
  let baseline;
  for (const zoom of [100, 150, 200]) {
    while (parseInt(await page.locator('.zoom-value').innerText(), 10) < zoom) {
      await page.getByRole('button', { name: '확대', exact: true }).click();
    }
    await expect(page.locator('.textLayer').first()).toHaveAttribute('data-rendered', 'true');
    const items = await savedText(page);
    await expect(page.getByRole('status').filter({ hasText: '원본 텍스트 제거 1건' })).toBeVisible();
    const moved = items.filter((item) => item.str === 'Move me');
    expect(moved).toHaveLength(1);
    expect(moved[0].transform[4]).toBeCloseTo(140, 0);
    if (!baseline) baseline = moved[0].transform;
    else moved[0].transform.forEach((value, index) => expect(value).toBeCloseTo(baseline[index], 2));
    expect(items.some((item) => item.str === 'Keep me' && item.transform[5] === 640)).toBe(true);
  }
  await page.getByRole('button', { name: '전체 초기화', exact: true }).click();
  await expect(object).toHaveCount(0);
});

test('partial text selection keeps overlay fallback and reports it', async ({ page }) => {
  await upload(page);
  await page.getByRole('button', { name: '텍스트 이동', exact: true }).click();
  await selectText(page, true);
  await expect(page.locator('.movable-text-object')).toHaveCount(1);
  const items = await savedText(page);
  await expect(page.getByRole('status').filter({ hasText: '원본 텍스트 제거 0건 · 배경색 덮기 0건 · 직접 제거 미확인 1건' })).toBeVisible();
  expect(items.some((item) => item.str === 'Move me')).toBe(true);
  expect(items.some((item) => item.str === 'Move')).toBe(true);
});

test('double-clicking a selected movable text opens inline editing and saves only that item', async ({ page }) => {
  await upload(page);
  await page.getByRole('button', { name: '텍스트 이동', exact: true }).click();
  await selectText(page);
  const object = page.locator('.movable-text-object');
  await expect(object).toHaveCount(1);
  await object.dblclick();
  const editor = page.locator('.movable-text-edit-input');
  await expect(editor).toHaveValue('Move me');
  await editor.fill('Edited text');
  await editor.press('Enter');
  await expect(page.locator('.movable-text-edit-input')).toHaveCount(0);
  await expect(object).toContainText('Edited text');
  const items = await savedText(page);
  expect(items.filter((item) => item.str === 'Edited text')).toHaveLength(1);
  expect(items.some((item) => item.str === 'Move me')).toBe(false);
  expect(items.some((item) => item.str === 'Keep me')).toBe(true);
});
