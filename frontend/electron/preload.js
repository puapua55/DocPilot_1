const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docPilotSettings', {
  getGeminiSettings: () => ipcRenderer.invoke('gemini-settings:get'),
  saveGeminiSettings: (settings) => ipcRenderer.invoke('gemini-settings:set', {
    geminiApiKey: typeof settings?.geminiApiKey === 'string' ? settings.geminiApiKey : '',
    geminiModel: typeof settings?.geminiModel === 'string' ? settings.geminiModel : ''
  }),
  clearGeminiSettings: () => ipcRenderer.invoke('gemini-settings:clear'),
  getGeminiStatus: () => ipcRenderer.invoke('gemini-settings:status')
});

contextBridge.exposeInMainWorld('docPilotAi', {
  chat: (request) => ipcRenderer.invoke('docpilot-ai:chat', {
    message: typeof request?.message === 'string' ? request.message : '',
    documentName: typeof request?.documentName === 'string' ? request.documentName : '',
    documentType: typeof request?.documentType === 'string' ? request.documentType : '',
    documentText: typeof request?.documentText === 'string' ? request.documentText : '',
    history: Array.isArray(request?.history) ? request.history : []
  })
});

contextBridge.exposeInMainWorld('docPilotFonts', {
  resolve: (request) => {
    const candidates = Array.isArray(request) ? request : request?.candidates;
    return ipcRenderer.invoke('docpilot-fonts:resolve', {
      candidates: Array.isArray(candidates) ? candidates.filter((value) => typeof value === 'string').slice(0, 12) : [],
      preferBold: request?.preferBold === true
    });
  },
  list: () => ipcRenderer.invoke('docpilot-fonts:list')
});

contextBridge.exposeInMainWorld('docPilotClipboard', {
  writeText: (value) => ipcRenderer.invoke('docpilot-clipboard:write-text', String(value || ''))
});
