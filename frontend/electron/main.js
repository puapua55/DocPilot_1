import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatWithGemini } from './geminiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDevUrl = 'http://localhost:5173';
const defaultGeminiModel = 'gemini-3.1-flash-lite';

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readLocalSettings() {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return {
      geminiApiKey: typeof parsed.geminiApiKey === 'string' ? parsed.geminiApiKey.trim() : '',
      geminiModel: typeof parsed.geminiModel === 'string' && parsed.geminiModel.trim()
        ? parsed.geminiModel.trim()
        : defaultGeminiModel
    };
  } catch (error) {
    console.error(`Gemini settings could not be read: ${error.message}`);
    return {};
  }
}

function maskApiKey(apiKey = '') {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '••••••••';
  return `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}`;
}

function getGeminiStatus() {
  const settings = readLocalSettings();
  const resolvedApiKey = process.env.GEMINI_API_KEY || settings.geminiApiKey;
  const resolvedModel = process.env.GEMINI_MODEL || settings.geminiModel || defaultGeminiModel;
  return {
    hasApiKey: Boolean(resolvedApiKey),
    maskedApiKey: maskApiKey(resolvedApiKey),
    model: resolvedModel
  };
}

function saveGeminiSettings(input = {}) {
  const current = readLocalSettings();
  const nextApiKey = typeof input.geminiApiKey === 'string' && input.geminiApiKey.trim()
    ? input.geminiApiKey.trim()
    : current.geminiApiKey || '';
  const nextModel = typeof input.geminiModel === 'string' && input.geminiModel.trim()
    ? input.geminiModel.trim()
    : defaultGeminiModel;
  const settingsPath = getSettingsPath();

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ geminiApiKey: nextApiKey, geminiModel: nextModel }, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
  return getGeminiStatus();
}

function clearGeminiSettings() {
  const settingsPath = getSettingsPath();
  if (existsSync(settingsPath)) unlinkSync(settingsPath);
  return getGeminiStatus();
}

function registerSettingsIpc() {
  ipcMain.handle('gemini-settings:get', () => getGeminiStatus());
  ipcMain.handle('gemini-settings:status', () => getGeminiStatus());
  ipcMain.handle('gemini-settings:set', (_event, settings) => saveGeminiSettings(settings));
  ipcMain.handle('gemini-settings:clear', () => clearGeminiSettings());
}

function getStartUrl() {
  const configuredUrl = process.env.ELECTRON_START_URL;
  if (!configuredUrl) return null;

  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('ELECTRON_START_URL must point to the local Vite server');
    }
    return url.toString();
  } catch (error) {
    console.error(error.message);
    return defaultDevUrl;
  }
}

function registerAiIpc() {
  ipcMain.handle('docpilot-ai:chat', (_event, request = {}) => chatWithGemini({
    message: typeof request.message === 'string' ? request.message : '',
    documentName: typeof request.documentName === 'string' ? request.documentName : '',
    documentType: typeof request.documentType === 'string' ? request.documentType : '',
    documentText: typeof request.documentText === 'string' ? request.documentText : '',
    history: Array.isArray(request.history) ? request.history : []
  }, readLocalSettings()));
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const isLocalDevUrl = navigationUrl.startsWith(defaultDevUrl);
    const isPackagedAppUrl = navigationUrl.startsWith('file://');
    if (!isLocalDevUrl && !isPackagedAppUrl) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const devUrl = getStartUrl();
  const loadPromise = devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  loadPromise.catch((error) => dialog.showErrorBox('DocPilot 실행 오류', error.message));

  return mainWindow;
}

app.whenReady().then(() => {
  registerSettingsIpc();
  registerAiIpc();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
