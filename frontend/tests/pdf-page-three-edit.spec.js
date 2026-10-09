import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');
const previewFontPath = 'C:/Windows/Fonts/HANDotumB.ttf';

test('page three colored text and title remain readable while editing', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(sourcePdf) || !existsSync(previewFontPath), 'The requested PDF or local preview font is unavailable');
  await page.addInitScript((base64) => {
    window.docPilotFonts = {
      list: async () => [{ candidate: 'Arial Bold', family: 'Arial', label: 'Arial Bold' }],
      resolve: async () => ({ found: true, base64, family: 'Arial', fullName: 'Arial Bold' })
    };
  }, readFileSync(previewFontPath).toString('base64'));
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(sourcePdf);
  await page.locator('.pdf-page-position-current').fill('3');
  await page.locator('.pdf-page-position-current').press('Enter');
  while (Number.parseInt(await page.locator('.zoom-value').innerText(), 10) < 200) {
    await page.locator('.zoom-controls button').last().click();
  }
  const pdfPage = page.locator('.pdf-page[data-page-number="3"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();

  const blueText = pdfPage.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: /검색 결과에서 특정 문구를/ }).first();
  await blueText.click();
  const blueColors = await pdfPage.locator('.movable-text-object').last().evaluate((element) => {
    const edit = element.querySelector('.movable-text-edit-rich, .movable-text-edit-input');
    const cover = element.parentElement.querySelector('.movable-text-cover');
    return { color: getComputedStyle(element).color,
      background: getComputedStyle(edit).backgroundColor,
      cover: cover ? getComputedStyle(cover).backgroundColor : null };
  });
  expect(blueColors.background).toBe(blueColors.cover);
  expect(blueColors.background).not.toBe('rgb(255, 255, 255)');
  expect(blueColors.color).toBe('rgb(251, 246, 241)');
  await pdfPage.locator('.movable-text-edit-rich').press('Enter');
  const title = pdfPage.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: /핵심 요구사항/ }).first();
  await title.click();
  await page.evaluate(() => document.fonts.ready);
  const titleLayout = await pdfPage.locator('.movable-text-object').last().evaluate((element) => {
    const runs = [...element.querySelectorAll('.movable-text-edit-rich > span')];
    return {
      boxWidth: element.getBoundingClientRect().width,
      textWidth: runs.reduce((sum, span) => sum + span.getBoundingClientRect().width, 0),
      runTops: runs.map((span) => span.getBoundingClientRect().top),
      text: element.textContent
    };
  });
  expect(titleLayout.text).toBe('핵심 요구사항 2');
  expect(titleLayout.boxWidth).toBeGreaterThan(titleLayout.textWidth * 1.15);
  expect(Math.max(...titleLayout.runTops) - Math.min(...titleLayout.runTops)).toBeLessThan(2);
});
