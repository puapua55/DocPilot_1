import { test, expect } from '@playwright/test';

test('PDF and DOCX files larger than 50MB pass file validation', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { validateFile } = await import('/src/utils/fileUtils.js');
    const { validateDocumentFile } = await import('/src/services/fileService.js');
    const bytes = new Uint8Array(51 * 1024 * 1024);
    const pdf = new File([bytes], 'large.pdf', { type: 'application/pdf' });
    const docx = new File([bytes], 'large.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    return [
      validateFile(pdf),
      validateFile(docx),
      validateDocumentFile(pdf),
      validateDocumentFile(docx)
    ];
  });
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ valid: true, message: '' })));
});
