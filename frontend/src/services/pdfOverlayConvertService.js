import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { isPdfFile } from '../utils/fileUtils';

const FONT_URL = '/fonts/NotoSansKR-Regular.base64.txt';
const TEXT_BASELINE_RATIO = 0.84;

function round(value, precision = 3) {
  const factor = 10 ** precision;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : 0;
}

function parseCssColor(value, fallback = [0, 0, 0]) {
  const channels = String(value || '').match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length < 3 || channels.some((channel) => !Number.isFinite(channel))) {
    return fallback;
  }
  return channels.map((channel) => Math.min(255, Math.max(0, channel)));
}

function toPdfColor(channels) {
  return rgb(channels[0] / 255, channels[1] / 255, channels[2] / 255);
}

function quantizeColor(red, green, blue) {
  const quantize = (value) => Math.min(255, Math.max(0, Math.round(value / 16) * 16));
  return [quantize(red), quantize(green), quantize(blue)];
}

function colorDistance(first, second) {
  return Math.sqrt(
    (first[0] - second[0]) ** 2
    + (first[1] - second[1]) ** 2
    + (first[2] - second[2]) ** 2
  );
}

function findDominantColor(pixels, excludedColor = null) {
  const counts = new Map();
  pixels.forEach(([red, green, blue]) => {
    const color = quantizeColor(red, green, blue);
    if (excludedColor && colorDistance(color, excludedColor) < 56) return;
    const key = color.join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dominant = Array.from(counts.entries()).sort((first, second) => second[1] - first[1])[0];
  return dominant ? dominant[0].split(',').map(Number) : null;
}

function sampleCanvasColors(pageElement, replacement) {
  const canvas = pageElement.querySelector('.pdf-canvas');
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!canvas || !context) return replacement;

  const scaleX = canvas.width / Math.max(pageElement.clientWidth, 1);
  const scaleY = canvas.height / Math.max(pageElement.clientHeight, 1);
  const left = Math.max(0, Math.floor(replacement.coverX * scaleX));
  const top = Math.max(0, Math.floor(replacement.coverY * scaleY));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(replacement.coverWidth * scaleX)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(replacement.coverHeight * scaleY)));
  if (left >= canvas.width || top >= canvas.height || width <= 0 || height <= 0) return replacement;

  const { data } = context.getImageData(left, top, width, height);
  const pixels = [];
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] > 0) pixels.push([data[index], data[index + 1], data[index + 2]]);
  }

  const backgroundColor = findDominantColor(pixels);
  const textColor = backgroundColor ? findDominantColor(pixels, backgroundColor) : null;
  const brightness = (color) => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
  // White page pixels bordering a yellow highlight are background, not ink.
  const ink = textColor && brightness(textColor) < 220 ? textColor : replacement.textColor;
  return {
    ...replacement,
    backgroundColor: backgroundColor || replacement.backgroundColor,
    textColor: ink
  };
}

function collectAppliedReplacements() {
  const replacements = [];
  const pages = Array.from(document.querySelectorAll('.pdf-viewer .pdf-page[data-page-number]'));

  pages.forEach((pageElement) => {
    const sourcePageWidth = pageElement.clientWidth || pageElement.getBoundingClientRect().width;
    const sourcePageHeight = pageElement.clientHeight || pageElement.getBoundingClientRect().height;

    pageElement.querySelectorAll('.replacement-layer > div').forEach((item) => {
      const cover = item.querySelector('.replacement-cover');
      const text = item.querySelector('.replacement-text');
      if (!cover || !text) return;

      const coverStyle = window.getComputedStyle(cover);
      const textStyle = window.getComputedStyle(text);
      const replacement = {
        pageNumber: Number(pageElement.dataset.pageNumber),
        sourcePageWidth,
        sourcePageHeight,
        coverX: Number.parseFloat(cover.style.left || coverStyle.left),
        coverY: Number.parseFloat(cover.style.top || coverStyle.top),
        coverWidth: Number.parseFloat(cover.style.width || coverStyle.width),
        coverHeight: Number.parseFloat(cover.style.height || coverStyle.height),
        textX: Number.parseFloat(text.style.left || textStyle.left),
        textY: Number.parseFloat(text.style.top || textStyle.top),
        baseline: Number(text.dataset.baseline),
        fontSize: Number.parseFloat(text.style.fontSize || textStyle.fontSize),
        text: text.textContent || '',
        backgroundColor: parseCssColor(coverStyle.backgroundColor, [255, 255, 255]),
        textColor: parseCssColor(textStyle.color, [17, 17, 17])
      };

      const numericValues = [
        replacement.pageNumber, replacement.sourcePageWidth, replacement.sourcePageHeight,
        replacement.coverX, replacement.coverY, replacement.coverWidth, replacement.coverHeight,
        replacement.textX, replacement.textY, replacement.fontSize
      ];
      if (numericValues.every(Number.isFinite)) {
        replacements.push(sampleCanvasColors(pageElement, replacement));
      }
    });
  });

  return replacements;
}

