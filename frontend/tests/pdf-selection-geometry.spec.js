import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { jsPDF } from 'jspdf';

const phrases = [
  { text: '삼성 김치플러스', size: 32, y: 70 },
  { text: '사용 설명서', size: 24, y: 115 },
  { text: '뚜껑형 김치냉장고', size: 16, y: 150 },
  { text: '테스트1', size: 12, y: 180 },
  { text: '테스트2', size: 12, y: 205 },
  { text: '표 안 텍스트', size: 10, y: 240 }
];

function createPdf() {
  const pdf = new jsPDF({ unit: 'pt' });
  pdf.addFileToVFS('NotoSansKR.ttf', readFileSync(new URL('../public/fonts/NotoSansKR-Regular.base64.txt', import.meta.url), 'utf8').trim());
  pdf.addFont('NotoSansKR.ttf', 'NotoSansKR', 'normal');
  pdf.setFont('NotoSansKR');
  const items = phrases.map((item) => {
    pdf.setFontSize(item.size);
    pdf.text(item.text, 40, item.y);
    return { ...item, width: pdf.getTextWidth(item.text) };
  });
  pdf.rect(35, 220, 180, 30);
  pdf.addPage();
  pdf.text('두 번째 페이지', 40, 70);
  return { buffer: Buffer.from(pdf.output('arraybuffer')), items };
}

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`PDF selection DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor, viewport: { width: 1800, height: 1100 } });
    test('한글 제목과 본문 선택 폭 및 복사는 zoom과 무관하게 유지된다', async ({ page }, testInfo) => {
      const fixture = createPdf();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('/');
      await page.locator('input[type="file"]').first().setInputFiles({
        name: 'korean-selection.pdf', mimeType: 'application/pdf', buffer: fixture.buffer
      });
      await expect(page.locator('.pdf-page')).toHaveCount(2);
      const measurements = [];
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      for (const zoom of [80, 100, 120, 150, 200]) {
        while (Number.parseInt(await page.locator('.zoom-value').innerText(), 10) < zoom) {
          await page.getByRole('button', { name: '확대', exact: true }).click();
        }
        await expect(page.locator('.textLayer').first()).toHaveAttribute('data-rendered', 'true');
        await expect(page.locator('.textLayer').first()).toContainText('삼성 김치플러스');
        const metrics = await page.locator('.pdf-page').first().evaluate((element) => {
          const canvas = element.querySelector('canvas');
          const layer = element.querySelector('.textLayer');
          return {
            canvasWidth: canvas.getBoundingClientRect().width,
            layerWidth: layer.getBoundingClientRect().width,
            canvasHeight: canvas.getBoundingClientRect().height,
            layerHeight: layer.getBoundingClientRect().height,
            bufferWidth: canvas.width,
            spans: [...layer.querySelectorAll('span')].map((span) => {
              const range = document.createRange();
              range.selectNodeContents(span);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              const rect = range.getBoundingClientRect();
              const css = getComputedStyle(span);
              return { text: span.textContent, copy: selection.toString(), width: rect.width, height: rect.height, font: css.fontFamily, scaleX: css.getPropertyValue('--scale-x') };
            })
          };
        });
        measurements.push({ zoom, ...metrics });
        writeFileSync(testInfo.outputPath('selection-metrics.json'), JSON.stringify(measurements, null, 2));
        for (const phrase of ['삼성 김치플러스', '테스트1']) {
          const text = page.locator('.textLayer span').filter({ hasText: phrase }).first();
          await text.scrollIntoViewIfNeeded();
          const box = await text.boundingBox();
          await page.evaluate(() => window.getSelection().removeAllRanges());
          await page.mouse.move(box.x + 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
          await page.mouse.up();
          await page.screenshot({ path: testInfo.outputPath(`selection-${zoom}-${phrase}.png`) });
          await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe(phrase);
          await page.keyboard.press('Control+c');
          await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(phrase);
          if (zoom === 100) {
            await page.screenshot({ path: testInfo.outputPath(`selection-${phrase}.png`) });
          }
        }
        expect(metrics.canvasWidth).toBeCloseTo(metrics.layerWidth, 0);
        expect(metrics.canvasHeight).toBeCloseTo(metrics.layerHeight, 0);
        expect(Math.abs(metrics.bufferWidth - metrics.canvasWidth * deviceScaleFactor)).toBeLessThan(1.1);
        for (const item of fixture.items) {
          const span = metrics.spans.find((entry) => entry.text === item.text);
          expect(span).toBeTruthy();
          expect(span.copy).toBe(item.text);
          expect(Math.abs(span.width - item.width * zoom / 100), `${item.text} at ${zoom}%`).toBeLessThan(1.5);
        }
      }
      writeFileSync(testInfo.outputPath('selection-metrics.json'), JSON.stringify(measurements, null, 2));
      await testInfo.attach('selection-metrics', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
      expect(errors).toEqual([]);
    });
  });
}

test('PDF 한글 fallback과 표 선은 반복 변환 다운로드에서도 유지된다', async ({ page }) => {
  await page.goto('/');
  const fixture = createPdf();
  // An unusable preferred font must fall through to the bundled NotoSansKR.
  await page.evaluate(() => { window.__DOC_PILOT_MALGUN_GOTHIC_BASE64__ = 'invalid'; });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const downloadPromise = page.waitForEvent('download');
    const result = await page.evaluate(async (bytes) => {
      const { convertTextReplacement } = await import('/src/services/documentReplaceService.js');
      return convertTextReplacement({
        file: new File([new Uint8Array(bytes)], 'korean-table.pdf', { type: 'application/pdf' }),
        fileType: 'pdf', originalText: '삼성 김치플러스', newText: '새 김치냉장고',
        options: { matchMode: 'exact' }
      });
    }, [...fixture.buffer]);
    const download = await downloadPromise;
    expect(result.replaceCount).toBe(1);
    expect(result.lines).toBeGreaterThan(0);
    const bytes = readFileSync(await download.path());
    const output = await page.evaluate(async (data) => {
      const { loadPdfDocument } = await import('/src/services/pdfService.js');
      const { OPS } = await import('/node_modules/pdfjs-dist/build/pdf.mjs');
      const { pdf, loadingTask } = await loadPdfDocument(new Uint8Array(data).buffer);
      try {
        const firstPage = await pdf.getPage(1);
        const content = await firstPage.getTextContent();
        const operators = await firstPage.getOperatorList();
        return { pages: pdf.numPages, text: content.items.map((item) => item.str).join(' '), hasLines: operators.fnArray.includes(OPS.constructPath) };
      } finally { await loadingTask.destroy(); }
    }, [...bytes]);
    expect(output.pages).toBe(2);
    expect(output.text).toContain('새 김치냉장고');
    expect(output.text).toContain('표 안 텍스트');
    expect(output.hasLines).toBe(true);
  }
});

test('PDF zoom 후 검색 count와 하이라이트·치환 위치를 유지한다', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Failed to render|same canvas/.test(message.text())) errors.push(message.text());
  });
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'zoom-actions.pdf', mimeType: 'application/pdf', buffer: createPdf().buffer
  });
  await expect(page.locator('.textLayer').first()).toHaveAttribute('data-rendered', 'true');
  await expect(page.locator('.pdf-page-debug-label')).toHaveCount(2);
  await page.getByText('위치 하이라이트', { exact: true }).click();
  await page.getByPlaceholder('하이라이트할 단어 또는 문장을 입력하세요').fill('테스트1');
  await page.getByRole('button', { name: '파랑', exact: true }).click();
  await page.getByRole('button', { name: '하이라이트 적용' }).click();
  await expect(page.locator('.highlight-result-row')).toHaveCount(1);
  await page.getByRole('button', { name: '하이라이트 모달 닫기' }).click();
  await page.getByRole('button', { name: /즉시 텍스트 교체/ }).click();
  await page.getByLabel('기존 단어', { exact: true }).fill('표 안 텍스트');
  await page.getByLabel('변경 단어', { exact: true }).fill('표 내용 변경');
  await page.getByRole('button', { name: '대상 확인' }).click();
  await page.getByRole('button', { name: '전체 선택', exact: true }).click();
  await page.getByRole('button', { name: '화면에 적용' }).click();
  await expect(page.getByRole('dialog')).toContainText('화면에 총 1건을 적용했습니다.');
  await page.getByRole('button', { name: '텍스트 교체 모달 닫기' }).click();

  for (const zoom of [80, 100, 120, 150, 200]) {
    while (Number.parseInt(await page.locator('.zoom-value').innerText(), 10) < zoom) {
      await page.getByRole('button', { name: '확대', exact: true }).click();
    }
    await expect(page.locator('.textLayer').first()).toHaveAttribute('data-rendered', 'true');
    await expect(page.locator('.highlight-box[data-highlight-color="blue"]')).toHaveCount(1);
    await expect(page.locator('.replacement-text')).toHaveText('표 내용 변경');
    const positions = await page.locator('.pdf-page').first().evaluate((element) => {
      const box = (selector) => element.querySelector(selector).getBoundingClientRect();
      const textBox = (value) => {
        const span = [...element.querySelectorAll('.textLayer span')].find((entry) => entry.textContent === value);
        const range = document.createRange(); range.selectNodeContents(span);
        return range.getBoundingClientRect();
      };
      const highlighted = textBox('테스트1'), highlight = box('.highlight-box');
      const replaced = textBox('표 안 텍스트'), cover = box('.replacement-cover');
      return { highlightX: Math.abs(highlight.x - highlighted.x), highlightY: Math.abs(highlight.y - highlighted.y), highlightWidth: Math.abs(highlight.width - highlighted.width), covered: cover.left <= replaced.left && cover.right >= replaced.right && cover.top <= replaced.top && cover.bottom >= replaced.bottom };
    });
    expect(positions.highlightX).toBeLessThan(1);
    expect(positions.highlightY).toBeLessThan(1);
    expect(positions.highlightWidth).toBeLessThan(1);
    expect(positions.covered).toBe(true);
    await page.getByText('정확한 문서 검색', { exact: true }).click();
    await page.getByPlaceholder('검색어를 입력하세요').fill('테스트');
    await page.getByLabel('포함 검색', { exact: true }).check();
    await page.getByRole('button', { name: '검색', exact: true }).click();
    await expect(page.locator('.search-result-row')).toHaveCount(2);
    await page.getByLabel('정확히 일치', { exact: true }).check();
    await page.getByRole('button', { name: '검색', exact: true }).click();
    await expect(page.locator('.search-result-row')).toHaveCount(0);
    await page.getByRole('button', { name: '검색 모달 닫기' }).click();
  }
  await page.getByText('위치 하이라이트', { exact: true }).click();
  await page.getByRole('button', { name: '전체 제거', exact: true }).click();
  await expect(page.locator('.highlight-box')).toHaveCount(0);
  expect(errors).toEqual([]);
});
