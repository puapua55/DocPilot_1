import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const sourcePdf = path.resolve('..', 'DocPilot_문서 검색 및 편집 지원 프로그램.pdf');

test('editor uses the resolved preview font for the selected Korean title', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!existsSync(sourcePdf), 'The requested local PDF is unavailable');
  await page.addInitScript(() => {
    window.docPilotFonts = {
      list: async () => [],
      resolve: async () => ({
        found: true,
        base64: await fetch('/fonts/NotoSansKR-Regular.base64.txt').then((response) => response.text()),
        family: 'Preview Test',
        fullName: 'Preview Test'
      })
    };
  });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(sourcePdf);
  const firstPage = page.locator('.pdf-page[data-page-number="1"]');
  await expect(firstPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  const title = firstPage.locator('.textLayer span[data-text-item-index]')
    .filter({ hasText: /문서 검색 및 편집 지원 프로그램/ }).first();
  await expect(title).toBeVisible();
  await title.click();
  const editorRun = firstPage.locator('.movable-text-edit-rich > span').first();
  await expect(editorRun).toBeVisible();
  await expect.poll(() => editorRun.evaluate((element) => element.style.fontFamily))
    .toMatch(/^DocPilotLocalPreview\d+$/);
  await firstPage.locator('.movable-text-edit-rich').press('Enter');
  const committedRun = firstPage.locator('.movable-text-object > span').first();
  await expect(committedRun).toBeVisible();
  await expect.poll(() => committedRun.evaluate((element) => element.style.fontFamily))
    .toMatch(/^DocPilotLocalPreview\d+$/);
});
