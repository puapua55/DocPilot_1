import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.join(__dirname, 'fixtures', '테스트1.docx');

function getDocumentXml(buffer) {
  const zip = new PizZip(buffer);
  return zip.file('word/document.xml')?.asText() || '';
}

function countMatches(source, pattern) {
  return (String(source || '').match(pattern) || []).length;
}

function getXmlSummary(xmlText) {
  return {
    hasWDocument: xmlText.includes('<w:document'),
    hasNs0Document: xmlText.includes('<ns0:document'),
    wTextCount: countMatches(xmlText, /<w:t\b/g),
    sectPrCount: countMatches(xmlText, /:sectPr\b/g),
    tblCount: countMatches(xmlText, /:tbl\b/g)
  };
}

test('DOCX [변환]은 실제 DOCX를 수정해 다운로드하고 재업로드할 수 있다', async ({ page }, testInfo) => {
  await page.goto('/');

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(FIXTURE_PATH);

  const viewer = page.locator('.word-document');
  await expect(viewer).toContainText('테스트1');
  await expect(viewer).toContainText('테스트2');
  await expect(viewer).toContainText('테스트3');

  await page.getByRole('button', { name: /즉시 텍스트 교체/ }).click();
  await page.getByLabel('기존 단어').fill('테스트');
  await page.getByLabel('변경 단어').fill('시험');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '변환', exact: true }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('테스트1_docx_converted.docx');

  const downloadedPath = testInfo.outputPath('테스트1_docx_converted.docx');
  await download.saveAs(downloadedPath);

  const [originalBuffer, convertedBuffer] = await Promise.all([
    readFile(FIXTURE_PATH),
    readFile(downloadedPath)
  ]);

  const originalXml = getDocumentXml(originalBuffer);
  const convertedXml = getDocumentXml(convertedBuffer);
  const before = getXmlSummary(originalXml);
  const after = getXmlSummary(convertedXml);

  expect(convertedXml).toContain('시험1');
  expect(convertedXml).toContain('시험2');
  expect(convertedXml).toContain('시험3');
  expect(convertedXml).not.toContain('테스트');

  expect(after.hasWDocument).toBe(before.hasWDocument);
  expect(after.hasWDocument).toBe(true);
  expect(after.hasNs0Document).toBe(false);
  expect(after.wTextCount).toBe(before.wTextCount);
  expect(after.sectPrCount).toBe(before.sectPrCount);
  expect(after.tblCount).toBe(before.tblCount);

  await expect(page.getByText(/DOCX 파일 변환 완료/)).toBeVisible();

  await page.getByRole('button', { name: '텍스트 교체 모달 닫기' }).click();
  await page.getByRole('button', { name: '다시 선택' }).click();
  await page.locator('input[type="file"]').first().setInputFiles(downloadedPath);

  const convertedViewer = page.locator('.word-document');
  await expect(convertedViewer).toContainText('시험1');
  await expect(convertedViewer).toContainText('시험2');
  await expect(convertedViewer).toContainText('시험3');
  await expect(convertedViewer).not.toContainText('테스트');
});
