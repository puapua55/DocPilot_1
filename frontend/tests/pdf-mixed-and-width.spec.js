import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');
const arialPath = 'C:/Windows/Fonts/arialbd.ttf';
const dotumPath = 'C:/Windows/Fonts/HANDotumB.ttf';

test('mixed source fonts stay distinct and body text has a readable edit box', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip([sourcePdf, arialPath, dotumPath].some((file) => !existsSync(file)),
    'The requested PDF or local preview fonts are unavailable');
  const arial = readFileSync(arialPath).toString('base64');
  const dotum = readFileSync(dotumPath).toString('base64');
  await page.addInitScript(({ arial, dotum }) => {
    window.docPilotFonts = {
      list: async () => [
        { candidate: 'Arial Bold', family: 'Arial', label: 'Arial Bold' },
        { candidate: 'HCR Dotum Bold', family: 'HCR Dotum', label: 'HCR Dotum Bold' }
      ],
      resolve: async ({ candidates }) => {
        const isArial = candidates.some((candidate) => /arial/i.test(candidate));
        return { found: true, base64: isArial ? arial : dotum,
          family: isArial ? 'Arial' : 'HCR Dotum', fullName: candidates[0] };
      }
    };
  }, { arial, dotum });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-edit-mode-toggle button').last().click();

  const page2 = page.locator('.pdf-page[data-page-number="2"]');
  await expect(page2.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  const checkMixedLine = async (sourceText, changeFont = false) => {
    await page2.locator('.textLayer span[data-text-item-index]').filter({ hasText: sourceText }).first().click();
    const runs = page2.locator('.movable-text-edit-rich > span');
    await expect(runs.first()).toBeVisible();
    await expect.poll(() => runs.evaluateAll((spans) =>
      spans.filter((span) => /문서/.test(span.textContent)).every((span) =>
        /^DocPilotLocalPreview\d+$/.test(span.style.fontFamily)
          && span.style.fontFamily !== spans.find((entry) => entry.textContent?.includes('PDF'))?.style.fontFamily
      ))).toBe(true);
    const fonts = await runs.evaluateAll((spans) => spans.map((span) => ({
      text: span.textContent, font: span.style.fontFamily
    })));
    expect(fonts.find((run) => run.text.includes('PDF'))?.font)
      .toBe(fonts.find((run) => run.text.includes('Word'))?.font);
    if (changeFont) {
      const editor = page2.locator('.movable-text-edit-rich');
      await editor.focus();
      await editor.press('Control+A');
      await page.locator('.pdf-text-edit-toolbar select').selectOption('Arial Bold');
      await expect.poll(() => editor.locator(':scope > span').evaluateAll((spans) =>
        new Set(spans.map((span) => span.style.fontFamily)).size)).toBe(1);
    }
    await page2.locator('.movable-text-edit-rich').press('Enter');
  };
  await checkMixedLine(/문서의 활용이 증가하면서/);
  await checkMixedLine(/문서 활용 증가/, true);

  const page3 = page.locator('.pdf-page[data-page-number="3"]');
  await expect(page3.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  const body = page3.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: /검색된 문구를 기준으로/ }).first();
  const sourceWidth = await body.evaluate((span) => span.getBoundingClientRect().width);
  await body.click();
  const layout = await page3.locator('.movable-text-object').last().evaluate((element) => {
    const editor = element.querySelector('.movable-text-edit-rich');
    const runs = [...editor.querySelectorAll(':scope > span')];
    return { text: editor.textContent, width: element.getBoundingClientRect().width,
      runTops: runs.map((run) => run.getBoundingClientRect().top) };
  });
  expect(layout.text).toBe('검색된 문구를 기준으로 사용자가 내용을 수정하거나 하이라이트 처리');
  expect(layout.width).toBeGreaterThan(sourceWidth * 1.1);
  expect(Math.max(...layout.runTops) - Math.min(...layout.runTops)).toBeLessThan(2);
});
