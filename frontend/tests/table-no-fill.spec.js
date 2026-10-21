import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { readPdfTables } from '../src/services/pdfTableService.js';

test('PDF table cells can be saved without a background color', async ({ page }) => {
  const source = await PDFDocument.create();
  source.addPage([500, 500]);
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'no-fill.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  const pdfPage = page.locator('.pdf-page[data-page-number="1"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.getByRole('button', { name: '표 추가' }).click();
  await page.getByRole('button', { name: '1행 1열 선택' }).click();
  const cell = pdfPage.locator('.pdf-table-cell');
  await cell.click();
  await page.locator('.pdf-table-toolbar').getByRole('tab', { name: '셀 서식' }).click();
  const noColor = page.locator('.pdf-table-toolbar').getByLabel('표 색상 없음');
  await noColor.check();
  await expect(cell).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.pdf-table-toolbar').getByLabel('셀 배경색')).toBeDisabled();

  const downloadEvent = page.waitForEvent('download');
  await page.locator('.viewer-download-button.pdf').click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인' }).click();
  const bytes = await readFile(await (await downloadEvent).path());
  const [saved] = await readPdfTables({ arrayBuffer: async () => bytes });
  expect(saved.cellStyles[0].fillNone).toBe(true);
});

test('DOCX table cells can be saved without a background color', async ({ page }) => {
  const zip = await JSZip.loadAsync(await readFile('../sample.docx'));
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>
        <w:tcPr><w:shd w:val="clear" w:fill="FF0000"/></w:tcPr><w:p><w:r><w:t>셀</w:t></w:r></w:p>
      </w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
    </w:body></w:document>`);
  const source = await zip.generateAsync({ type: 'nodebuffer' });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'no-fill.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: source
  });
  const table = page.locator('.docx-content section.docx table').first();
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute('data-docx-table-id', 'original-0');
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  await expect(page.locator('.docx-format-toolbar')).toBeVisible();
  const cell = table.locator('td, th').first();
  await cell.click();
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  await page.locator('.docx-table-toolbar').getByRole('tab', { name: '셀 서식' }).click();
  const noColor = page.locator('.docx-table-toolbar').getByLabel('표 색상 없음');
  await noColor.check();
  await expect(cell).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.docx-table-toolbar').getByLabel('셀 배경색')).toBeDisabled();

  const downloadEvent = page.waitForEvent('download');
  await page.locator('.viewer-download-button.docx').click();
  const savedZip = await JSZip.loadAsync(await readFile(await (await downloadEvent).path()));
  const xml = await savedZip.file('word/document.xml').async('string');
  expect(xml).toMatch(/w:shd[^>]*w:val="nil"/);
  expect(xml).not.toMatch(/w:shd[^>]*w:fill="FF0000"/);
});
