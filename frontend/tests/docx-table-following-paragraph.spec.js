import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';

async function makeDocx(rowCount, marginAttributes = 'w:top="720" w:right="1080" w:bottom="1440" w:left="2160"') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const rows = Array.from({ length: rowCount }, (_, index) => `<w:tr><w:trPr><w:trHeight w:val="650" w:hRule="atLeast"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Row ${index + 1}</w:t></w:r></w:p></w:tc></w:tr>`).join('');
  zip.folder('word').file('document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid>${rows}</w:tbl><w:p><w:r><w:t>Text after table</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar ${marginAttributes}/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

test('document margins and paragraph after a table remain editable', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'table-followed-by-text.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await makeDocx(22)
  });
  const section = page.locator('.docx-content section.docx').first();
  await expect(section).toBeVisible();
  const paragraph = page.locator('.docx-content section.docx article > p').filter({ hasText: 'Text after table' }).first();
  await expect(paragraph).toHaveAttribute('data-docx-paragraph-index', /\d+/);
  const padding = await section.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
  });
  expect(padding).toEqual(['48px', '72px', '96px', '144px']);
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  await paragraph.click();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  await paragraph.fill('Text after table updated');
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('.viewer-download-button.docx').click()
  ]);
  const saved = await JSZip.loadAsync(await readFile(await download.path()));
  const documentXml = await saved.file('word/document.xml').async('string');
  expect(documentXml).toContain('Text after table updated');
  expect(documentXml).toContain('w:top="720"');
  expect(documentXml).toContain('w:left="2160"');
});

test('zero page margins remain zero', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'zero-margins.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await makeDocx(1, 'w:top="0" w:right="0" w:bottom="0" w:left="0"')
  });
  const section = page.locator('.docx-content section.docx').first();
  await expect(section).toBeVisible();
  expect(await section.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
  })).toEqual(['0px', '0px', '0px', '0px']);
});

test('a table can be moved after a paragraph and resized before saving', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'move-and-resize.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await makeDocx(2)
  });
  const table = page.locator('.docx-content section.docx article > table').first();
  const paragraph = page.locator('.docx-content section.docx article > p').filter({ hasText: 'Text after table' }).first();
  await expect(table).toHaveAttribute('data-docx-table-id', /original-/);
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  await table.locator('td').first().click();
  await page.locator('.docx-table-toolbar-heading button').nth(1).click();
  await expect(table).toHaveClass(/docx-table-selected/);
  const beforeMove = await table.boundingBox();
  const paragraphRect = await paragraph.boundingBox();
  await page.mouse.move(beforeMove.x - 5, beforeMove.y - 5);
  await page.mouse.down();
  await page.mouse.move(paragraphRect.x + 20, paragraphRect.y + paragraphRect.height * 0.8, { steps: 8 });
  await page.mouse.up();
  await expect(table).toHaveAttribute('data-docx-table-moved', 'true');
  expect(await table.evaluate((element) => element.previousElementSibling?.textContent)).toContain('Text after table');

  const beforeResize = await table.boundingBox();
  await page.mouse.move(beforeResize.x + beforeResize.width + 5, beforeResize.y + beforeResize.height + 5);
  await page.mouse.down();
  await page.mouse.move(beforeResize.x + beforeResize.width + 85, beforeResize.y + beforeResize.height + 35, { steps: 8 });
  await page.mouse.up();
  await expect(table).toHaveAttribute('data-docx-table-dirty', 'true');
  const afterResize = await table.boundingBox();
  expect(afterResize.width).toBeGreaterThan(beforeResize.width + 40);
  expect(afterResize.height).toBeGreaterThan(beforeResize.height + 10);

  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('.viewer-download-button.docx').click()
  ]);
  const savedBytes = await readFile(await download.path());
  const saved = await JSZip.loadAsync(savedBytes);
  const xml = await saved.file('word/document.xml').async('string');
  expect(xml.indexOf('Text after table')).toBeLessThan(xml.indexOf('<w:tbl>'));
  expect(xml).toMatch(/<w:tblW[^>]*w:w="[7-9]\d{3}"/);
  expect(xml).toContain('<w:trHeight');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'saved.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: savedBytes
  });
  const reopenedTable = page.locator('.docx-content section.docx article > table').first();
  await expect(reopenedTable).toBeVisible();
  expect(await reopenedTable.evaluate((element) => element.previousElementSibling?.textContent)).toContain('Text after table');
});

test('table move buttons and total size inputs work', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'table-controls.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await makeDocx(2)
  });
  const table = page.locator('.docx-content section.docx article > table').first();
  await expect(table).toHaveAttribute('data-docx-table-id', /original-/);
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  await table.locator('td').first().click();
  await page.getByRole('button', { name: '표 아래로' }).click();
  await expect(table).toHaveAttribute('data-docx-table-moved', 'true');
  expect(await table.evaluate((element) => element.previousElementSibling?.textContent)).toContain('Text after table');
  await page.getByRole('tab', { name: '크기' }).click();
  const before = await table.boundingBox();
  const widthInput = page.getByLabel('표 전체 너비');
  await widthInput.fill(String(Number(await widthInput.inputValue()) + 70));
  await widthInput.press('Enter');
  const wider = await table.boundingBox();
  expect(wider.width).toBeGreaterThan(before.width + 35);
  const heightInput = page.getByLabel('표 전체 높이');
  await heightInput.fill(String(Number(await heightInput.inputValue()) + 40));
  await heightInput.press('Enter');
  expect((await table.boundingBox()).height).toBeGreaterThan(wider.height + 20);
  await widthInput.fill('5000');
  await widthInput.press('Enter');
  const pageWidth = await table.evaluate((element) => {
    const section = element.closest('section.docx');
    const style = getComputedStyle(section);
    const scale = section.getBoundingClientRect().width / section.offsetWidth;
    return section.getBoundingClientRect().width - (parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)) * scale;
  });
  expect((await table.boundingBox()).width).toBeLessThanOrEqual(pageWidth + 2);
});
