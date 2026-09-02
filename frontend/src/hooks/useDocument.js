import { useState } from 'react';
import { openDocument, saveCurrentDocument } from '../services/documentService';
import { getFeatureMessage } from '../services/searchService';
import { buildFileMetadataText, downloadTextFile, getFileExtension } from '../utils/fileUtils';

export function useDocument() {
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [previewModel, setPreviewModel] = useState(null);
  const [documentText, setDocumentText] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const handleDocumentSelect = async (file) => {
    if (!file) {
      return;
    }

    const result = await openDocument(file);

    if (!result.ok) {
      setSelectedDocument(null);
      setPreviewModel(null);
      setDocumentText([]);
      setErrorMessage(result.errorMessage);
      return;
    }

    const baseName = (file.name || 'document').replace(/\.[^/.]+$/, '');
    const metadataText = buildFileMetadataText(file, result.documentInfo);
    downloadTextFile(metadataText, `${baseName}_metadata.txt`);

    setSelectedDocument(result.documentFile);
    setPreviewModel(result.preview);
    setDocumentText(result.documentText || []);
    setErrorMessage('');
    setStatusMessage('');
  };

  const handleFeatureClick = (featureKey) => {
    setStatusMessage(getFeatureMessage(featureKey));
  };

  const clearSelectedDocument = () => {
    setSelectedDocument(null);
    setPreviewModel(null);
    setDocumentText([]);
    setErrorMessage('');
    setStatusMessage('');
  };

  const handleSave = async () => {
    if (!selectedDocument) {
      return;
    }

    await saveCurrentDocument(selectedDocument);
  };

  return {
    selectedDocument,
    previewModel,
    documentText,
    errorMessage,
    statusMessage,
    handleDocumentSelect,
    clearSelectedDocument,
    handleFeatureClick,
    handleSave
  };
}
