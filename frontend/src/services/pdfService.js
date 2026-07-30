export function createPdfObjectUrl(file) {
  return URL.createObjectURL(file);
}

export function revokePdfObjectUrl(objectUrl) {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }
}

export function isPdfDocument(documentFile) {
  return documentFile?.extension === 'pdf';
}

export function getPdfPreviewModel(documentFile) {
  return {
    type: 'pdf',
    file: documentFile.file,
    fileName: documentFile.name,
    fileSize: documentFile.size
  };
}
