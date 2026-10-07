import JSZip from 'jszip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const children = (node, name) => Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1 && child.namespaceURI === W && child.localName === name);
const descendants = (node, name) => Array.from(node?.getElementsByTagNameNS(W, name) || []);
const create = (doc, name) => doc.createElementNS(W, `w:${name}`);
const setW = (node, name, value) => node.setAttributeNS(W, `w:${name}`, String(value));
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export async function readDocxParagraphs(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('DOCX 본문을 찾을 수 없습니다.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const body = descendants(doc, 'body')[0];
  return descendants(body, 'p').map((paragraph, index) => ({
    index,
    text: normalize(Array.from(paragraph.getElementsByTagName('*'))
      .filter((item) => item.namespaceURI === W && ['t', 'tab', 'br'].includes(item.localName))
      .map((item) => item.localName === 't' ? item.textContent : ' ')
      .join(''))
  }));
}

export async function readDocxTables(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return descendants(descendants(doc, 'body')[0], 'tbl').map((table, index) => ({
    index,
    text: normalize(descendants(table, 't').map((node) => node.textContent).join(' '))
  }));
}

export async function makeDocxPageBreakPreview(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return file;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const paragraphs = descendants(descendants(doc, 'body')[0], 'p');
  let changed = false;
  paragraphs.forEach((paragraph, index) => {
    const props = children(paragraph, 'pPr')[0];
    const pageBefore = children(props, 'pageBreakBefore')[0];
    if (!pageBefore || ['0', 'false', 'off'].includes(pageBefore.getAttributeNS(W, 'val') || '')) return;
    if (index === 0) return;
    const carrier = create(doc, 'p');
    const run = create(doc, 'r');
    const pageBreak = create(doc, 'br');
    setW(pageBreak, 'type', 'page');
    run.appendChild(pageBreak);
    carrier.appendChild(run);
    paragraph.parentNode.insertBefore(carrier, paragraph);
    changed = true;
  });
  if (!changed) return file;
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'blob', mimeType: MIME });
}

function appendRun(paragraph, text, style) {
  if (!text) return;
  const doc = paragraph.ownerDocument;
  const run = create(doc, 'r');
  const props = create(doc, 'rPr');
  const family = style.fontFamily?.split(',')[0]?.replace(/["']/g, '').trim();
  if (family) {
    const fonts = create(doc, 'rFonts');
    ['ascii', 'hAnsi', 'eastAsia', 'cs'].forEach((name) => setW(fonts, name, family));
    props.appendChild(fonts);
  }
  const px = Number.parseFloat(style.fontSize);
  if (px > 0) {
    const size = create(doc, 'sz');
    setW(size, 'val', Math.max(1, Math.round(px * 1.5)));
    props.appendChild(size);
  }
  if (Number(style.fontWeight) >= 600 || /bold/i.test(style.fontWeight)) props.appendChild(create(doc, 'b'));
  if (style.fontStyle === 'italic') props.appendChild(create(doc, 'i'));
  if (style.textDecorationLine?.includes('underline')) props.appendChild(create(doc, 'u'));
  if (style.textDecorationLine?.includes('line-through')) props.appendChild(create(doc, 'strike'));
  const letterSpacingPx = Number.parseFloat(style.letterSpacing);
  if (Number.isFinite(letterSpacingPx) && Math.abs(letterSpacingPx) > 0.001) {
    const spacing = create(doc, 'spacing');
    setW(spacing, 'val', Math.round(letterSpacingPx * 15));
    props.appendChild(spacing);
  }
  const rgb = style.color?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) {
    const color = create(doc, 'color');
    setW(color, 'val', rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase());
    props.appendChild(color);
  }
  if (props.childNodes.length) run.appendChild(props);
  const t = create(doc, 't');
  t.setAttribute('xml:space', 'preserve');
  t.textContent = text;
  run.appendChild(t);
  paragraph.appendChild(run);
}

function replaceParagraph(paragraph, element) {
  const alignment = { left: 'left', center: 'center', right: 'right', justify: 'both' }[element.style.textAlign];
  if (alignment) {
    let props = children(paragraph, 'pPr')[0];
    if (!props) {
      props = create(paragraph.ownerDocument, 'pPr');
      paragraph.insertBefore(props, paragraph.firstChild);
    }
    let justification = children(props, 'jc')[0];
    if (!justification) {
      justification = create(paragraph.ownerDocument, 'jc');
      props.appendChild(justification);
    }
    setW(justification, 'val', alignment);
  }
  Array.from(paragraph.childNodes).forEach((child) => {
    if (!(child.nodeType === 1 && child.namespaceURI === W && child.localName === 'pPr')) paragraph.removeChild(child);
  });
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      return node.nodeName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) appendRun(paragraph, node.nodeValue, window.getComputedStyle(node.parentElement));
    else if (node.nodeName === 'BR') {
      const run = create(paragraph.ownerDocument, 'r');
      run.appendChild(create(paragraph.ownerDocument, 'br'));
      paragraph.appendChild(run);
    }
  }
}

