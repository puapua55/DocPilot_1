import { useState } from 'react';
import { openDocument, saveCurrentDocument } from '../services/documentService';
import { getFeatureMessage } from '../services/searchService';

export function useDocument() {
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [previewModel, setPreviewModel] = useState(null);
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
      setErrorMessage(result.errorMessage);
      return;
    }

    setSelectedDocument(result.documentFile);
    setPreviewModel(result.preview);
    setErrorMessage('');
    setStatusMessage('');
  };

  const handleFeatureClick = (featureKey) => {
    setStatusMessage(getFeatureMessage(featureKey));
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
    errorMessage,
    statusMessage,
    handleDocumentSelect,
    handleFeatureClick,
    handleSave
  };
}
