import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitReplacementWidth, findCellRight } from '../src/services/pdfReplacementLayout.js';

test('다음 글자와 셀 경계 중 가까운 경계에 맞추고 확대 비율을 유지한다', () => {
  for (const scale of [0.5, 1, 1.5, 2, 3]) {
    const result = fitReplacementWidth({ sourceSize: 20 * scale, measuredWidth: 100 * scale,
      startX: 10 * scale, pageRight: 600 * scale, nextTextX: 100 * scale,
      cellRight: 80 * scale, gap: 2 * scale });
    assert.equal(result.maxWidth, 68 * scale);
    assert.ok(Math.abs(result.fontSize - 13.6 * scale) < 1e-10);
  }
});
test('짧은 교체 글자는 확대하지 않고 다음 글자의 위치를 우선한다', () => {
  const result = fitReplacementWidth({ sourceSize: 20, measuredWidth: 30,
    startX: 10, pageRight: 600, nextTextX: 60, cellRight: 100, gap: 2 });
  assert.deepEqual(result, { maxWidth: 48, fontSize: 20 });
});
test('셀 선이 없을 때 페이지 경계를 사용한다', () => {
  assert.deepEqual(fitReplacementWidth({ sourceSize: 20, measuredWidth: 100,
    startX: 10, pageRight: 62, gap: 2 }), { maxWidth: 50, fontSize: 10 });
});
test('수직 표 선은 인식하지만 짧은 글자 획은 경계로 사용하지 않는다', () => {
  const page = { style: { width: '200px', height: '100px' }, querySelector: () => ({
    width: 200, height: 100, getContext: () => ({ getImageData: (left, top, width, height) => {
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (left + x === 120 || (left + x === 80 && y > height * 0.3 && y < height * 0.7)) {
          const i = (y * width + x) * 4; data[i] = data[i+1] = data[i+2] = 0;
        }
      }
      return { data };
    } })
  }) };
  assert.equal(findCellRight(page, { x: 10, y: 30, width: 40, height: 20 }, 180), 120);
});