function base64ToBytes(base64) {
  const normalized = String(base64 || '').replace(/^data:.*?;base64,/, '').replace(/\s+/g, '');
  const binary = window.atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function loadReplacementFont() {
  const injected = window.__DOC_PILOT_KOREAN_FONT_BASE64__;
  if (typeof injected === 'string' && injected.trim()) return base64ToBytes(injected);

  const response = await fetch(FONT_URL);
  if (!response.ok) throw new Error('교체 텍스트용 글꼴을 불러오지 못했습니다.');
  return base64ToBytes(await response.text());
}

function normalizeRotation(angle) {
  return ((Number(angle) || 0) % 360 + 360) % 360;
}

function displayPointToPdf(x, y, pageWidth, pageHeight, rotation) {
  if (rotation === 90) return { x: y, y: x };
  if (rotation === 180) return { x: pageWidth - x, y };
  if (rotation === 270) return { x: pageWidth - y, y: pageHeight - x };
  return { x, y: pageHeight - y };
}

function getDisplaySize(pageWidth, pageHeight, rotation) {
  return rotation === 90 || rotation === 270
    ? { width: pageHeight, height: pageWidth }
    : { width: pageWidth, height: pageHeight };
}

function mapReplacementToPage(replacement, page) {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const rotation = normalizeRotation(page.getRotation()?.angle);
  const display = getDisplaySize(pageWidth, pageHeight, rotation);
  const scaleX = display.width / Math.max(replacement.sourcePageWidth, 1);
  const scaleY = display.height / Math.max(replacement.sourcePageHeight, 1);
  const coverLeft = replacement.coverX * scaleX;
  const coverTop = replacement.coverY * scaleY;
  const coverRight = (replacement.coverX + replacement.coverWidth) * scaleX;
  const coverBottom = (replacement.coverY + replacement.coverHeight) * scaleY;
  const corners = [
    displayPointToPdf(coverLeft, coverTop, pageWidth, pageHeight, rotation),
    displayPointToPdf(coverRight, coverTop, pageWidth, pageHeight, rotation),
    displayPointToPdf(coverLeft, coverBottom, pageWidth, pageHeight, rotation),
    displayPointToPdf(coverRight, coverBottom, pageWidth, pageHeight, rotation)
  ];
  const rectX = Math.min(...corners.map((point) => point.x));
  const rectY = Math.min(...corners.map((point) => point.y));
  const baseline = displayPointToPdf(
    replacement.textX * scaleX,
    (Number.isFinite(replacement.baseline) ? replacement.baseline : replacement.textY + replacement.fontSize * TEXT_BASELINE_RATIO) * scaleY,
    pageWidth,
    pageHeight,
    rotation
  );

  return {
    rotation,
    rectX: round(rectX),
    rectY: round(rectY),
    rectWidth: round(Math.max(...corners.map((point) => point.x)) - rectX),
    rectHeight: round(Math.max(...corners.map((point) => point.y)) - rectY),
    textX: round(baseline.x),
    textY: round(baseline.y),
    fontSize: round(replacement.fontSize * scaleY)
  };
}

function getTextRotation(rotation) {
  if (rotation === 90) return degrees(90);
  if (rotation === 180) return degrees(180);
  if (rotation === 270) return degrees(270);
  return degrees(0);
}

function downloadPdf(bytes, outputFileName) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = outputFileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

export function makeOverlayConvertedFileName(fileName = 'document.pdf') {
  return `${fileName.replace(/\.pdf$/i, '')}_overlay_converted.pdf`;
}

export async function convertPdfWithOriginalOverlay({ file }) {
  if (!file || !isPdfFile(file)) throw new Error('먼저 PDF 파일을 선택해주세요.');

  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  const replacements = collectAppliedReplacements();
  if (!replacements.length) throw new Error('먼저 즉시 텍스트 교체에서 대상을 선택하고 화면에 적용해주세요.');

  const [sourceBytes, fontBytes] = await Promise.all([file.arrayBuffer(), loadReplacementFont()]);
  const pdfDocument = await PDFDocument.load(sourceBytes);
  pdfDocument.registerFontkit(fontkit);
  const replacementFont = await pdfDocument.embedFont(fontBytes, { subset: false });
  const pages = pdfDocument.getPages();

  replacements.forEach((replacement) => {
    const page = pages[replacement.pageNumber - 1];
    if (!page) return;
    const mapped = mapReplacementToPage(replacement, page);

    page.drawRectangle({
      x: mapped.rectX,
      y: mapped.rectY,
      width: mapped.rectWidth,
      height: mapped.rectHeight,
      color: toPdfColor(replacement.backgroundColor)
    });
    page.drawText(replacement.text, {
      x: mapped.textX,
      y: mapped.textY,
      size: mapped.fontSize,
      font: replacementFont,
      color: toPdfColor(replacement.textColor),
      rotate: getTextRotation(mapped.rotation)
    });
  });

  const outputFileName = makeOverlayConvertedFileName(file.name);
  const outputBytes = await pdfDocument.save({ useObjectStreams: true });
  downloadPdf(outputBytes, outputFileName);

  return {
    success: true,
    outputFileName,
    fileName: outputFileName,
    replaceCount: replacements.length,
    pages: pages.length,
    method: 'original-pdf-overlay'
  };
}
