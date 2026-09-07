import { test, expect } from '@playwright/test';

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
