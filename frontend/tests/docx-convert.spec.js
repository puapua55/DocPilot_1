import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import JSZip from 'jszip';

const execFileAsync = promisify(execFile);

async function createCleanDocx(filePath) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>테스트1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>테스트2</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>테스트3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>테스트</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`);
  zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`);
  zip.folder('word').file('settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
  zip.folder('word').file('fontTable.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
  zip.folder('word').folder('theme').file('theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="DocPilot"><a:themeElements><a:clrScheme name="DocPilot"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1></a:clrScheme><a:fontScheme name="DocPilot"><a:majorFont/><a:minorFont/></a:fontScheme><a:fmtScheme name="DocPilot"/></a:themeElements></a:theme>`);
  zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(filePath, buffer);
}

async function unzipText(filePath, entryPath) {
  const { stdout } = await execFileAsync('unzip', ['-p', filePath, entryPath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}
async function testZip(filePath) { await execFileAsync('unzip', ['-t', filePath], { encoding: 'utf8' }); }
function countMatches(source, pattern) { return (String(source || '').match(pattern) || []).length; }
function getDocumentSummary(xmlText) { return { hasWDocument:xmlText.includes('<w:document'),hasNs0Document:xmlText.includes('<ns0:document'),wTextCount:countMatches(xmlText,/<w:t\b/g),sectPrCount:countMatches(xmlText,/<w:sectPr\b/g),tblCount:countMatches(xmlText,/<w:tbl\b/g),trCount:countMatches(xmlText,/<w:tr\b/g),tcCount:countMatches(xmlText,/<w:tc\b/g) }; }
function hasTableGridStyle(stylesXml) { return stylesXml.includes('TableGrid') || stylesXml.includes('Table Grid') || stylesXml.includes('<w:tblBorders'); }

test('DOCX [변환]은 텍스트만 바꾸고 표/스타일/ZIP 구조를 보존한다', async ({ page }, testInfo) => {
  const fixturePath = testInfo.outputPath('테스트1.docx');
  await createCleanDocx(fixturePath);
  await testZip(fixturePath);

  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(fixturePath);
  await page.getByRole('button', { name: /즉시 텍스트 교체/ }).click();
  await page.getByLabel('기존 단어').fill('테스트');
  await page.getByLabel('변경 단어').fill('시험');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '변환', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('테스트1_docx_converted.docx');
  const downloadedPath = testInfo.outputPath('테스트1_docx_converted.docx');
  await download.saveAs(downloadedPath);
  await testZip(downloadedPath);

  const [originalDocumentXml,convertedDocumentXml,originalStylesXml,convertedStylesXml] = await Promise.all([
    unzipText(fixturePath,'word/document.xml'),unzipText(downloadedPath,'word/document.xml'),unzipText(fixturePath,'word/styles.xml'),unzipText(downloadedPath,'word/styles.xml')
  ]);
  const before=getDocumentSummary(originalDocumentXml),after=getDocumentSummary(convertedDocumentXml);
  expect(convertedDocumentXml).toContain('시험1');expect(convertedDocumentXml).toContain('시험2');expect(convertedDocumentXml).toContain('시험3');expect(convertedDocumentXml).not.toContain('테스트');
  expect(after.hasWDocument).toBe(true);expect(after.hasNs0Document).toBe(false);expect(after.wTextCount).toBe(before.wTextCount);expect(after.sectPrCount).toBe(before.sectPrCount);expect(after.tblCount).toBe(before.tblCount);expect(after.trCount).toBe(before.trCount);expect(after.tcCount).toBe(before.tcCount);expect(after.tblCount).toBeGreaterThan(0);
  expect(hasTableGridStyle(originalStylesXml)).toBe(true);expect(hasTableGridStyle(convertedStylesXml)).toBe(true);expect(convertedStylesXml).toBe(originalStylesXml);
  const {stdout:entryList}=await execFileAsync('unzip',['-Z1',downloadedPath],{encoding:'utf8'});const entries=entryList.split(/\r?\n/);
  for(const entryPath of ['word/styles.xml','word/fontTable.xml','word/settings.xml','word/theme/theme1.xml','_rels/.rels','word/_rels/document.xml.rels','[Content_Types].xml']) expect(entries).toContain(entryPath);
  await expect(page.getByText(/DOCX 파일 변환 완료/)).toBeVisible();
});
