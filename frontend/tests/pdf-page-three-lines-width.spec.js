import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');
const arialPath = 'C:/Windows/Fonts/arialbd.ttf';
const dotumPath = 'C:/Windows/Fonts/HANDotumB.ttf';

test('colored paragraph lines keep a roomy one-line edit box', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip([sourcePdf, arialPath, dotumPath].some((file) => !existsSync(file)),
    'The requested PDF or local fonts are unavailable');
  const arial = readFileSync(arialPath).toString('base64');
  const dotum = readFileSync(dotumPath).toString('base64');
  await page.addInitScript(({ arial, dotum }) => {
    window.docPilotFonts = {
      list: async () => [],
      resolve: async ({ candidates }) => {
        const isArial = candidates.some((candidate) => /arial/i.test(candidate));
        return { found: true, base64: isArial ? arial : dotum,
          family: isArial ? 'Arial' : 'HCR Dotum', fullName: candidates[0] };
      }
    };
  }, { arial, dotum });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-page-position-current').fill('8');
  await page.locator('.pdf-page-position-current').press('Enter');
  while (Number.parseInt(await page.locator('.zoom-value').innerText(), 10) < 200) {
    await page.locator('.zoom-controls button').last().click();
  }
  const pdfPage = page.locator('.pdf-page[data-page-number="8"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();

  const fragments = ['형식의 문서를 시스템', '에 업로드할 수 있으며',
    '내에서 확인할 수 있어야 합니다', '업로드된 문서에서 텍스트를 추출하고',
    '력한 검색어와 일치하는 내용을 찾아 검색 결과로'];
  for (const fragment of fragments) {
    const source = pdfPage.locator('.textLayer span[data-text-item-index]')
      .filter({ hasText: fragment }).first();
    await expect(source).toBeVisible();
    await source.click();
    const editor = pdfPage.locator('.movable-text-edit-rich');
    await expect(editor).toBeVisible();
    const object = pdfPage.locator('.movable-text-object').last();
    await expect.poll(() => object.evaluate((element) => {
      const cover = element.parentElement.querySelector('.movable-text-cover');
      return element.getBoundingClientRect().width / cover.getBoundingClientRect().width;
    })).toBeGreaterThan(1.07);
    const details = await object.evaluate((element) => {
      const editor = element.querySelector('.movable-text-edit-rich');
      const runs = [...editor.querySelectorAll(':scope > span')];
      const cover = element.parentElement.querySelector('.movable-text-cover');
      return { text: editor.textContent, box: element.getBoundingClientRect().width,
        editorWidth: editor.getBoundingClientRect().width,
        textWidth: runs.reduce((sum, run) => sum + run.getBoundingClientRect().width, 0),
        tops: runs.map((run) => run.getBoundingClientRect().top),
        background: cover ? getComputedStyle(cover).backgroundColor : null,
        coverWidth: cover?.getBoundingClientRect().width };
    });
    expect(details.text).toContain(fragment);
    expect(details.box).toBeGreaterThan(details.textWidth * 1.07);
    expect(details.box).toBeGreaterThan(details.coverWidth * 1.07);
    expect(Math.max(...details.tops) - Math.min(...details.tops)).toBeLessThan(3);
    expect(details.background).not.toBe('rgb(255, 255, 255)');
    await editor.press('Enter');
  }
});
