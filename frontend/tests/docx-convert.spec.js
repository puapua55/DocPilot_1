import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.join(__dirname, 'fixtures', '테스트1.docx');

function openDocx(buffer) {
  return new PizZip(buffer);
}

function getXml(zip, xmlPath) {
  return zip.file(xmlPath)?.asText() || '';
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

  // PizZip으로 실제 생성 ZIP을 다시 연다. 손상된 엔트리는 asText() 시점에 실패해야 한다.
  const originalZip = openDocx(originalBuffer);
  const convertedZip = openDocx(convertedBuffer);

  const originalDocumentXml = getXml(originalZip, 'word/document.xml');
  const convertedDocumentXml = getXml(convertedZip, 'word/document.xml');
  const originalStylesXml = getXml(originalZip, 'word/styles.xml');
  const convertedStylesXml = getXml(convertedZip, 'word/styles.xml');

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

  // 표 테두리의 근거가 되는 스타일 파일 자체가 읽히고 Table Grid/표 테두리 정보가 남아 있어야 한다.
  expect(hasTableGridStyle(originalStylesXml)).toBe(true);
  expect(hasTableGridStyle(convertedStylesXml)).toBe(true);
  expect(convertedStylesXml.length).toBe(originalStylesXml.length);
  expect(convertedStylesXml).toBe(originalStylesXml);

  // 수정 금지 대상의 대표 엔트리가 그대로 존재하는지 확인한다.
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
