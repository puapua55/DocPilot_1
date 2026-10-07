import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fontkit from '@pdf-lib/fontkit';

async function openBlankPdf(page, sourceBytes = null) {
  const document = await PDFDocument.create();
  document.addPage([500, 500]);
  const bytes = sourceBytes || await document.save();
  await page.addInitScript(() => {
    window.docPilotFonts = {
      list: async () => [],
      resolve: async () => ({ found: false })
    };
  });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'layout-source.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(bytes)
  });
  const pdfPage = page.locator('.pdf-page[data-page-number="1"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  return pdfPage;
}

async function downloadEditedPdf(page) {
  const promise = page.waitForEvent('download');
  await page.locator('.viewer-download-button.pdf').click();
  return readFile(await (await promise).path());
}

test('image position in saved PDF matches the viewer', async ({ page }) => {
  test.setTimeout(120_000);
  const pdfPage = await openBlankPdf(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, 20, 20);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('.pdf-image-input').setInputFiles({
    name: 'marker.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64')
  });
  const image = pdfPage.locator('.pdf-image-object');
  await expect(image).toBeVisible();
  const first = await image.boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2 - 55, first.y + first.height / 2 + 42, { steps: 8 });
  await page.mouse.up();
  const pageBox = await pdfPage.boundingBox();
  const imageBox = await image.boundingBox();
  const scale = pageBox.width / 500;
  const expected = {
    x: (imageBox.x - pageBox.x) / scale,
    y: (imageBox.y - pageBox.y) / scale,
    width: imageBox.width / scale,
    height: imageBox.height / scale
  };
  const pdfBytes = await downloadEditedPdf(page);
  const actual = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const { loadPdfDocument } = await import('/src/services/pdfService.js');
    const loaded = await loadPdfDocument(bytes.buffer);
    const pdfPage = await loaded.pdf.getPage(1);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext('2d');
    await pdfPage.render({ canvasContext: context, viewport }).promise;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width;
    let top = canvas.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        if (pixels[index] > 220 && pixels[index + 1] < 50 && pixels[index + 2] > 220) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }
    await loaded.loadingTask.destroy();
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  }, pdfBytes.toString('base64'));
  expect(actual.x).toBeGreaterThanOrEqual(0);
  expect(Math.abs(actual.x - expected.x)).toBeLessThan(2);
  expect(Math.abs(actual.y - expected.y)).toBeLessThan(2);
  expect(Math.abs(actual.width - expected.width)).toBeLessThan(2);
  expect(Math.abs(actual.height - expected.height)).toBeLessThan(2);
});

test('moved text snaps to source PDF horizontal and vertical guides at saved coordinates', async ({ page }) => {
  test.setTimeout(120_000);
  const source = await PDFDocument.create();
  const sourcePage = source.addPage([500, 500]);
  sourcePage.drawText('REFERENCE', {
    x: 200, y: 300, size: 16, font: await source.embedFont(StandardFonts.Helvetica)
  });
  const pdfPage = await openBlankPdf(page, await source.save());
  await page.locator('.zoom-controls .zoom-button').last().click();
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '텍스트 추가' }).click();
  const bounds = await pdfPage.boundingBox();
  const scale = bounds.width / 500;
  await page.mouse.move(bounds.x + 60 * scale, bounds.y + 90 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 180 * scale, bounds.y + 140 * scale, { steps: 8 });
  await page.mouse.up();
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await editor.fill('MOVED');
  await editor.press('Control+Enter');
  const beforeBytes = await downloadEditedPdf(page);
  const beforeDocument = await getDocument({ data: new Uint8Array(beforeBytes), useSystemFonts: true }).promise;
  const beforeItems = (await (await beforeDocument.getPage(1)).getTextContent()).items;
  const before = beforeItems.find((item) => item.str === 'MOVED');
  const reference = beforeItems.find((item) => item.str === 'REFERENCE');
  expect(before).toBeTruthy();
  expect(reference).toBeTruthy();
  await page.getByRole('button', { name: '텍스트 이동' }).click();
  const box = pdfPage.locator('.movable-text-object.is-added-text');
  const boxBounds = await box.boundingBox();
  const startX = boxBounds.x + boxBounds.width / 2;
  const startY = boxBounds.y + boxBounds.height / 2;
  const dx = 25;
  const dy = before.transform[5] - reference.transform[5] + 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx * scale, startY + dy * scale, { steps: 12 });
  await page.mouse.up();
  const savedBytes = await downloadEditedPdf(page);
  const savedDocument = await getDocument({ data: new Uint8Array(savedBytes), useSystemFonts: true }).promise;
  const savedItems = (await (await savedDocument.getPage(1)).getTextContent()).items;
  const moved = savedItems.find((item) => item.str === 'MOVED');
  expect(moved).toBeTruthy();
  expect(Math.abs(moved.transform[4] - (before.transform[4] + dx))).toBeLessThan(0.2);
  expect(Math.abs(moved.transform[5] - reference.transform[5])).toBeLessThan(0.2);
  const movedBounds = await box.boundingBox();
  const nextX = movedBounds.x + movedBounds.width / 2;
  const nextY = movedBounds.y + movedBounds.height / 2;
  const nearLeft = reference.transform[4] - moved.transform[4] + 2;
  await page.mouse.move(nextX, nextY);
  await page.mouse.down();
  await page.mouse.move(nextX + nearLeft * scale, nextY, { steps: 12 });
  await page.mouse.up();
  const alignedBytes = await downloadEditedPdf(page);
  const alignedDocument = await getDocument({ data: new Uint8Array(alignedBytes), useSystemFonts: true }).promise;
  const aligned = (await (await alignedDocument.getPage(1)).getTextContent()).items.find((item) => item.str === 'MOVED');
  expect(aligned).toBeTruthy();
  expect(Math.abs(aligned.transform[4] - reference.transform[4])).toBeLessThan(0.2);
  expect(Math.abs(aligned.transform[5] - reference.transform[5])).toBeLessThan(0.2);
});

