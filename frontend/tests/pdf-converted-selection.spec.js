import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const sourcePath = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램_overlay_converted.pdf');

async function openSecondPage(page) {
  test.skip(!existsSync(sourcePath), 'Local converted PDF is unavailable');
  const bytes = await readFile(sourcePath);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'converted.pdf', mimeType: 'application/pdf', buffer: bytes });
  const sheet = page.locator('.pdf-page[data-page-number="2"]');
  await sheet.scrollIntoViewIfNeeded();
  await expect(sheet.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  return sheet;
}

test('converted PDF selects its visible replacement line once in reading order', async ({ page }) => {
  const sheet = await openSecondPage(page);
  const result = await sheet.evaluate((element) => {
    const spans = Array.from(element.querySelectorAll('.textLayer span[data-text-item-index]'));
    const title = spans.find((span) => span.textContent === '프로젝트');
    const replacement = spans.find((span) => span.textContent === '찾고,');
    const next = spans.find((span) => span.textContent.startsWith('문서나 편집이'));
    const last = spans.find((span) => span.textContent.includes('yy'));
    const range = document.createRange();
    range.setStart(title.firstChild, 0);
    range.setEnd(last.firstChild, last.textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    return { order: [spans.indexOf(title), spans.indexOf(replacement), spans.indexOf(next)],
      text: selection.toString(), oldLinePresent: spans.some((span) => span.textContent.startsWith('찾고 수정해야')) };
  });
  expect(result.oldLinePresent).toBe(false);
  expect(result.order[0]).toBeLessThan(result.order[1]);
  expect(result.order[1]).toBeLessThan(result.order[2]);
  expect(result.text).toContain('찾고,');
  expect(result.text).not.toContain('찾고 수정해야');
  expect(result.text.match(/찾고,/g)).toHaveLength(1);
  const points = await sheet.evaluate((element) => {
    const spans = Array.from(element.querySelectorAll('.textLayer span[data-text-item-index]'));
    const first = spans.find((span) => span.textContent === '프로젝트').getBoundingClientRect();
    const last = spans.find((span) => span.textContent.includes('yy')).getBoundingClientRect();
    return { start: { x: first.left + 2, y: (first.top + first.bottom) / 2 },
      end: { x: last.right - 1, y: (last.top + last.bottom) / 2 } };
  });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 10 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.getSelection()?.toString() || '');
  expect(dragged).toContain('찾고,');
  expect(dragged).toContain('.yy');
  expect(dragged).not.toContain('찾고 수정해야');
  expect(dragged.match(/찾고,/g)).toHaveLength(1);
});

test('a partial edit joins its paragraph and its internal link remains clickable', async ({ page }) => {
  const sheet = await openSecondPage(page);
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.getByRole('button', { name: '영역지정', exact: true }).click();
  const word = await sheet.locator('.textLayer span[data-text-item-index]').filter({ hasText: 'FFD' }).first()
    .evaluate((span) => {
      const range = document.createRange(); range.selectNodeContents(span);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
  await page.mouse.move(word.left - 1, word.top - 3);
  await page.mouse.down();
  await page.mouse.move(word.right + 1, word.bottom + 2, { steps: 5 });
  await page.mouse.up();
  const editor = sheet.locator('.movable-text-edit-rich');
  await expect(editor).toHaveText('FFD');
  await editor.fill('ABC');
  await editor.press('Enter');
  await sheet.locator('.movable-text-object').first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '이동 대상 변경' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '내부 링크 제거' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '하이퍼링크 제거' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const wordSpan = sheet.locator('.textLayer span[data-text-item-index="66"]');
  const spot = await wordSpan.evaluate((span) => {
    const rect = span.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(spot.x, spot.y);
  await expect(editor).toContainText('ABC');
  await expect(editor).not.toContainText('FFD');
  await editor.fill((await editor.textContent()).replace('증가', '확대'));
  expect(await editor.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('pre');
  await expect(sheet.locator('.movable-text-object')).toHaveCount(2);
  await editor.press('Enter');
  const part = await sheet.locator('.movable-text-object').last().evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf('Word');
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + 4);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }
    return null;
  });
  expect(part).toBeTruthy();
  await page.mouse.move(part.left - 1, part.top - 3);
  await page.mouse.down();
  await page.mouse.move(part.right + 1, part.bottom + 2, { steps: 5 });
  await page.mouse.up();
  await expect(editor).toHaveText('Word');
  await editor.press('Enter');
  await page.locator('.pdf-edit-mode-toggle button').first().click();
  const link = sheet.locator('.pdf-internal-link[href="#pdf-page-3"]').last();
  await expect(link).toHaveCount(1);
  await page.keyboard.down('Control');
  await link.click();
  await page.keyboard.up('Control');
  await expect(page.locator('.pdf-page-position-current')).toHaveValue('3');
});
