import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { chatWithGemini } from './geminiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDevUrl = 'http://localhost:5173';
const defaultGeminiModel = 'gemini-3.1-flash-lite';
const appProtocol = 'docpilot';

// PDF.js loads its worker, CMaps and standard fonts separately. A file://
// renderer gives these resources an opaque origin in Chromium, which lets a
// document load but can fail while rendering its first page. Use a privileged
// same-origin application protocol for the packaged build instead.
protocol.registerSchemesAsPrivileged([{
  scheme: appProtocol,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true
  }
}]);

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

const localFontCache = new Map();

function normalizeFontName(value = '') {
  return String(value)
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/\b(?:regular|normal|roman)\b/gi, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLocaleLowerCase();
}

function getWindowsFontDirectories() {
  const directories = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')];
  if (process.env.LOCALAPPDATA) {
    directories.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  }
  return directories.filter((directory) => existsSync(directory));
}

function getKoreanFontDisplayName(font) {
  const records = font?.name?.records || {};
  const recordNames = ['fullName', 'typographicFamily', 'fontFamily'];
  for (const recordName of recordNames) {
    const record = records[recordName];
    if (!record || typeof record !== 'object') continue;
    const koreanName = record.ko || record['ko-KR'] || record['ko_KR'];
    if (typeof koreanName === 'string' && koreanName.trim()) return koreanName.trim();
  }
  return '';
}

function getLocalFontEntries() {
  if (localFontCache.size) return [...localFontCache.values()];
  getWindowsFontDirectories().forEach((directory) => {
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ttf|otf)$/i.test(entry.name))
      .forEach((entry) => {
        const filePath = path.join(directory, entry.name);
        try {
          const font = fontkit.create(readFileSync(filePath));
          const names = [font.familyName, font.fullName, font.postscriptName, entry.name.replace(/\.(ttf|otf)$/i, '')]
            .filter(Boolean);
          const normalizedNames = names.map(normalizeFontName).filter(Boolean);
          if (!normalizedNames.length) return;
          const item = {
            filePath,
            names,
            normalizedNames,
            koreanDisplayName: getKoreanFontDisplayName(font)
          };
          localFontCache.set(filePath, item);
        } catch {
          // Unsupported or protected font files are ignored; a bundled font
          // remains available as the deterministic fallback.
        }
      });
  });
  return [...localFontCache.values()];
}

function isBoldFontEntry(entry) {
  return entry.normalizedNames.some((name) => /(bold|black|heavy|semibold|demibold|extrabold|ultrabold)/i.test(name));
}

function findLocalFont(fontFamilies = [], preferBold = false) {
  const requested = [...new Set((Array.isArray(fontFamilies) ? fontFamilies : [fontFamilies])
    .map(normalizeFontName).filter(Boolean))];
  if (!requested.length) return null;
  const match = getLocalFontEntries().map((entry) => ({
    entry,
    // Candidates are ordered deliberately: a font chosen in the editor must
    // win over the original PDF font retained as a fallback.  Previously two
    // exact matches received the same score, so filesystem enumeration could
    // silently embed HCRDotum instead of the font selected in the toolbar.
    score: Math.max(...requested.map((name, index) => {
      const nameScore = Math.max(...entry.normalizedNames.map((candidate) => (
        candidate === name ? 100 : candidate.includes(name) || name.includes(candidate) ? 50 : 0
      )));
      if (!nameScore) return 0;
      // The candidate order takes precedence; bold is only a tie breaker for
      // different files matching the same requested candidate.
      return (nameScore * 10000) - (index * 100) + (preferBold ? (isBoldFontEntry(entry) ? 10 : -10) : 0);
    }))
  })).filter((candidate) => candidate.score > 0).sort((first, second) => second.score - first.score)[0];
  return match?.entry || null;
}

function registerFontIpc() {
  ipcMain.handle('docpilot-fonts:resolve', (_event, request = []) => {
    const fontFamilies = Array.isArray(request) ? request : request?.candidates;
    const localFont = findLocalFont(fontFamilies, request?.preferBold === true);
    if (!localFont) return { found: false };
    return {
      found: true,
      family: localFont.names[0] || '',
      fullName: localFont.names[1] || localFont.names[0] || '',
      base64: readFileSync(localFont.filePath).toString('base64')
    };
  });
  ipcMain.handle('docpilot-fonts:list', () => {
    const fonts = new Map();
    getLocalFontEntries().forEach((entry) => {
      const family = entry.names[0] || '';
      const fullName = entry.names[1] || family;
      const candidate = fullName || family;
      if (!candidate || fonts.has(candidate)) return;
      fonts.set(candidate, {
        candidate,
        family,
        // Windows font files often carry both English and Korean name table
        // records. Keep the English full name as the resolver key, while the
        // selector shows the Korean name whenever the font provides one.
        label: entry.koreanDisplayName || fullName || family
      });
    });
    return [...fonts.values()]
      .sort((first, second) => first.label.localeCompare(second.label, 'ko'))
      .slice(0, 1000);
  });
}

function registerAppProtocol() {
  const distDirectory = path.resolve(__dirname, '..', 'dist');
  const distPrefix = `${distDirectory}${path.sep}`;

  protocol.handle(appProtocol, (request) => {
    const requestUrl = new URL(request.url);
    const relativePath = decodeURIComponent(requestUrl.pathname)
      .replace(/^[/\\]+/, '') || 'index.html';
    const requestedFile = path.resolve(distDirectory, relativePath);

    if (requestedFile !== distDirectory && !requestedFile.startsWith(distPrefix)) {
      return new Response('Not found', { status: 404 });
    }

    return net.fetch(pathToFileURL(requestedFile).toString());
  });
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
  // The packaged app uses the in-app toolbar. Hide Electron's default
  // File/Edit/View menu strip so the document workspace starts at the top.
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const isLocalDevUrl = navigationUrl.startsWith(defaultDevUrl);
    const isPackagedAppUrl = navigationUrl.startsWith(`${appProtocol}://`);
    if (!isLocalDevUrl && !isPackagedAppUrl) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const devUrl = getStartUrl();
  const loadPromise = devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadURL(`${appProtocol}://app/index.html`);
  loadPromise.catch((error) => {
    console.error('DocPilot window load failed:', error);
    dialog.showErrorBox('DocPilot 실행 오류', error.message);
  });

  return mainWindow;
}

app.whenReady().then(() => {
  registerAppProtocol();
  registerSettingsIpc();
  registerAiIpc();
  registerFontIpc();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