test('saved bold text using a local bold face has no added outline weight', async ({ page }) => {
  test.setTimeout(120_000);
  const fontPath = 'C:/Windows/Fonts/arialbd.ttf';
  test.skip(!existsSync(fontPath), 'Arial Bold is required for the original-weight comparison');
  const fontBytes = await readFile(fontPath);
  const source = await PDFDocument.create();
  source.addPage([500, 500]);
  await page.addInitScript((base64) => {
    window.docPilotFonts = {
      list: async () => [{ candidate: 'Arial Bold', family: 'Arial', label: 'Arial Bold' }],
      resolve: async () => ({ found: true, base64, family: 'Arial Bold' })
    };
  }, fontBytes.toString('base64'));
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'bold-source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save())
  });
  const pdfPage = page.locator('.pdf-page[data-page-number="1"]');
  await expect(pdfPage.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.locator('.pdf-edit-mode-toggle button').last().click();
  await page.getByRole('button', { name: '텍스트 추가' }).click();
  const bounds = await pdfPage.boundingBox();
  const scale = bounds.width / 500;
  await page.mouse.move(bounds.x + 60 * scale, bounds.y + 90 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 350 * scale, bounds.y + 150 * scale, { steps: 8 });
  await page.mouse.up();
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await editor.fill('BOLD');
  await editor.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '굵게' }).click();
  await editor.press('Control+Enter');
  const savedBytes = await downloadEditedPdf(page);
  const savedDocument = await getDocument({ data: new Uint8Array(savedBytes), useSystemFonts: true }).promise;
  const savedPage = await savedDocument.getPage(1);
  const item = (await savedPage.getTextContent()).items.find((entry) => entry.str === 'BOLD');
  expect(item).toBeTruthy();
  const reference = await PDFDocument.create();
  reference.registerFontkit(fontkit);
  const referencePage = reference.addPage([500, 500]);
  const embedded = await reference.embedFont(fontBytes, { subset: true });
  referencePage.drawText('BOLD', {
    x: item.transform[4], y: item.transform[5], size: item.transform[3], font: embedded
  });
  const referenceBytes = await reference.save();
  const ink = await page.evaluate(async ([savedBase64, referenceBase64]) => {
    const { loadPdfDocument } = await import('/src/services/pdfService.js');
    const count = async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const loaded = await loadPdfDocument(bytes.buffer);
      const pdfPage = await loaded.pdf.getPage(1);
      const canvas = document.createElement('canvas');
      canvas.width = 500;
      canvas.height = 500;
      const context = canvas.getContext('2d');
      await pdfPage.render({ canvasContext: context, viewport: pdfPage.getViewport({ scale: 1 }) }).promise;
      const pixels = context.getImageData(0, 0, 500, 500).data;
      let coverage = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        coverage += (255 - pixels[index]) / 255;
      }
      await loaded.loadingTask.destroy();
      return coverage;
    };
    return [await count(savedBase64), await count(referenceBase64)];
  }, [savedBytes.toString('base64'), Buffer.from(referenceBytes).toString('base64')]);
  expect(Math.abs(ink[0] - ink[1]) / ink[1]).toBeLessThan(0.08);
});

