// Coordinates and font sizes use the current viewport's CSS pixels.
export function fitReplacementWidth({ sourceSize, measuredWidth, startX, pageRight, nextTextX, cellRight, gap }) {
  const limits = [pageRight, nextTextX, cellRight].filter(Number.isFinite);
  const right = Math.min(...limits);
  const maxWidth = Math.max(0, right - startX - gap);
  return {
    maxWidth,
    fontSize: measuredWidth > maxWidth && measuredWidth > 0
      ? sourceSize * maxWidth / measuredWidth : sourceSize
  };
}

export function findNextTextX(lineGroup, endIndex, pageElement) {
  const pageRect = pageElement.getBoundingClientRect();
  let cursor = 0;
  const positions = [];
  for (const { span, text } of lineGroup.spans) {
    const start = Math.max(0, endIndex - cursor);
    cursor += text.length;
    if (start >= text.length) continue;
    const offset = text.slice(start).search(/\S/u);
    const node = Array.from(span.childNodes).find((child) => child.nodeType === 3);
    if (offset < 0 || !node) continue;
    const range = document.createRange();
    range.setStart(node, start + offset);
    range.setEnd(node, Math.min(start + offset + 1, node.length));
    positions.push(range.getBoundingClientRect().left - pageRect.left);
  }
  return positions.length ? Math.min(...positions) : undefined;
}

// Detect a visible vertical cell rule extending above and below the glyph band.
// Requiring a continuous line avoids interpreting ordinary glyph strokes as rules.
export function findCellRight(pageElement, box, searchRight) {
  const canvas = pageElement.querySelector('.pdf-canvas');
  const context = canvas?.getContext('2d');
  if (!context || !canvas.width || !canvas.height) return undefined;
  const sx = canvas.width / parseFloat(pageElement.style.width);
  const sy = canvas.height / parseFloat(pageElement.style.height);
  const left = Math.max(0, Math.ceil((box.x + box.width) * sx));
  const right = Math.min(canvas.width, Math.ceil(searchRight * sx));
  const top = Math.max(0, Math.floor((box.y - box.height * 0.3) * sy));
  const bottom = Math.min(canvas.height, Math.ceil((box.y + box.height * 1.3) * sy));
  if (right <= left || bottom <= top) return undefined;
  const width = right - left;
  const height = bottom - top;
  const pixels = context.getImageData(left, top, width, height).data;
  for (let x = 0; x < width; x++) {
    let hits = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] > 200 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 200) hits++;
    }
    if (hits / height >= 0.9) return (left + x) / sx;
  }
  return undefined;
}