function imageDrawing(doc, relationshipId, width, height, drawingId) {
  const run = create(doc, 'r');
  const drawing = create(doc, 'drawing');
  const inline = doc.createElementNS(WP, 'wp:inline');
  const extent = doc.createElementNS(WP, 'wp:extent');
  extent.setAttribute('cx', String(Math.round(width * 9525)));
  extent.setAttribute('cy', String(Math.round(height * 9525)));
  inline.appendChild(extent);
  const docPr = doc.createElementNS(WP, 'wp:docPr');
  docPr.setAttribute('id', String(drawingId));
  docPr.setAttribute('name', `DocPilot image ${drawingId}`);
  inline.appendChild(docPr);
  const graphic = doc.createElementNS(A, 'a:graphic');
  const graphicData = doc.createElementNS(A, 'a:graphicData');
  graphicData.setAttribute('uri', PIC);
  const pic = doc.createElementNS(PIC, 'pic:pic');
  const nvPicPr = doc.createElementNS(PIC, 'pic:nvPicPr');
  const cNvPr = doc.createElementNS(PIC, 'pic:cNvPr');
  cNvPr.setAttribute('id', '0');
  cNvPr.setAttribute('name', `Image ${drawingId}`);
  nvPicPr.appendChild(cNvPr);
  nvPicPr.appendChild(doc.createElementNS(PIC, 'pic:cNvPicPr'));
  pic.appendChild(nvPicPr);
  const blipFill = doc.createElementNS(PIC, 'pic:blipFill');
  const blip = doc.createElementNS(A, 'a:blip');
  blip.setAttributeNS(R, 'r:embed', relationshipId);
  blipFill.appendChild(blip);
  const stretch = doc.createElementNS(A, 'a:stretch');
  stretch.appendChild(doc.createElementNS(A, 'a:fillRect'));
  blipFill.appendChild(stretch);
  pic.appendChild(blipFill);
  const spPr = doc.createElementNS(PIC, 'pic:spPr');
  const xfrm = doc.createElementNS(A, 'a:xfrm');
  const off = doc.createElementNS(A, 'a:off');
  off.setAttribute('x', '0'); off.setAttribute('y', '0');
  const ext = doc.createElementNS(A, 'a:ext');
  ext.setAttribute('cx', extent.getAttribute('cx')); ext.setAttribute('cy', extent.getAttribute('cy'));
  xfrm.append(off, ext);
  spPr.appendChild(xfrm);
  const geom = doc.createElementNS(A, 'a:prstGeom');
  geom.setAttribute('prst', 'rect');
  geom.appendChild(doc.createElementNS(A, 'a:avLst'));
  spPr.appendChild(geom);
  pic.appendChild(spPr);
  graphicData.appendChild(pic);
  graphic.appendChild(graphicData);
  inline.appendChild(graphic);
  drawing.appendChild(inline);
  run.appendChild(drawing);
  return run;
}

