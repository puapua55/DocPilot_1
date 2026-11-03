import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { readFile, writeFile } from 'node:fs/promises';
import officeCrypto from 'officecrypto-tool';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

const text = 'Alpha Bravo Charlie Delta Echo Foxtrot';
async function fixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz w:val="36"/></w:rPr><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:bottom="1000" w:left="1000" w:right="1000"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function open(page) {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'format.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await fixture() });
  const p = page.locator('.docx-content [data-docx-paragraph-index="0"]');
  await expect(p).toContainText(text);
  await page.getByRole('group', { name: 'DOCX 모드 선택' }).getByRole('button', { name: '편집', exact: true }).click();
  return p;
}
async function download(page, format, password) {
  await page.getByRole('button', { name: `${format} 다운로드`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${format} 다운로드 미리보기` });
  await expect(dialog.getByRole('button', { name: '확인', exact: true })).toBeEnabled();
  if (password) {
    await dialog.getByLabel('암호화하여 다운로드').check();
    await dialog.getByLabel(`${format} 새 비밀번호`, { exact: true }).fill(password);
    await dialog.getByLabel(`${format} 비밀번호 확인`, { exact: true }).fill(password);
  }
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '확인', exact: true }).click();
  return readFile(await (await pending).path());
}
async function decorate(page, p) {
  await p.click(); await p.press('Control+a');
  const toolbar = page.getByRole('toolbar', { name: 'DOCX 텍스트 서식' });
  await toolbar.getByTitle('밑줄', { exact: true }).click();
  await toolbar.getByTitle('취소선', { exact: true }).click();
  // Force a nested font span below both decoration ancestors.
  const size = toolbar.getByRole('spinbutton').first();
  await size.fill('18'); await size.press('Tab');
}

test('drag selection ending inside a line survives mouseup and formatting', async ({ page }) => {
  const p = await open(page);
  const points = await p.evaluate(el => {
    const node = el.firstChild.firstChild || el.firstChild;
    const range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 11);
    const r = range.getBoundingClientRect();
    return { x1: r.left + 0.5, y: r.top + r.height / 2, x2: r.right - 0.5 };
  });
  await page.mouse.move(points.x1, points.y); await page.mouse.down();
  await page.mouse.move(points.x2, points.y, { steps: 15 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection().toString())).toBe('Alpha Bravo');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => getSelection().toString())).toBe('Alpha Bravo');
  await page.getByRole('toolbar', { name: 'DOCX 텍스트 서식' }).getByTitle('밑줄', { exact: true }).click();
  expect(await p.innerHTML()).toMatch(/<u\b|text-decoration/);
});

test('DOCX preview cancels without downloading and nested underline/strike survive plain and encrypted save', async ({ page }, testInfo) => {
  const p = await open(page); await decorate(page, p);
  let downloads = 0; page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'DOCX 다운로드', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'DOCX 다운로드 미리보기' });
  await expect(dialog.locator('section.docx-download')).toContainText(text);
  expect(downloads).toBe(0);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  const plain = await download(page, 'DOCX');
  const zip = await JSZip.loadAsync(plain), xml = await zip.file('word/document.xml').async('string');
  expect(xml).toMatch(/<w:u\b/); expect(xml).toMatch(/<w:strike\b/);
  const encrypted = await download(page, 'DOCX', 'DocPilot123!');
  await writeFile(testInfo.outputPath('plain.docx'), plain);
  await writeFile(testInfo.outputPath('encrypted.docx'), encrypted);
  expect(officeCrypto.isEncrypted(encrypted)).toBe(true);
  await expect(officeCrypto.decrypt(encrypted, { password: 'wrong' })).rejects.toThrow();
  const decrypted = await officeCrypto.decrypt(encrypted, { password: 'DocPilot123!' });
  const encryptedXml = await (await JSZip.loadAsync(decrypted)).file('word/document.xml').async('string');
  expect(encryptedXml).toBe(xml);
  expect(downloads).toBe(2);
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'protected.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: encrypted });
  const passwordDialog = page.getByRole('dialog', { name: 'DOCX 비밀번호 입력' });
  await passwordDialog.getByLabel('DOCX 열기 비밀번호').fill('wrong');
  await passwordDialog.getByRole('button', { name: '확인', exact: true }).click();
  await expect(passwordDialog.getByRole('alert')).toBeVisible();
  await passwordDialog.getByLabel('DOCX 열기 비밀번호').fill('DocPilot123!');
  await passwordDialog.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.locator('.docx-content')).toContainText(text);
});

test('DOCX PDF includes an added JPG and both decorations, with optional PDF password', async ({ page }, testInfo) => {
  const p = await open(page); await p.click();
  const jpg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; const ctx = c.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 40, 40); return c.toDataURL('image/jpeg').split(',')[1]; });
  await page.locator('input[accept="image/png,image/jpeg,image/gif"]').setInputFiles({ name: 'added.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpg, 'base64') });
  await expect(page.locator('.docx-added-image img')).toBeVisible();
  const plain = await download(page, 'PDF');
  await decorate(page, p);
  const styled = await download(page, 'PDF');
  await writeFile(testInfo.outputPath('baseline.pdf'), plain);
  await writeFile(testInfo.outputPath('styled.pdf'), styled);
  const comparison = await (async () => {
    const images = [];
    for (const bytes of [plain, styled]) {
      const loadingTask = getDocument({ data: new Uint8Array(bytes) });
      try {
        const p = await (await loadingTask.promise).getPage(1), v = p.getViewport({ scale: 1 });
        const c = createCanvas(Math.ceil(v.width), Math.ceil(v.height));
        const ctx = c.getContext('2d'); await p.render({ canvasContext: ctx, viewport: v }).promise;
        images.push({ pixels: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height });
      } finally { await loadingTask.destroy(); }
    }
    let red = 0; const rows = [], histogram = [];
    for (let y = 0; y < images[1].height; y++) {
      let newInk = 0;
      for (let x = 0; x < images[1].width; x++) {
        const i = (y * images[1].width + x) * 4, a = images[0].pixels, b = images[1].pixels;
        if (b[i] > 200 && b[i + 1] < 70 && b[i + 2] < 70) red++;
        if (b[i] < 210 && a[i] - b[i] > 40) newInk++;
      }
      if (newInk > 150) rows.push(y);
      if (newInk > 30) histogram.push([y, newInk]);
    }
    const clusters = rows.filter((y, i) => !i || y > rows[i - 1] + 1);
    return { red, clusters, histogram };
  })();
  expect(comparison.red).toBeGreaterThan(400);
  expect(comparison.clusters.length).toBeGreaterThanOrEqual(2);
  const encrypted = await download(page, 'PDF', 'DocPilot123!');
  await writeFile(testInfo.outputPath('encrypted.pdf'), encrypted);
  const lockedTask = getDocument({ data: new Uint8Array(encrypted) });
  try { await expect(lockedTask.promise).rejects.toMatchObject({ name: 'PasswordException' }); }
  finally { await lockedTask.destroy(); }
  const unlockedTask = getDocument({ data: new Uint8Array(encrypted), password: 'DocPilot123!' });
  try { expect((await unlockedTask.promise).numPages).toBe(1); }
  finally { await unlockedTask.destroy(); }
});
