export async function downloadDocxFromPreview(page) {
  await page.locator('.viewer-download-button.docx').click();
  const dialog = page.getByRole('dialog', { name: 'DOCX 다운로드 미리보기' });
  await dialog.getByRole('button', { name: '확인', exact: true }).waitFor();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '확인', exact: true }).click();
  return pending;
}