function clearTableCell(cell) {
  Array.from(cell.childNodes).forEach((child) => {
    if (!(child.nodeType === 1 && child.namespaceURI === W && child.localName === 'tcPr')) cell.removeChild(child);
  });
  cell.appendChild(create(cell.ownerDocument, 'p'));
}

function applyTableOperation(table, operation) {
  const rows = children(table, 'tr');
  const position = Math.max(0, Math.floor(Number(operation.position) || 0));
  if (operation.type === 'insertRow' && rows.length) {
    const source = rows[Math.min(position, rows.length - 1)];
    const added = source.cloneNode(true);
    children(children(added, 'trPr')[0], 'tblHeader').forEach((header) => header.remove());
    children(added, 'tc').forEach(clearTableCell);
    table.insertBefore(added, rows[position] || null);
  } else if (operation.type === 'deleteRow' && rows.length > 1 && rows[position]) {
    rows[position].remove();
  } else if (operation.type === 'insertColumn' && rows.length) {
    rows.forEach((row) => {
      const cells = children(row, 'tc');
      const source = cells[Math.min(position, cells.length - 1)];
      if (!source) return;
      const added = source.cloneNode(true);
      clearTableCell(added);
      row.insertBefore(added, cells[position] || null);
    });
    const grid = children(table, 'tblGrid')[0];
    if (grid) {
      const columns = children(grid, 'gridCol');
      const source = columns[Math.min(position, columns.length - 1)];
      if (source) grid.insertBefore(source.cloneNode(true), columns[position] || null);
    }
  } else if (operation.type === 'deleteColumn') {
    rows.forEach((row) => {
      const cells = children(row, 'tc');
      if (cells.length > 1) cells[position]?.remove();
    });
    const grid = children(table, 'tblGrid')[0];
    const columns = children(grid, 'gridCol');
    if (columns.length > 1) columns[position]?.remove();
  } else if (operation.type === 'mergeRight') {
    const row = rows[Math.max(0, Math.floor(Number(operation.row) || 0))];
    const cells = children(row, 'tc');
    const first = cells[position];
    const second = cells[position + 1];
    if (!first || !second) return;
    let props = children(first, 'tcPr')[0];
    if (!props) { props = create(table.ownerDocument, 'tcPr'); first.insertBefore(props, first.firstChild); }
    let span = children(props, 'gridSpan')[0];
    if (!span) { span = create(table.ownerDocument, 'gridSpan'); props.appendChild(span); }
    setW(span, 'val', 2);
    Array.from(second.childNodes).forEach((child) => {
      if (child.nodeType === 1 && child.namespaceURI === W && child.localName !== 'tcPr') first.appendChild(child);
    });
    second.remove();
  } else if (operation.type === 'mergeRange') {
    const startRow = Math.max(0, Math.floor(Number(operation.row) || 0));
    const endRow = Math.min(rows.length - 1, Math.floor(Number(operation.endRow) || 0));
    const startColumn = position;
    const endColumn = Math.floor(Number(operation.endColumn) || 0);
    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      const cells = children(rows[rowIndex], 'tc');
      const first = cells[startColumn];
      if (!first) continue;
      let props = children(first, 'tcPr')[0];
      if (!props) { props = create(table.ownerDocument, 'tcPr'); first.insertBefore(props, first.firstChild); }
      if (endColumn > startColumn) {
        let span = children(props, 'gridSpan')[0];
        if (!span) { span = create(table.ownerDocument, 'gridSpan'); props.appendChild(span); }
        setW(span, 'val', endColumn - startColumn + 1);
      }
      if (endRow > startRow) {
        let merge = children(props, 'vMerge')[0];
        if (!merge) { merge = create(table.ownerDocument, 'vMerge'); props.appendChild(merge); }
        if (rowIndex === startRow) setW(merge, 'val', 'restart');
      }
      for (let columnIndex = endColumn; columnIndex > startColumn; columnIndex -= 1) cells[columnIndex]?.remove();
      if (rowIndex > startRow) clearTableCell(first);
    }
  }
}

