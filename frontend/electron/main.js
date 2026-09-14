import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDevUrl = 'http://localhost:5173';
const backendHost = '127.0.0.1';
const defaultBackendPort = 8080;
const healthTimeoutMs = 30_000;
const healthRetryMs = 750;
const defaultOpenAiModel = 'gpt-5-mini';

let backendProcess = null;
let backendWasStartedByElectron = false;
let backendProcessError = null;
let isQuitting = false;

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readLocalSettings() {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return {
      openAiApiKey: typeof parsed.openAiApiKey === 'string' ? parsed.openAiApiKey.trim() : '',
      openAiModel: typeof parsed.openAiModel === 'string' && parsed.openAiModel.trim()
        ? parsed.openAiModel.trim()
        : defaultOpenAiModel
    };
  } catch (error) {
    console.error(`OpenAI settings could not be read: ${error.message}`);
    return {};
  }
}

function maskApiKey(apiKey = '') {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '••••••••';
  return `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}`;
}

function getOpenAiStatus() {
  const settings = readLocalSettings();
  const resolvedApiKey = process.env.OPENAI_API_KEY || settings.openAiApiKey;
  const resolvedModel = process.env.OPENAI_MODEL || settings.openAiModel || defaultOpenAiModel;
  return {
    hasApiKey: Boolean(resolvedApiKey),
    maskedApiKey: maskApiKey(resolvedApiKey),
    model: resolvedModel
  };
}

function saveOpenAiSettings(input = {}) {
  const current = readLocalSettings();
  const nextApiKey = typeof input.openAiApiKey === 'string' && input.openAiApiKey.trim()
    ? input.openAiApiKey.trim()
    : current.openAiApiKey || '';
  const nextModel = typeof input.openAiModel === 'string' && input.openAiModel.trim()
    ? input.openAiModel.trim()
    : defaultOpenAiModel;
  const settingsPath = getSettingsPath();

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ openAiApiKey: nextApiKey, openAiModel: nextModel }, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
  return getOpenAiStatus();
}

function clearOpenAiSettings() {
  const settingsPath = getSettingsPath();
  if (existsSync(settingsPath)) unlinkSync(settingsPath);
  return getOpenAiStatus();
}

function registerSettingsIpc() {
  ipcMain.handle('openai-settings:get', () => getOpenAiStatus());
  ipcMain.handle('openai-settings:status', () => getOpenAiStatus());
  ipcMain.handle('openai-settings:set', (_event, settings) => saveOpenAiSettings(settings));
  ipcMain.handle('openai-settings:clear', () => clearOpenAiSettings());
}

function getBackendPort() {
  const configuredPort = Number.parseInt(process.env.DOC_PILOT_BACKEND_PORT || '', 10);
  return Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536
    ? configuredPort
    : defaultBackendPort;
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

function shouldAutoStartBackend() {
  const configured = process.env.DOC_PILOT_BACKEND_AUTO_START;
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return !getStartUrl();
}

function getBackendJarPath() {
  const configuredJar = process.env.DOC_PILOT_BACKEND_JAR;
  if (configuredJar) {
    const resolvedJar = path.resolve(configuredJar);
    if (existsSync(resolvedJar)) return resolvedJar;
    throw new Error(`지정된 백엔드 jar를 찾을 수 없습니다: ${resolvedJar}`);
  }

  const targetDirectories = [
    path.join(process.resourcesPath, 'backend'),
    path.resolve(__dirname, '../../target'),
    path.resolve(process.cwd(), '../target')
  ];

  for (const directory of targetDirectories) {
    if (!existsSync(directory)) continue;

    const jarNames = readdirSync(directory)
      .filter((name) => name.endsWith('.jar') && !name.startsWith('original-'))
      .sort((left, right) => {
        if (left === 'backend.jar') return -1;
        if (right === 'backend.jar') return 1;
        return left.localeCompare(right);
      });

    if (jarNames.length > 0) return path.join(directory, jarNames[0]);
  }

  throw new Error(
    'Spring Boot 백엔드 jar를 찾을 수 없습니다. 먼저 mvn clean package를 실행하거나 DOC_PILOT_BACKEND_JAR를 지정해 주세요.'
  );
}

function resolveJavaExecutable() {
  const configuredJava = process.env.DOC_PILOT_JAVA_PATH;
  if (configuredJava) {
    if (!existsSync(configuredJava)) {
      throw new Error(`지정된 Java 실행 파일을 찾을 수 없습니다: ${configuredJava}`);
    }
    return configuredJava;
  }

  const bundledJavaName = process.platform === 'win32' ? 'java.exe' : 'java';
  const bundledJava = path.join(process.resourcesPath, 'jre', 'bin', bundledJavaName);
  if (existsSync(bundledJava)) return bundledJava;

  // Development fallback. In a packaged app, a bundled JRE is preferred.
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function checkBackendHealth(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: backendHost, port, path: '/api/health', timeout: 1_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 300);
      }
    );
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend(port, timeoutMs = healthTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backendProcessError) {
      throw new Error(`Java 백엔드를 실행할 수 없습니다: ${backendProcessError.message}`);
    }
    if (await checkBackendHealth(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, healthRetryMs));
  }
  return false;
}