test('inline italic, underline and strike survive PDF export', async ({ page }) => {
  test.setTimeout(120_000);
  const pdfPage = await openBlankPdf(page);
  await page.getByRole('button', { name: '텍스트 추가' }).click();
  const bounds = await pdfPage.boundingBox();
  const scale = bounds.width / 500;
  await page.mouse.move(bounds.x + 60 * scale, bounds.y + 100 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 400 * scale, bounds.y + 160 * scale, { steps: 8 });
  await page.mouse.up();
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await expect(editor).toBeVisible();
  await editor.fill('ITALIC UNDER STRIKE');
  const applyToWord = async (word, buttonName) => {
    await editor.evaluate((element, value) => {
      const text = element.textContent;
      const start = text.indexOf(value);
      const end = start + value.length;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      let offset = 0;
      let startNode;
      let endNode;
      let startOffset;
      let endOffset;
      while ((node = walker.nextNode())) {
        const next = offset + node.textContent.length;
        if (!startNode && start >= offset && start < next) {
          startNode = node;
          startOffset = start - offset;
        }
        if (end <= next) {
          endNode = node;
          endOffset = end - offset;
          break;
        }
        offset = next;
      }
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, word);
    await page.getByRole('button', { name: buttonName }).click({ force: true });
  };
  await applyToWord('ITALIC', '기울임');
  await applyToWord('UNDER', '밑줄');
  await applyToWord('STRIKE', '취소선');
  await expect(editor.locator('span[style*="italic"]')).toContainText('ITALIC');
  await expect(editor.locator('span[style*="underline"]')).toContainText('UNDER');
  await expect(editor.locator('span[style*="line-through"]')).toContainText('STRIKE');
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  const pdfBytes = await downloadEditedPdf(page);
  const saved = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
  const savedPage = await saved.getPage(1);
  const text = (await savedPage.getTextContent()).items.map((item) => item.str).join(' ');
  expect(text).toContain('ITALIC');
  expect(text).toContain('UNDER');
  expect(text).toContain('STRIKE');
  const operators = await savedPage.getOperatorList();
  const matrices = operators.fnArray.flatMap((operation, index) =>
    operation === OPS.setTextMatrix ? [operators.argsArray[index]] : []);
  const lines = operators.fnArray.flatMap((operation, index) =>
    operation === OPS.constructPath && operators.argsArray[index]?.[0] === 20
      ? [operators.argsArray[index][1]] : []);
  expect(matrices.some((matrix) => Math.abs(matrix[0]?.[2]) > 0.1)).toBe(true);
  expect(lines).toHaveLength(2);
  expect(lines[0][0][2]).toBeLessThan(lines[1][0][2]);
});

test('entered font size is preserved in a saved text box', async ({ page }) => {
  test.setTimeout(120_000);
  const pdfPage = await openBlankPdf(page);
  await page.getByRole('button', { name: '텍스트 추가' }).click();
  const bounds = await pdfPage.boundingBox();
  const scale = bounds.width / 500;
  await page.mouse.move(bounds.x + 60 * scale, bounds.y + 100 * scale);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 400 * scale, bounds.y + 160 * scale, { steps: 8 });
  await page.mouse.up();
  const editor = pdfPage.locator('.movable-text-edit-rich');
  await editor.fill('SIZE');
  const fontSize = page.locator('.pdf-text-edit-toolbar input[type="number"]').first();
  await fontSize.fill('24.5');
  await fontSize.press('Tab');
  await expect(editor).toHaveCount(0);
  const pdfBytes = await downloadEditedPdf(page);
  const saved = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
  const savedPage = await saved.getPage(1);
  const item = (await savedPage.getTextContent()).items.find((entry) => entry.str === 'SIZE');
  expect(item).toBeTruthy();
  expect(Math.abs(item.transform[3] - 24.5)).toBeLessThan(0.2);
});
