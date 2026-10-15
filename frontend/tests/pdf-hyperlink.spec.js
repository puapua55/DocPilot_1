import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

async function openPdf(page) {
  const doc = await PDFDocument.create();
  doc.addPage([500, 500]);
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'hyperlink-test.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save())
  });
  await expect(page.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
}

function uris(bytes) {
  return PDFDocument.load(bytes).then((doc) => doc.getPage(0).node.Annots()?.asArray().map((ref) => {
    const annotation = doc.context.lookup(ref);
    return annotation.lookup(PDFName.of('A'))?.get(PDFName.of('URI'))?.decodeText();
  }).filter(Boolean) || []);
}

test('PDF text box auto-links, preserves links through styling, removes by context menu and exports remaining links', async ({ page }) => {
  await openPdf(page);
  await page.getByRole('button', { name: '텍스트 추가', exact: true }).click();
  const bounds = await page.locator('.pdf-page').boundingBox();
  const scale = bounds.width / 500;
  await page.mouse.move(bounds.x + 30 * scale, bounds.y + 80 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 450 * scale, bounds.y + 280 * scale, { steps: 5 });
  await page.mouse.up();
  const editor = page.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('https://example.com http://example.com www.example.com user@example.com ftp://files.example.com/a mailto:other@example.com');
  await expect(editor.locator('a')).toHaveCount(6);
  const first = editor.locator('a').first();
  await expect(first).toHaveCSS('color', 'rgb(0, 0, 255)');
  await expect(first).toHaveCSS('text-decoration-line', 'underline');
  await first.evaluate((node) => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '밑줄', exact: true }).click();
  await page.getByLabel('글자색', { exact: true }).evaluate((input) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '#000000');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(first).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(first).toHaveCSS('text-decoration-line', 'none');
  await expect(first).toHaveAttribute('href', 'https://example.com/');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  const box = page.locator('.movable-text-object.is-added-text');
  await box.locator('a').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '하이퍼링크 제거' }).click();
  await expect(box.locator('a')).toHaveCount(5);
  await expect(box).toContainText('https://example.com');
  await box.dblclick();
  await expect(editor).toBeVisible();
  await editor.press('Control+End');
  await editor.pressSequentially(' more');
  await expect(editor.locator('a')).toHaveCount(5);
  await editor.locator('a').last().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '하이퍼링크 제거' }).click();
  await expect(editor.locator('a')).toHaveCount(4);
  await editor.press('Control+End');
  await editor.press('Enter');
  await editor.pressSequentially('https://typed.example.org');
  const typedLink = editor.locator('a[href="https://typed.example.org/"]');
  await expect(typedLink.first()).toBeVisible();
  expect(await typedLink.allTextContents()).not.toHaveLength(0);
  expect((await typedLink.allTextContents()).join('')).toBe('https://typed.example.org');
  await typedLink.last().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '하이퍼링크 제거' }).click();
  await expect(editor.locator('a')).toHaveCount(4);
  await editor.press('Control+Enter');
  const pending = page.waitForEvent('download');
  await page.locator('.viewer-download-button.pdf').click();
  await page.getByRole('dialog', { name: 'PDF 다운로드 미리보기' }).getByRole('button', { name: '확인', exact: true }).click();
  const download = await pending;
  const bytes = await readFile(await download.path());
  const destinations = [...new Set(await uris(bytes))].sort();
  expect(destinations).toEqual(['http://example.com/', 'https://www.example.com/', 'mailto:user@example.com', 'ftp://files.example.com/a'].sort());
  // Reopen the exported file to verify native PDF annotations are clickable in viewer mode.
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'saved.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.pdf-hyperlink-layer a').first()).toBeVisible();
  await expect(page.locator('.pdf-hyperlink-layer a[href="https://www.example.com/"]').first()).toBeVisible();
  await page.context().route('https://www.example.com/**', (route) => route.fulfill({ status: 200, body: 'test link opened' }));
  const popupPending = page.waitForEvent('popup');
  await page.locator('.pdf-hyperlink-layer a[href="https://www.example.com/"]').first().click();
  const popup = await popupPending;
  await expect(popup).toHaveURL('https://www.example.com/');
  await popup.close();
});

test('resaving removes previous DocPilot annotations while preserving unrelated PDF links', async ({ page }) => {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([600, 800]);
  sheet.node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 40, 25], A: { S: 'URI', URI: PDFString.of('https://unrelated.example/') } })));
  await page.goto('/');
  const exported = await page.evaluate(async (source) => {
    const { buildPdfWithTextEdits } = await import('/src/services/pdfOverlayConvertService.js');
    const { autoLinkFontRuns, removeHyperlinkFromRuns } = await import('/src/services/hyperlinkService.js');
    const fontText = await (await fetch('/fonts/NotoSansKR-Regular.base64.txt')).text();
    const fontBytes = Uint8Array.from(atob(fontText.trim()), (letter) => letter.charCodeAt(0));
    const linked = autoLinkFontRuns([{ text: 'https://example.com', fontSize: 14 }]).map((run) => ({ ...run, color: '#000000', textDecoration: 'none' }));
    const replacement = {
      id: 'test-box', type: 'added-text', pageNumber: 1, sourcePageWidth: 600, sourcePageHeight: 800,
      coverX: 60, coverY: 80, coverWidth: 350, coverHeight: 40, textX: 60, textY: 80, baseline: 95,
      fontSize: 14, textBoxWidth: 350, text: 'https://example.com', backgroundColor: [255, 255, 255], textColor: [0, 0, 0]
    };
    const build = (bytes, runs) => buildPdfWithTextEdits({ sourceBytes: bytes, fontBytes, replacements: [{ ...replacement, fontRuns: runs }], skipRenderValidation: true });
    const first = await build(Uint8Array.from(source), linked);
    const second = await build(first.outputBytes, removeHyperlinkFromRuns(linked, linked[0].hyperlinkId));
    return { first: Array.from(first.outputBytes), second: Array.from(second.outputBytes) };
  }, Array.from(await doc.save()));
  expect(await uris(Uint8Array.from(exported.first))).toEqual(['https://unrelated.example/', 'https://example.com/']);
  expect(await uris(Uint8Array.from(exported.second))).toEqual(['https://unrelated.example/']);
});
