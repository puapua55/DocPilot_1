// Document-point thickness shared by the CSS viewer and every PDF writer.
export function pdfTextDecorationThickness(fontSize) {
  return Math.max(0.5, (Number(fontSize) || 10) * 0.03);
}
