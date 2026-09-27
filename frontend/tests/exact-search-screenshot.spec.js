import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, 'fixtures', '테스트1(3).docx');

test('테스트1(3).docx 정확한 문서 검색 결과 팝업을 캡처한다', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');

  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
  await expect(page.locator('.word-document').first()).toBeVisible();

  await page.getByText('정확한 문서 검색', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('테스트1(3).docx', { exact: true })).toBeVisible();
  await expect(dialog.getByText('DOCX', { exact: true })).toBeVisible();

  await dialog.getByPlaceholder('검색어를 입력하세요').fill('테스트');
  await dialog.getByRole('button', { name: '검색', exact: true }).click();

  const status = dialog.locator('.search-status');
  await expect(status).toBeVisible();
  await expect(status).not.toContainText('문서를 검색하는 중입니다.');
  await expect(dialog.locator('.search-result-summary')).toBeVisible();

  await page.screenshot({
    path: 'test-artifacts/docpilot-exact-search-test-docx.png',
    fullPage: true
  });
});
