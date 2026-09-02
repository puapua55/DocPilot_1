import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.join(__dirname, 'fixtures', '테스트1.docx');

async function openDocx(buffer) {
  return JSZip.loadAsync(buffer, { checkCRC32: true });
}

async function getXml(zip, xmlPath) {
  const entry = zip.file(xmlPath);
  return entry ? entry.async('string') : '';
}

function countMatches(source, pattern) {
  return (String(source || '').match(pattern) || []).length;
}

function getDocumentSummary(xmlText) {
  return {
    hasWDocument: xmlText.includes('<w:document'),
    hasNs0Document: xmlText.includes('<ns0:document'),
    wTextCount: countMatches(xmlText, /<w:t\b/g),
    sectPrCount: countMatches(xmlText, /<w:sectPr\b/g),
    tblCount: countMatches(xmlText, /<w:tbl\b/g),
    trCount: countMatches(xmlText, /<w:tr\b/g),
    tcCount: countMatches(xmlText, /<w:tc\b/g)
  };
}

function hasTableGridStyle(stylesXml) {
  return (
    stylesXml.includes('TableGrid') ||
    stylesXml.includes('Table Grid') ||
    stylesXml.includes('<w:tblBorders')
  );
}

test('DOCX [변환]은 텍스트만 바꾸고 표/스타일/ZIP 구조를 보존한다', async ({ page }, testInfo) => {
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

  const [originalZip, convertedZip] = await Promise.all([
    openDocx(originalBuffer),
    openDocx(convertedBuffer)
  ]);

  const [
    originalDocumentXml,
    convertedDocumentXml,
    originalStylesXml,
    convertedStylesXml
  ] = await Promise.all([
    getXml(originalZip, 'word/document.xml'),
    getXml(convertedZip, 'word/document.xml'),
    getXml(originalZip, 'word/styles.xml'),
    getXml(convertedZip, 'word/styles.xml')
  ]);

  expect(originalDocumentXml).not.toBe('');
  expect(convertedDocumentXml).not.toBe('');
  expect(originalStylesXml).not.toBe('');
  expect(convertedStylesXml).not.toBe('');

  const before = getDocumentSummary(originalDocumentXml);
  const after = getDocumentSummary(convertedDocumentXml);

  expect(convertedDocumentXml).toContain('시험1');
  expect(convertedDocumentXml).toContain('시험2');
  expect(convertedDocumentXml).toContain('시험3');
  expect(convertedDocumentXml).not.toContain('테스트');

  expect(after.hasWDocument).toBe(true);
  expect(after.hasNs0Document).toBe(false);
  expect(after.wTextCount).toBe(before.wTextCount);
  expect(after.sectPrCount).toBe(before.sectPrCount);
  expect(after.tblCount).toBe(before.tblCount);
  expect(after.trCount).toBe(before.trCount);
  expect(after.tcCount).toBe(before.tcCount);
  expect(after.tblCount).toBeGreaterThan(0);
  expect(after.trCount).toBeGreaterThan(0);
  expect(after.tcCount).toBeGreaterThan(0);

  expect(hasTableGridStyle(originalStylesXml)).toBe(true);
  expect(hasTableGridStyle(convertedStylesXml)).toBe(true);
  expect(convertedStylesXml.length).toBe(originalStylesXml.length);
  expect(convertedStylesXml).toBe(originalStylesXml);

  [
    'word/styles.xml',
    'word/fontTable.xml',
    'word/settings.xml',
    'word/theme/theme1.xml',
    '_rels/.rels',
    'word/_rels/document.xml.rels',
    '[Content_Types].xml'
  ].forEach((entryPath) => {
    expect(convertedZip.file(entryPath), `${entryPath} must remain in converted DOCX`).not.toBeNull();
  });

  await expect(page.getByText(/DOCX 파일 변환 완료/)).toBeVisible();
});
