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