function startBackend(port) {
  const jarPath = getBackendJarPath();
  const javaExecutable = resolveJavaExecutable();
  const localSettings = readLocalSettings();
  const backendEnv = { ...process.env };
  if (!backendEnv.OPENAI_API_KEY && localSettings.openAiApiKey) {
    backendEnv.OPENAI_API_KEY = localSettings.openAiApiKey;
  }
  if (!backendEnv.OPENAI_MODEL && localSettings.openAiModel) {
    backendEnv.OPENAI_MODEL = localSettings.openAiModel;
  }
  backendProcessError = null;
  console.log('Starting DocPilot backend process');

  const child = spawn(javaExecutable, ['-jar', jarPath, `--server.port=${port}`], {
    cwd: path.dirname(jarPath),
    env: backendEnv,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => console.log(`[backend] ${data.toString().trimEnd()}`));
  child.stderr.on('data', (data) => console.error(`[backend] ${data.toString().trimEnd()}`));
  child.once('error', (error) => {
    backendProcessError = error;
    console.error(`Backend process error: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    if (!isQuitting && code !== 0) {
      console.error(`Backend stopped unexpectedly (code=${code}, signal=${signal})`);
    }
  });

  backendProcess = child;
  backendWasStartedByElectron = true;
}

async function prepareBackendProcess() {
  if (!shouldAutoStartBackend()) return;

  const port = getBackendPort();
  if (await checkBackendHealth(port)) {
    console.log(`Reusing the existing backend on port ${port}`);
    return;
  }

  startBackend(port);
  if (!(await waitForBackend(port))) {
    stopBackendProcess();
    throw new Error(
      `백엔드 서버를 시작하지 못했습니다. ${port} 포트가 이미 사용 중이거나 Java 실행 환경이 없을 수 있습니다.`
    );
  }
}

function stopBackendProcess() {
  if (!backendProcess || !backendWasStartedByElectron) return;

  const processToStop = backendProcess;
  backendProcess = null;
  backendWasStartedByElectron = false;

  if (process.platform === 'win32' && processToStop.pid) {
    spawn('taskkill', ['/pid', String(processToStop.pid), '/t', '/f'], { shell: false });
  } else {
    processToStop.kill();
  }
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

async function startApplication() {
  try {
    await prepareBackendProcess();
    createMainWindow();
  } catch (error) {
    dialog.showErrorBox('DocPilot 백엔드 오류', error.message);
    app.quit();
  }
}

app.whenReady().then(() => {
  registerSettingsIpc();
  startApplication();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) startApplication();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackendProcess();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.once('exit', stopBackendProcess);
