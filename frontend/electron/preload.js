const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docPilotSettings', {
  getOpenAiSettings: () => ipcRenderer.invoke('openai-settings:get'),
  saveOpenAiSettings: (settings) => ipcRenderer.invoke('openai-settings:set', {
    openAiApiKey: typeof settings?.openAiApiKey === 'string' ? settings.openAiApiKey : '',
    openAiModel: typeof settings?.openAiModel === 'string' ? settings.openAiModel : ''
  }),
  clearOpenAiSettings: () => ipcRenderer.invoke('openai-settings:clear'),
  getOpenAiStatus: () => ipcRenderer.invoke('openai-settings:status')
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
