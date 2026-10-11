import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

function cell(text, properties = '') {
  return `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${properties}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
}

async function makeTableDocx(merged = false) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const firstRow = merged === 'vertical'
    ? cell('A1', '<w:vMerge w:val="restart"/>') + cell('A2') + cell('A3')
    : merged ? cell('A1 A2', '<w:gridSpan w:val="2"/>') + cell('A3')
      : cell('A1') + cell('A2') + cell('A3');
  const secondRow = merged === 'vertical'
    ? cell('', '<w:vMerge/>') + cell('B2') + cell('B3')
    : cell('B1') + cell('B2') + cell('B3');
  zip.folder('word').file('document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${firstRow}</w:tr><w:tr>${secondRow}</w:tr></w:tbl><w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

async function openTable(page, merged = false) {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'table.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await makeTableDocx(merged)
  });
  const table = page.locator('.docx-content section.docx table').first();
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute('data-docx-table-id', /original-/);
  await page.locator('.docx-edit-toggle').getByRole('button', { name: '편집' }).click();
  return table;
}

async function downloadTable(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.viewer-download-button.docx').click()
  ]);
  const bytes = await readFile(await download.path());
  const zip = await JSZip.loadAsync(bytes);
  return { bytes, xml: await zip.file('word/document.xml').async('string') };
}

test('other cells remain editable after a right merge and the merged cell can be split', async ({ page }) => {
  const table = await openTable(page);
  await table.locator('tr').first().locator('td').first().click();
  const toolbar = page.locator('.docx-table-toolbar');
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await expect(toolbar.getByRole('button', { name: '오른쪽 셀 병합' })).toBeEnabled();
  await toolbar.getByRole('button', { name: '오른쪽 셀 병합' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(2);
  await expect(table.locator('tr').first().locator('td').first()).toHaveAttribute('colspan', '2');

  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await table.locator('tr').nth(1).locator('td').first().click();
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await expect(toolbar.getByRole('button', { name: '오른쪽 셀 병합' })).toBeEnabled();
  await expect(toolbar.getByRole('button', { name: '아래에 행' })).toBeEnabled();
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await table.locator('tr').first().locator('td').first().click();
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await toolbar.getByRole('button', { name: '셀 분할' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(3);
  const { bytes, xml } = await downloadTable(page);
  expect((xml.match(/<w:tc>/g) || []).length).toBe(6);
  expect(xml).not.toContain('gridSpan');
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'saved.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes
  });
  await expect(page.locator('.docx-content section.docx table').first().locator('tr').first().locator('td')).toHaveCount(3);
});

test('table settings tabs expose size, fill, and border and save track sizes', async ({ page }) => {
  const table = await openTable(page);
  await table.locator('tr').first().locator('td').first().click();
  const toolbar = page.locator('.docx-table-toolbar');
  const viewerTop = (await page.locator('.word-viewer-scroll').boundingBox()).y;
  await toolbar.getByRole('tab', { name: '크기' }).click();
  await expect(toolbar.locator('.docx-table-toolbar-content')).toBeVisible();
  expect((await page.locator('.word-viewer-scroll').boundingBox()).y).toBeGreaterThan(viewerTop);
  await toolbar.getByLabel('열 너비').fill('120');
  await toolbar.getByLabel('열 너비').press('Enter');
  await toolbar.getByLabel('행 높이').fill('44');
  await toolbar.getByLabel('행 높이').press('Enter');
  await toolbar.getByRole('tab', { name: '셀 서식' }).click();
  await expect(toolbar.getByLabel('셀 배경색')).toBeVisible();
  await toolbar.getByRole('tab', { name: '테두리' }).click();
  await expect(toolbar.getByRole('group', { name: 'DOCX 셀 테두리 설정' })).toBeVisible();
  const { xml } = await downloadTable(page);
  expect(xml).toMatch(/<w:trHeight[^>]*w:val="660"/);
  expect(xml).toMatch(/<w:tcW[^>]*w:w="1800"/);
});

test('leaving a table removes its toolbar space', async ({ page }) => {
  const table = await openTable(page);
  const viewer = page.locator('.word-viewer-scroll');
  const toolbar = page.locator('.docx-table-toolbar');
  const initialTop = (await viewer.boundingBox()).y;

  await table.locator('tr').first().locator('td').first().click();
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('tab').first().click();
  expect((await viewer.boundingBox()).y).toBeGreaterThan(initialTop);

  await page.locator('.docx-content').evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect(toolbar).toBeHidden();
  expect((await viewer.boundingBox()).y).toBe(initialTop);
});

test('table row and column controls match the PDF toolbar and persist', async ({ page }) => {
  const table = await openTable(page);
  await table.locator('tr').first().locator('td').first().click();
  const toolbar = page.locator('.docx-table-toolbar');
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await toolbar.getByRole('button', { name: '위에 행' }).click();
  await expect(table.locator('tr')).toHaveCount(3);
  await toolbar.getByRole('button', { name: '왼쪽에 열' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(4);
  await toolbar.getByLabel('표 행 수').fill('4');
  await toolbar.getByLabel('표 행 수').press('Enter');
  await toolbar.getByLabel('표 열 수').fill('5');
  await toolbar.getByLabel('표 열 수').press('Enter');
  await expect(table.locator('tr')).toHaveCount(4);
  await expect(table.locator('tr').first().locator('td')).toHaveCount(5);
  const { bytes, xml } = await downloadTable(page);
  expect((xml.match(/<w:tr>/g) || []).length).toBe(4);
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'saved.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes
  });
  await expect(page.locator('.docx-content section.docx table').first().locator('tr').first().locator('td')).toHaveCount(5);
});

test('cell font, alignment, background, and size controls persist in DOCX', async ({ page }) => {
  const table = await openTable(page);
  await table.locator('tr').first().locator('td').first().click();
  const toolbar = page.locator('.docx-table-toolbar');
  await toolbar.getByRole('tab', { name: '셀 서식' }).click();
  await toolbar.getByLabel('선택한 셀 글자 크기').fill('18');
  await toolbar.getByLabel('선택한 셀 글자 크기').press('Enter');
  await toolbar.getByRole('button', { name: '굵게' }).click();
  await toolbar.getByLabel('셀 글자색').fill('#123456');
  await toolbar.getByLabel('셀 가로 정렬').selectOption('right');
  await toolbar.getByLabel('셀 세로 정렬').selectOption('bottom');
  await toolbar.getByLabel('셀 배경색').fill('#abcdef');
  await toolbar.getByRole('tab', { name: '크기' }).click();
  await toolbar.getByRole('button', { name: '균등 분배' }).click();
  await toolbar.getByRole('button', { name: '내용에 맞춤' }).click();
  const { xml } = await downloadTable(page);
  expect(xml).toContain('ABCDEF');
  expect(xml).toContain('123456');
  expect(xml).toMatch(/<w:sz[^>]*w:val="27"/);
  expect(xml).toMatch(/<w:b[^>]*w:val="1"/);
  expect(xml).toMatch(/<w:jc[^>]*w:val="right"/);
  expect(xml).toMatch(/<w:vAlign[^>]*w:val="bottom"/);
});

test('left-right and top-bottom split controls keep adjacent cells merged', async ({ page }) => {
  const table = await openTable(page);
  await table.locator('tr').first().locator('td').first().click();
  const toolbar = page.locator('.docx-table-toolbar');
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await toolbar.getByRole('button', { name: '좌우 분할' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(4);
  await expect(table.locator('tr').nth(1).locator('td').first()).toHaveAttribute('colspan', '2');
  const { bytes } = await downloadTable(page);
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'split.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes
  });
  const reopened = page.locator('.docx-content section.docx table').first();
  await expect(reopened.locator('tr').first().locator('td')).toHaveCount(4);
});

test('top-bottom split keeps the other columns joined in the saved DOCX', async ({ page }) => {
  const table = await openTable(page);
  await table.locator('tr').first().locator('td').first().click();
  await page.locator('.docx-table-toolbar').getByRole('tab', { name: '행·열' }).click();
  await page.locator('.docx-table-toolbar').getByRole('button', { name: '상하 분할' }).click();
  await expect(table.locator('tr')).toHaveCount(3);
  await expect(table.locator('tr').first().locator('td').nth(1)).toHaveAttribute('rowspan', '2');
  const { bytes } = await downloadTable(page);
  await page.locator('input[type=file]').first().setInputFiles({
    name: 'vertical-split.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes
  });
  const reopened = page.locator('.docx-content section.docx table').first();
  await expect(reopened.locator('tr')).toHaveCount(3);
  await expect(reopened.locator('tr').first().locator('td').nth(1)).toHaveAttribute('rowspan', '2');
});

test('an existing merged cell can be split and saved', async ({ page }) => {
  const table = await openTable(page, true);
  await table.locator('tr').first().locator('td').first().click();
  await page.locator('.docx-table-toolbar').getByRole('tab', { name: '행·열' }).click();
  await page.locator('.docx-table-toolbar').getByRole('button', { name: '셀 분할' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(3);
  const { xml } = await downloadTable(page);
  expect((xml.match(/<w:tc>/g) || []).length).toBe(6);
  expect(xml).not.toContain('gridSpan');
});

test('a vertical merge can be split into two editable cells', async ({ page }) => {
  const table = await openTable(page, 'vertical');
  await table.locator('tr').first().locator('td').first().click({ position: { x: 6, y: 6 } });
  await expect(table.locator('tr').first().locator('td').first()).toHaveAttribute('rowspan', '2');
  await expect(page.locator('.docx-table-toolbar')).toBeVisible();
  await page.locator('.docx-table-toolbar').getByRole('tab', { name: '행·열' }).click();
  await page.locator('.docx-table-toolbar').getByRole('button', { name: '셀 분할' }).click();
  await expect(table.locator('tr').nth(1).locator('td')).toHaveCount(3);
  const { xml } = await downloadTable(page);
  expect(xml).not.toContain('vMerge');
  expect((xml.match(/<w:tc>/g) || []).length).toBe(6);
});

test('a selected two-by-two range can be merged and split', async ({ page }) => {
  const table = await openTable(page);
  await table.locator('tr').first().locator('td').first().click();
  await table.locator('tr').nth(1).locator('td').nth(1).click({ modifiers: ['Shift'] });
  const toolbar = page.locator('.docx-table-toolbar');
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await expect(toolbar.getByRole('button', { name: '병합', exact: true })).toBeEnabled();
  await toolbar.getByRole('button', { name: '병합', exact: true }).click();
  await expect(table.locator('tr').first().locator('td').first()).toHaveAttribute('colspan', '2');
  await expect(table.locator('tr').first().locator('td').first()).toHaveAttribute('rowspan', '2');
  await toolbar.getByRole('button', { name: '셀 분할' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(3);
  await expect(table.locator('tr').nth(1).locator('td')).toHaveCount(3);
  const { xml } = await downloadTable(page);
  expect(xml).not.toContain('gridSpan');
  expect(xml).not.toContain('vMerge');
  expect((xml.match(/<w:tc>/g) || []).length).toBe(6);
});

test('another row and column can still be edited after a merge', async ({ page }) => {
  const table = await openTable(page);
  const toolbar = page.locator('.docx-table-toolbar');
  await table.locator('tr').first().locator('td').first().click();
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await toolbar.getByRole('button', { name: '오른쪽 셀 병합' }).click();
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await table.locator('tr').nth(1).locator('td').first().click();
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await toolbar.getByRole('button', { name: '오른쪽 셀 병합' }).click();
  await expect(table.locator('tr').nth(1).locator('td').first()).toHaveAttribute('colspan', '2');
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await table.locator('tr').nth(1).locator('td').last().click();
  await toolbar.getByRole('tab', { name: '행·열' }).click();
  await expect(toolbar.getByRole('button', { name: '오른쪽에 열' })).toBeEnabled();
  await toolbar.getByRole('button', { name: '오른쪽에 열' }).click();
  await expect(table.locator('tr').first().locator('td')).toHaveCount(3);
  await expect(table.locator('tr').nth(1).locator('td')).toHaveCount(3);
  const { xml } = await downloadTable(page);
  expect((xml.match(/<w:gridCol\b/g) || []).length).toBe(4);
  expect((xml.match(/<w:tc>/g) || []).length).toBe(6);
});
