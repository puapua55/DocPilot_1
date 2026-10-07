import { test, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

test('mixed-font textbox keeps each source font after another textbox is added', async ({ page }) => {
  test.setTimeout(120_000);
  const downloads = process.env.DOCPILOT_PDF_DIR || 'C:/Users/Qaz/Downloads';
  const name = existsSync(downloads) ? readdirSync(downloads).find((entry) => entry.startsWith('DocPilot_')
    && entry.endsWith('.pdf') && !entry.includes('overlay_converted')
    && !entry.includes('html_converted') && !/ \(\d+\)\.pdf$/.test(entry)) : null;
  test.skip(!name, 'A local mixed-font DocPilot source PDF is required');

  await page.addInitScript(() => {
    window.docPilotFonts = {
      list: async () => [
        { candidate: 'Arial Bold', family: 'Arial', label: 'Arial Bold' },
        { candidate: 'HCR Dotum Bold', family: 'HCR Dotum', label: '함초롬돋움 Bold' }
      ],
      resolve: async () => ({ found: false })
    };
  });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(path.join(downloads, name));
  const pdfPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();

  const pdfSpans = pdfPage.locator('.textLayer span[data-text-item-index]').filter({ hasText: /^PDF$/ });
  const positions = await pdfSpans.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  }));
  const rightmost = positions.reduce((best, position, index) => position.x > positions[best].x ? index : best, 0);
  await pdfSpans.nth(rightmost).click();
  const editor = page.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();

  const inspect = async (stage) => {
    const runs = await editor.locator(':scope > span').evaluateAll((spans) => spans.map((span) => ({
      text: span.textContent,
      font: span.style.fontFamily
    })));
    await editor.evaluate((element) => {
      const span = [...element.querySelectorAll(':scope > span')].find((entry) => /문서|활용|증가/.test(entry.textContent));
      if (!span?.firstChild) throw new Error('Korean font run not found');
      const range = document.createRange();
      range.setStart(span.firstChild, 0);
      range.setEnd(span.firstChild, Math.min(2, span.firstChild.textContent.length));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const fontValue = await page.locator('.pdf-text-edit-toolbar select').inputValue();
    await editor.evaluate((element) => {
      const span = [...element.querySelectorAll(':scope > span')].find((entry) => entry.textContent === 'PDF');
      if (!span?.firstChild) throw new Error('English font run not found');
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const englishFontValue = await page.locator('.pdf-text-edit-toolbar select').inputValue();
    console.log(stage, JSON.stringify({ runs, fontValue, englishFontValue }));
    return { runs, fontValue, englishFontValue };
  };

  const before = await inspect('first edit');
  await editor.press('Enter');
  console.log('after first commit', JSON.stringify(await pdfPage.locator('.movable-text-object').first()
    .locator(':scope > span').evaluateAll((spans) => spans.map((span) => span.textContent))));
  const second = pdfPage.locator('.textLayer span[data-text-item-index]').filter({ hasText: /제한된/ }).first();
  await second.click();
  await expect(editor).toBeVisible();
  await editor.press('Enter');
  console.log('after second commit', JSON.stringify(await pdfPage.locator('.movable-text-object').first()
    .locator(':scope > span').evaluateAll((spans) => spans.map((span) => span.textContent))));
  await pdfPage.locator('.movable-text-object').first().click();
  await expect(editor).toBeVisible();
  await expect(pdfPage.locator('.movable-text-object')).toHaveCount(2);
  const after = await inspect('reopened');
  expect(before.runs.length).toBeGreaterThan(1);
  expect(after.runs.length).toBeGreaterThan(1);
  expect(after.fontValue).toBe(before.fontValue);
  expect(after.fontValue).toContain('HCR');
  expect(after.englishFontValue).toBe(before.englishFontValue);
  expect(after.englishFontValue).toContain('Arial');
});

test('area-created textbox keeps mixed fonts and formats only the selected text', async ({ page }) => {
  test.setTimeout(120_000);
  const downloads = process.env.DOCPILOT_PDF_DIR || 'C:/Users/Qaz/Downloads';
  const name = existsSync(downloads) ? readdirSync(downloads).find((entry) => entry.startsWith('DocPilot_')
    && entry.endsWith('.pdf') && !entry.includes('overlay_converted')
    && !entry.includes('html_converted') && !/ \(\d+\)\.pdf$/.test(entry)) : null;
  test.skip(!name, 'A local mixed-font DocPilot source PDF is required');

  await page.addInitScript(() => {
    window.docPilotFonts = {
      list: async () => [
        { candidate: 'Arial Bold', family: 'Arial', label: 'Arial Bold' },
        { candidate: 'HCR Dotum Bold', family: 'HCR Dotum', label: 'HCR Dotum Bold' }
      ],
      resolve: async () => ({ found: false })
    };
  });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(path.join(downloads, name));
  const pdfPage = page.locator('.pdf-page[data-page-number="2"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();

  const area = await pdfPage.evaluate((pageElement) => {
    const spans = [...pageElement.querySelectorAll('.textLayer span[data-text-item-index]')]
      .filter((span) => span.textContent === 'PDF');
    const target = spans.reduce((rightmost, span) =>
      span.getBoundingClientRect().left > rightmost.getBoundingClientRect().left ? span : rightmost);
    const pdfRect = target.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    return {
      startX: pageRect.left + pageRect.width * 0.54,
      startY: pdfRect.top - 4,
      endX: pageRect.right - 10,
      endY: pdfRect.bottom + 4
    };
  });
  await page.mouse.move(area.startX, area.startY);
  await page.mouse.down();
  await page.mouse.move(area.endX, area.endY, { steps: 8 });
  await page.mouse.up();

  const editor = page.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  const getRuns = () => editor.locator(':scope > span').evaluateAll((spans) =>
    spans.map((span) => ({ text: span.textContent, weight: span.style.fontWeight })));
  const selectRun = async (match) => {
    await editor.evaluate((element, pattern) => {
      const span = [...element.querySelectorAll(':scope > span')]
        .find((entry) => pattern === 'korean' ? /[가-힣]/u.test(entry.textContent) : entry.textContent === 'PDF');
      if (!span?.firstChild) throw new Error(`Missing ${pattern} font run`);
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, match);
  };
  const initialRuns = await getRuns();
  expect(initialRuns.length).toBeGreaterThan(1);
  await selectRun('korean');
  await expect(page.locator('.pdf-text-edit-toolbar select')).toHaveValue('HCR Dotum Bold');
  await selectRun('english');
  await expect(page.locator('.pdf-text-edit-toolbar select')).toHaveValue('Arial Bold');
  await page.locator('.pdf-text-edit-toolbar button').filter({ hasText: '가' }).first().click();
  const changedRuns = await getRuns();
  expect(changedRuns.find((run) => run.text === 'PDF')?.weight).toBe('normal');
  expect(changedRuns.find((run) => /[가-힣]/u.test(run.text))?.weight).toBe('700');
  await editor.press('Enter');
  await pdfPage.locator('.movable-text-object').first().click();
  await expect(editor).toBeVisible();
  const reopenedRuns = await getRuns();
  expect(reopenedRuns.find((run) => run.text === 'PDF')?.weight).toBe('normal');
  expect(reopenedRuns.find((run) => /[가-힣]/u.test(run.text))?.weight).toBe('700');
  await selectRun('korean');
  await expect(page.locator('.pdf-text-edit-toolbar select')).toHaveValue('HCR Dotum Bold');
  await selectRun('english');
  await expect(page.locator('.pdf-text-edit-toolbar select')).toHaveValue('Arial Bold');
});
