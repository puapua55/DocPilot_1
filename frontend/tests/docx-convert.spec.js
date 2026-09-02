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
    tblCount: countMatches(xmlText, /<w:tbl\b/g),
    trCount: countMatches(xmlText, /<w:tr\b/g),
    tcCount: countMatches(xmlText, /<w:tc\b/g),
    tblBordersCount: countMatches(xmlText, /<w:tblBorders\b/g)
  };
}

test('DOCX [변환]은 실제 버튼 다운로드 파일의 표 구조를 보존한다', async ({ page }, testInfo) => {
  await page.goto('/');

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(FIXTURE_PATH);

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

  expect(after.hasWDocument).toBe(true);
  expect(after.hasNs0Document).toBe(false);
  expect(after.wTextCount).toBe(before.wTextCount);
  expect(after.sectPrCount).toBe(before.sectPrCount);
  expect(after.tblCount).toBe(before.tblCount);
  expect(after.trCount).toBe(before.trCount);
  expect(after.tcCount).toBe(before.tcCount);
  expect(after.tblBordersCount).toBe(before.tblBordersCount);
  expect(after.tblCount).toBeGreaterThan(0);
  expect(after.trCount).toBeGreaterThan(0);
  expect(after.tcCount).toBeGreaterThan(0);

  await expect(page.getByText(/DOCX 파일 변환 완료/)).toBeVisible();
});
