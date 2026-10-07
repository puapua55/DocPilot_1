import { test, expect } from '@playwright/test';

test('existing blank Word paragraphs stay editable without moving the tables', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles('../테스트1_docx_converted.docx');
  const section = page.locator('.docx-content section.docx').first();
  await expect(section).toBeVisible();
  const tablePositions = () => section.evaluate((node) => Array.from(node.querySelectorAll('table'))
    .map((table) => table.getBoundingClientRect().top - node.getBoundingClientRect().top));
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  await expect.poll(() => section.locator('[data-docx-paragraph-index]').count()).toBeGreaterThan(0);
  const before = await tablePositions();
  const emptyIndex = await section.evaluate((node) => {
    const pageRect = node.getBoundingClientRect();
    return Array.from(node.querySelectorAll('p[data-docx-paragraph-index]'))
      .find((paragraph) => !paragraph.closest('table') && !paragraph.textContent.trim()
        && paragraph.getBoundingClientRect().top < pageRect.bottom)?.dataset.docxParagraphIndex;
  });
  expect(emptyIndex).toBeTruthy();
  const blank = section.locator(`p[data-docx-paragraph-index="${emptyIndex}"]`);
  await blank.click();
  await expect(blank).toHaveAttribute('contenteditable', 'true');
  await section.click({ position: { x: 20, y: 300 } });
  await section.click({ position: { x: 20, y: 300 } });
  await expect(section.locator('.docx-added-paragraph')).toHaveCount(0);
  const after = await tablePositions();
  after.forEach((position, index) => expect(Math.abs(position - before[index])).toBeLessThan(1.5));
});