function cssColorHex(value) {
  const hex = String(value || '').match(/^#([\da-f]{6})$/i);
  if (hex) return hex[1].toUpperCase();
  const rgb = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return rgb ? rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
}

const WORD_BORDER_VALUE = {
  none: 'nil', solid: 'single', dotted: 'dotted', dashed: 'dashed',
  'long-dashed': 'dashLong', 'dash-dot': 'dotDash', double: 'double'
};

function writeCellBorders(props, domCell, includeDefaults = false) {
  let saved = {};
  try { saved = JSON.parse(domCell.dataset.docxBorderEdges || '{}'); } catch { /* Ignore invalid preview metadata. */ }
  const sides = includeDefaults ? ['top', 'right', 'bottom', 'left', 'diagonalDown', 'diagonalUp'] : Object.keys(saved);
  if (!sides.length) return;
  let borders = children(props, 'tcBorders')[0];
  if (!borders) { borders = create(props.ownerDocument, 'tcBorders'); props.appendChild(borders); }
  const computed = domCell.ownerDocument.defaultView.getComputedStyle(domCell);
  sides.forEach((side) => {
    const xmlSide = { diagonalDown: 'tl2br', diagonalUp: 'tr2bl' }[side] || side;
    if (!['top', 'right', 'bottom', 'left', 'tl2br', 'tr2bl'].includes(xmlSide)) return;
    const cssSide = side[0].toUpperCase() + side.slice(1);
    const stroke = saved[side] || (side.startsWith('diagonal')
      ? { style: 'none', width: 1, color: '#000000' }
      : { style: computed[`border${cssSide}Style`], width: Number.parseFloat(computed[`border${cssSide}Width`]) || 1,
        color: computed[`border${cssSide}Color`] });
    let border = children(borders, xmlSide)[0];
    if (!border) { border = create(props.ownerDocument, xmlSide); borders.appendChild(border); }
    setW(border, 'val', WORD_BORDER_VALUE[stroke.style] || 'single');
    if (stroke.style !== 'none') {
      setW(border, 'sz', Math.max(2, Math.round((Number(stroke.width) || 1) * 6)));
      setW(border, 'color', cssColorHex(stroke.color) || '000000');
    }
  });
}

function applyEditedTable(table, element) {
  const domRows = Array.from(element.rows);
  const xmlRows = children(table, 'tr');
  const blockedUntil = [];
  domRows.forEach((domRow, rowIndex) => {
    const xmlCells = children(xmlRows[rowIndex], 'tc');
    let xmlColumn = 0;
    const xmlByColumn = new Map();
    xmlCells.forEach((cell) => {
      xmlByColumn.set(xmlColumn, cell);
      const span = children(children(cell, 'tcPr')[0], 'gridSpan')[0];
      xmlColumn += Math.max(1, Number(span?.getAttributeNS(W, 'val')) || 1);
    });
    let domColumn = 0;
    Array.from(domRow.cells).forEach((domCell) => {
      while (blockedUntil[domColumn] >= rowIndex) domColumn += 1;
      const column = domColumn;
      for (let offset = 0; offset < domCell.colSpan; offset += 1) {
        if (domCell.rowSpan > 1) blockedUntil[column + offset] = rowIndex + domCell.rowSpan - 1;
      }
      domColumn += domCell.colSpan;
      const xmlCell = xmlByColumn.get(column);
      if (!xmlCell) return;
      if (domCell.dataset.docxNewCell === 'true') {
        clearTableCell(xmlCell);
        const paragraph = children(xmlCell, 'p')[0];
        replaceParagraph(paragraph, domCell.querySelector('p') || domCell);
      }
      if (domCell.dataset.docxCellStyleDirty !== 'true') return;
      let props = children(xmlCell, 'tcPr')[0];
      if (!props) {
        props = create(table.ownerDocument, 'tcPr');
        xmlCell.insertBefore(props, xmlCell.firstChild);
      }
      const fill = cssColorHex(domCell.style.backgroundColor);
      if (fill) {
        let shading = children(props, 'shd')[0];
        if (!shading) { shading = create(table.ownerDocument, 'shd'); props.appendChild(shading); }
        setW(shading, 'fill', fill);
        setW(shading, 'val', 'clear');
      }
      writeCellBorders(props, domCell);
    });
  });
}

function createAddedTable(doc, element) {
  const table = create(doc, 'tbl');
  const properties = create(doc, 'tblPr');
  const width = create(doc, 'tblW');
  setW(width, 'w', 0);
  setW(width, 'type', 'auto');
  properties.appendChild(width);
  table.appendChild(properties);
  const grid = create(doc, 'tblGrid');
  const columns = Math.max(1, ...Array.from(element.rows).map((row) =>
    Array.from(row.cells).reduce((count, cell) => count + cell.colSpan, 0)));
  for (let column = 0; column < columns; column += 1) {
    const gridColumn = create(doc, 'gridCol');
    setW(gridColumn, 'w', Math.round(9000 / columns));
    grid.appendChild(gridColumn);
  }
  table.appendChild(grid);
  const verticalSpans = new Map();
  Array.from(element.rows).forEach((domRow, rowIndex) => {
    const row = create(doc, 'tr');
    let currentColumn = 0;
    const appendContinuation = () => {
      const span = verticalSpans.get(currentColumn);
      if (!span || span.endRow < rowIndex) return false;
      const cell = create(doc, 'tc');
      const props = create(doc, 'tcPr');
      if (span.columns > 1) {
        const gridSpan = create(doc, 'gridSpan');
        setW(gridSpan, 'val', span.columns);
        props.appendChild(gridSpan);
      }
      props.appendChild(create(doc, 'vMerge'));
      cell.appendChild(props);
      cell.appendChild(create(doc, 'p'));
      row.appendChild(cell);
      currentColumn += span.columns;
      return true;
    };
    Array.from(domRow.cells).forEach((domCell) => {
      while (appendContinuation()) { /* fill vertically merged columns */ }
      const cell = create(doc, 'tc');
      const props = create(doc, 'tcPr');
      const widthNode = create(doc, 'tcW');
      setW(widthNode, 'w', Math.round(9000 * domCell.colSpan / columns));
      setW(widthNode, 'type', 'dxa');
      props.appendChild(widthNode);
      if (domCell.colSpan > 1) {
        const span = create(doc, 'gridSpan');
        setW(span, 'val', domCell.colSpan);
        props.appendChild(span);
      }
      if (domCell.rowSpan > 1) {
        const merge = create(doc, 'vMerge');
        setW(merge, 'val', 'restart');
        props.appendChild(merge);
        verticalSpans.set(currentColumn, { endRow: rowIndex + domCell.rowSpan - 1, columns: domCell.colSpan });
      }
      const fill = cssColorHex(domCell.style.backgroundColor) || 'FFFFFF';
      const shading = create(doc, 'shd');
      setW(shading, 'fill', fill);
      setW(shading, 'val', 'clear');
      props.appendChild(shading);
      writeCellBorders(props, domCell, true);
      cell.appendChild(props);
      const paragraphs = Array.from(domCell.children).filter((child) => child.matches('p'));
      for (const domParagraph of paragraphs.length ? paragraphs : [domCell]) {
        const paragraph = create(doc, 'p');
        replaceParagraph(paragraph, domParagraph);
        cell.appendChild(paragraph);
      }
      row.appendChild(cell);
      currentColumn += domCell.colSpan;
    });
    while (currentColumn < columns && appendContinuation()) { /* trailing merged columns */ }
    table.appendChild(row);
  });
  return table;
}

export async function makeEditedDocx(file, edits, images, tables = [], addedBlocks = []) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('DOCX 본문을 찾을 수 없습니다.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const body = descendants(doc, 'body')[0];
  const paragraphs = descendants(body, 'p');
  edits.forEach(({ index, element }) => {
    if (paragraphs[index]) replaceParagraph(paragraphs[index], element);
  });
  const sourceTables = descendants(body, 'tbl');
  tables.forEach(({ index, element, operations }) => {
    const table = sourceTables[index];
    if (!table) return;
    operations.forEach((operation) => applyTableOperation(table, operation));
    applyEditedTable(table, element);
  });
  const blockAnchors = new Map();
  addedBlocks.forEach(({ afterIndex, afterTableIndex, kind, element }) => {
    const key = afterTableIndex === null || afterTableIndex === undefined
      ? `paragraph-${afterIndex}` : `table-${afterTableIndex}`;
    const anchor = blockAnchors.get(key)
      || (afterTableIndex === null || afterTableIndex === undefined ? paragraphs[afterIndex] : sourceTables[afterTableIndex]);
    const block = kind === 'table' ? createAddedTable(doc, element) : create(doc, 'p');
    if (kind === 'paragraph') replaceParagraph(block, element);
    if (anchor?.parentNode === body) anchor.parentNode.insertBefore(block, anchor.nextSibling);
    else body.insertBefore(block, children(body, 'sectPr')[0] || null);
    blockAnchors.set(key, block);
  });
  if (images.length) {
    const relPath = 'word/_rels/document.xml.rels';
    const relXml = await zip.file(relPath)?.async('string') || `<Relationships xmlns="${REL}"/>`;
    const relDoc = new DOMParser().parseFromString(relXml, 'application/xml');
    const relRoot = relDoc.documentElement;
    const typeXml = await zip.file('[Content_Types].xml')?.async('string');
    const typeDoc = new DOMParser().parseFromString(typeXml, 'application/xml');
    let nextId = Math.max(0, ...Array.from(relRoot.children).map((item) => Number(item.getAttribute('Id')?.replace(/^rId/, '')) || 0)) + 1;
    const imageAnchors = new Map();
    for (const [imageIndex, image] of images.entries()) {
      const paragraph = paragraphs[image.afterIndex];
      if (!paragraph) continue;
      const mime = image.dataUrl.match(/^data:(image\/(?:png|jpeg|gif));base64,/i)?.[1];
      if (!mime) continue;
      const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
      const path = `word/media/docpilot-${Date.now()}-${imageIndex}.${extension}`;
      zip.file(path, image.dataUrl.split(',')[1], { base64: true });
      if (!Array.from(typeDoc.documentElement.children).some((item) => item.getAttribute('Extension') === extension)) {
        const type = typeDoc.createElementNS(CT, 'Default');
        type.setAttribute('Extension', extension); type.setAttribute('ContentType', mime);
        typeDoc.documentElement.appendChild(type);
      }
      const id = `rId${nextId++}`;
      const rel = relDoc.createElementNS(REL, 'Relationship');
      rel.setAttribute('Id', id);
      rel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image');
      rel.setAttribute('Target', path.replace(/^word\//, ''));
      relRoot.appendChild(rel);
      const imageParagraph = create(doc, 'p');
      imageParagraph.appendChild(imageDrawing(doc, id, image.width, image.height, nextId + imageIndex));
      const anchor = imageAnchors.get(image.afterIndex) || paragraph;
      anchor.parentNode.insertBefore(imageParagraph, anchor.nextSibling);
      imageAnchors.set(image.afterIndex, imageParagraph);
    }
    zip.file(relPath, new XMLSerializer().serializeToString(relDoc));
    zip.file('[Content_Types].xml', new XMLSerializer().serializeToString(typeDoc));
  }
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'blob', mimeType: MIME });
}
