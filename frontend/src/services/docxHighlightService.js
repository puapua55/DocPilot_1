import JSZip from 'jszip';
import { downloadBlob } from './docxTextReplaceService';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_XML_PATH = /^(word\/document\.xml|word\/(?:header|footer|footnotes|endnotes|comments)\d*\.xml)$/i;

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function escapeXmlAttribute(value) {
  return String(value || '').replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function addHighlightToRun(runXml, target, color) {
  const text = [...runXml.matchAll(/<([A-Za-z_][\w.-]*):t\b[^>]*>([\s\S]*?)<\/\1:t>/g)]
    .map((match) => decodeXml(match[2]))
    .join('');
  if (!text.includes(target)) return runXml;

  const runPrefix = runXml.match(/<([A-Za-z_][\w.-]*):r\b/)?.[1] || 'w';
  const highlight = `<${runPrefix}:highlight ${runPrefix}:val="${escapeXmlAttribute(color)}"/>`;
  const existingHighlight = new RegExp(`<${runPrefix}:highlight\\b[^>]*/>`);
  if (existingHighlight.test(runXml)) return runXml.replace(existingHighlight, highlight);

  const rPrOpen = new RegExp(`(<${runPrefix}:rPr\\b[^>]*>)`);
  if (rPrOpen.test(runXml)) return runXml.replace(rPrOpen, `$1${highlight}`);

  const firstText = new RegExp(`(<${runPrefix}:t\\b)`);
  return runXml.replace(firstText, `<${runPrefix}:rPr>${highlight}</${runPrefix}:rPr>$1`);
}

function highlightXml(xmlText, highlights) {
  let output = String(xmlText || '');
  highlights.forEach(({ text, color }) => {
    if (!text) return;
    const runPattern = /<([A-Za-z_][\w.-]*):r\b[\s\S]*?<\/\1:r>/g;
    output = output.replace(runPattern, (runXml) => addHighlightToRun(runXml, text, color));
  });
  return output;
}

function makeOutputName(fileName = 'document.docx') {
  return `${String(fileName).replace(/\.docx?$/i, '')}_highlighted.docx`;
}

export async function convertDocxFileWithHighlights(file, highlights = []) {
  if (!file) throw new Error('DOCX 파일이 선택되지 않았습니다.');
  if (!highlights.length) {
    downloadBlob(file, file.name);
    return { outputFileName: file.name, highlightCount: 0 };
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const targets = [...new Map(highlights
    .map((item) => ({ text: String(item?.text || '').trim(), color: String(item?.color || 'yellow') }))
    .filter((item) => item.text)
    .map((item) => [`${item.color}:${item.text}`, item]))
    .values()];

  let changedEntryCount = 0;
  for (const path of Object.keys(zip.files)) {
    if (!TEXT_XML_PATH.test(path)) continue;
    const entry = zip.file(path);
    if (!entry) continue;
    const source = await entry.async('string');
    const changed = highlightXml(source, targets);
    if (changed !== source) {
      zip.file(path, changed);
      changedEntryCount += 1;
    }
  }

  const blob = await zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME_TYPE });
  const outputFileName = makeOutputName(file.name);
  downloadBlob(blob, outputFileName);
  return { outputFileName, highlightCount: targets.length, changedEntryCount };
}
