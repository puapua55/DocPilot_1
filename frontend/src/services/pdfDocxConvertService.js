import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EMU_PER_POINT = 12700;
const TWIPS_PER_POINT = 20;
const PDF_OPS = pdfjsLib.OPS || {};

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const twips = (points) => Math.max(0, Math.round(points * TWIPS_PER_POINT));
const halfPoints = (points) => Math.max(2, Math.round(points * 2));
const emu = (points) => Math.max(1, Math.round(points * EMU_PER_POINT));

function normalizeFontFamily(value) {
  const name = String(value || 'Arial').replace(/["']/g, '').split(',')[0].trim();
  if (/noto|malgun|gothic|batang|gulim|dotum/i.test(name)) return name;
  if (/times/i.test(name)) return 'Times New Roman';
  if (/courier/i.test(name)) return 'Courier New';
  return 'Arial';
}

function colorToHex(value) {
  if (!Array.isArray(value) || value.length < 3) return '000000';
  return value.slice(0, 3).map((part) => clamp(Math.round(Number(part) * 255), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function collectVisualInfo(page) {
  try {
    const operators = await page.getOperatorList();
    const colors = [];
    let currentColor = '000000';
    (operators.fnArray || []).forEach((fn, index) => {
      const args = operators.argsArray?.[index] || [];
      if (fn === PDF_OPS.setFillRGBColor) currentColor = colorToHex(args);
      if (fn === PDF_OPS.setFillGray) {
        const gray = clamp(Math.round(Number(args[0]) * 255), 0, 255).toString(16).padStart(2, '0');
        currentColor = `${gray}${gray}${gray}`.toUpperCase();
      }
      if ([PDF_OPS.showText, PDF_OPS.showSpacedText, PDF_OPS.nextLineShowText, PDF_OPS.nextLineSetSpacingShowText].includes(fn)) colors.push(currentColor);
    });
    return {
      colors,
      hasVisuals: (operators.fnArray || []).some((fn) => [PDF_OPS.paintImageXObject, PDF_OPS.paintInlineImageXObject, PDF_OPS.constructPath, PDF_OPS.rectangle].includes(fn))
    };
  } catch {
    return { colors: [], hasVisuals: false };
  }
}

function getPositionedItems(content, viewport, colors, replacePreview) {
  let colorIndex = 0;
  return content.items.map((item, index) => {
    const originalText = String(item?.str || '');
    if (!originalText.trim() || !Array.isArray(item.transform)) return null;
    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.max(6, Math.hypot(transform[2], transform[3]) || item.height || 10);
    const style = content.styles?.[item.fontName] || {};
    const text = replacePreview?.originalText
      ? originalText.split(replacePreview.originalText).join(String(replacePreview.newText ?? ''))
      : originalText;
    const result = {
      id: index, text, x: transform[4], baseline: transform[5], width: Math.abs(item.width || 0),
      fontSize, fontFamily: normalizeFontFamily(style.fontFamily || item.fontName), color: colors[colorIndex] || '000000',
      vertical: Boolean(style.vertical), bold: /bold|black|heavy|demi/i.test(`${item.fontName} ${style.fontFamily}`),
      italic: /italic|oblique/i.test(`${item.fontName} ${style.fontFamily}`)
    };
    colorIndex += 1;
    return result;
  }).filter(Boolean);
}

function groupIntoLines(items) {
  const lines = [];
  [...items].sort((a, b) => Math.abs(a.baseline - b.baseline) > 2 ? a.baseline - b.baseline : a.x - b.x).forEach((item) => {
    const line = lines.find((candidate) => Math.abs(candidate.baseline - item.baseline) <= Math.max(2.5, item.fontSize * 0.32));
    if (line) line.items.push(item);
    else lines.push({ baseline: item.baseline, items: [item] });
  });
  return lines.map((line) => ({ ...line, items: line.items.sort((a, b) => a.x - b.x) }));
}

function runXml(item) {
  const font = escapeXml(item.fontFamily);
  return `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/><w:color w:val="${item.color}"/><w:sz w:val="${halfPoints(item.fontSize)}"/><w:szCs w:val="${halfPoints(item.fontSize)}"/>${item.bold ? '<w:b/>' : ''}${item.italic ? '<w:i/>' : ''}${item.vertical ? '<w:vertAlign w:val="superscript"/>' : ''}</w:rPr><w:t xml:space="preserve">${escapeXml(item.text)}</w:t></w:r>`;
}

function alignment(line, pageWidth) {
  const left = line.items[0]?.x || 0;
  const right = Math.max(...line.items.map((item) => item.x + item.width));
  if (Math.abs((left + right) / 2 - pageWidth / 2) < pageWidth * 0.08) return 'center';
  if (pageWidth - right < pageWidth * 0.08 && left > pageWidth * 0.35) return 'right';
  return 'left';
}

function paragraphXml(line, previousBaseline, pageWidth) {
  const fontSize = Math.max(...line.items.map((item) => item.fontSize));
  const gap = previousBaseline == null ? 0 : Math.max(0, line.baseline - previousBaseline - fontSize);
  return `<w:p><w:pPr><w:jc w:val="${alignment(line, pageWidth)}"/><w:ind w:left="${twips(line.items[0]?.x || 0)}"/><w:spacing w:before="${twips(gap)}" w:after="0" w:line="${twips(fontSize * 1.2)}" w:lineRule="atLeast"/></w:pPr>${line.items.map(runXml).join('')}</w:p>`;
}

function tableXml(lines, pageWidth) {
  const anchors = [...new Set(lines.flatMap((line) => line.items.map((item) => Math.round(item.x / 8) * 8)))].sort((a, b) => a - b);
  const widths = anchors.map((anchor, index) => index + 1 < anchors.length ? anchors[index + 1] - anchor : Math.max(45, pageWidth - anchor));
  const rows = lines.map((line) => {
    const cells = [];
    for (let index = 0; index < anchors.length;) {
      const anchor = anchors[index];
      const item = line.items.find((candidate) => Math.abs(candidate.x - anchor) < 12);
      if (!item) {
        cells.push('<w:tc><w:p/></w:tc>');
        index += 1;
        continue;
      }
      const span = Math.max(1, anchors.filter((next) => next > anchor && next < item.x + item.width - 8).length + 1);
      const cellWidth = widths.slice(index, index + span).reduce((total, width) => total + width, 0);
      cells.push(`<w:tc><w:tcPr><w:tcW w:w="${twips(cellWidth)}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr><w:p>${runXml(item)}</w:p></w:tc>`);
      index += span;
    }
    return `<w:tr>${cells.join('')}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${twips(width)}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
}

function consumeTableGroups(lines, pageWidth) {
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const first = lines[index];
    if (first.items.length < 2) { blocks.push({ type: 'paragraph', line: first }); index += 1; continue; }
    const group = [first];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].items.length >= 2 && lines[cursor].baseline - lines[cursor - 1].baseline < 42) {
      if (lines[cursor].items.filter((item) => first.items.some((other) => Math.abs(item.x - other.x) < 14)).length < 2) break;
      group.push(lines[cursor]); cursor += 1;
    }
    if (group.length >= 2) blocks.push({ type: 'table', lines: group, pageWidth });
    else blocks.push({ type: 'paragraph', line: first });
    index = cursor;
  }
  return blocks;
}

async function renderPageFallback(page, viewport) {
  if (typeof document === 'undefined') return null;
  const renderViewport = page.getViewport({ scale: 1.5 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(renderViewport.width); canvas.height = Math.ceil(renderViewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? { blob, width: viewport.width, height: viewport.height } : null;
}

function drawingXml(image, relationshipId, id) {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${emu(image.width)}" cy="${emu(image.height)}"/><wp:docPr id="${id}" name="PDF page fallback ${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="page.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(image.width)}" cy="${emu(image.height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function sectionXml(viewport, isLast) {
  return `<w:sectPr>${isLast ? '' : '<w:type w:val="nextPage"/>'}<w:pgSz w:w="${twips(viewport.width)}" w:h="${twips(viewport.height)}"${viewport.width > viewport.height ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function convertPdfToDocx({ pdfDocument, file, replacePreview }) {
  if (!pdfDocument) throw new Error('PDF 문서가 아직 준비되지 않았습니다.');
  const zip = new JSZip(); const body = []; const relationships = []; let imageIndex = 0;
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const [content, visualInfo] = await Promise.all([page.getTextContent(), collectVisualInfo(page)]);
    const lines = groupIntoLines(getPositionedItems(content, viewport, visualInfo.colors, replacePreview));
    if (!lines.length && visualInfo.hasVisuals) {
      const image = await renderPageFallback(page, viewport);
      if (image) {
        imageIndex += 1; const relationshipId = `rId${imageIndex}`;
        zip.file(`word/media/page-${imageIndex}.png`, image.blob);
        relationships.push(`<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page-${imageIndex}.png"/>`);
        body.push(drawingXml(image, relationshipId, imageIndex));
      }
    } else {
      let previousBaseline = null;
      consumeTableGroups(lines, viewport.width).forEach((block) => {
        if (block.type === 'table') { body.push(tableXml(block.lines, viewport.width)); previousBaseline = block.lines.at(-1)?.baseline ?? previousBaseline; }
        else { body.push(paragraphXml(block.line, previousBaseline, viewport.width)); previousBaseline = block.line.baseline; }
      });
    }
    body.push(sectionXml(viewport, pageNumber === pdfDocument.numPages));
  }
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageIndex ? '<Default Extension="png" ContentType="image/png"/>' : ''}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}</w:body></w:document>`);
  const blob = await zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME });
  const outputFileName = `${String(file?.name || 'document.pdf').replace(/\.pdf$/i, '')}.docx`;
  downloadBlob(blob, outputFileName);
  return { outputFileName, fileName: outputFileName, fileType: 'docx', pages: pdfDocument.numPages };
}
