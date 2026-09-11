import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, 'fixtures', '테스트1(3).docx');

test('capture DocPilot main page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByText('DocPilot AI')).toBeVisible();
  await expect(page.getByText('문서를 선택하세요')).toBeVisible();
  await page.screenshot({
    path: 'test-artifacts/docpilot-main-page.png',
    fullPage: true
  });
});

test('capture full DocPilot screen after DOCX upload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');

  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);

  await expect(page.getByText('테스트1(3).docx', { exact: true })).toBeVisible();
  await expect(page.locator('.word-document').first()).toBeVisible();
  await expect(page.getByText('DocPilot AI', { exact: true })).toBeVisible();
  await expect(page.getByText('정확한 문서 검색', { exact: true })).toBeVisible();
  await expect(page.getByText('위치 하이라이트', { exact: true })).toBeVisible();
  await expect(page.getByText('즉시 텍스트 교체', { exact: true })).toBeVisible();

  await page.screenshot({
    path: 'test-artifacts/docpilot-docx-upload-fullscreen.png',
    fullPage: true
  });
});
