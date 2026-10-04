import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { jsPDF } from 'jspdf';

const lineText = 'Work 및 Word 문서 활용 증가 :';

function createEditedLinePdf() {
  const pdf = new jsPDF({ unit: 'pt' });
  const fontData = readFileSync(new URL('../public/fonts/NotoSansKR-Regular.base64.txt', import.meta.url), 'utf8').trim();
  pdf.addFileToVFS('NotoSansKR.ttf', fontData);
  pdf.addFont('NotoSansKR.ttf', 'NotoSansKR', 'normal');
  pdf.setFont('NotoSansKR');
  pdf.setFontSize(18);
  const left = 'Work';
  const tail = ' 및 Word 문서 활용 증가 :';
  const tailX = 40 + pdf.getTextWidth(left) + 2;
  // Deliberately write the right-hand item first and at a slightly different
  // baseline, as happens when a saved PDF appends its replacement text.
  pdf.text(tail, tailX, 110.5);
  pdf.text(left, 40, 112);
  return Buffer.from(pdf.output('arraybuffer'));
}

async function loadFixture(page) {
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'edited-line.pdf', mimeType: 'application/pdf', buffer: createEditedLinePdf()
  });
  await expect(page.locator('.textLayer')).toHaveAttribute('data-rendered', 'true');
  await page.getByRole('button', { name: '편집', exact: true }).click();
}

test('교체 모드에서 변경 단어만 드래그해도 저장 PDF의 시각적 한 줄 전체를 선택한다', async ({ page }) => {
  await loadFixture(page);
  await page.getByRole('button', { name: '텍스트 교체', exact: true }).click();
  const changedSpan = page.locator('.textLayer span').filter({ hasText: /^Work$/ }).first();
  await expect(changedSpan).toBeVisible();
  const box = await changedSpan.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.movable-text-edit-input')).toHaveValue(lineText);
});

test('편집 모드의 일반 영역 드래그도 한 줄과 단어 공백을 보존한다', async ({ page }) => {
  await loadFixture(page);
  const first = page.locator('.textLayer span').filter({ hasText: /^Work$/ }).first();
  const last = page.locator('.textLayer span').filter({ hasText: /Word 문서 활용 증가/ }).first();
  const firstBox = await first.boundingBox();
  const lastBox = await last.boundingBox();
  await page.mouse.move(firstBox.x - 2, firstBox.y - 2);
  await page.mouse.down();
  await page.mouse.move(lastBox.x + lastBox.width + 2, lastBox.y + lastBox.height + 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.movable-text-edit-input')).toHaveValue(lineText);
});

test('텍스트 이동 모드에서 원문 드래그는 새 편집칸을 만들지 않는다', async ({ page }) => {
  await loadFixture(page);
  await page.getByRole('button', { name: '텍스트 이동', exact: true }).click();
  const sourceSpan = page.locator('.textLayer span').filter({ hasText: /^Work$/ }).first();
  const box = await sourceSpan.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.movable-text-edit-input')).toHaveCount(0);
  await expect(page.locator('.movable-text-object')).toHaveCount(0);
});
