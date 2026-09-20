import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatWithGemini } from './geminiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDevUrl = 'http://localhost:5173';
const backendHost = '127.0.0.1';
const defaultBackendPort = 8080;
const healthTimeoutMs = 30_000;
const healthRetryMs = 750;
const defaultGeminiModel = 'gemini-3.1-flash-lite';

let backendProcess = null;
let backendWasStartedByElectron = false;
let backendProcessError = null;
let backendProcessExit = null;
let backendOutput = '';
let isQuitting = false;

class BackendStartupError extends Error {
  constructor(code, userMessage, details = {}) {
    super(userMessage);
    this.name = 'BackendStartupError';
    this.code = code;
    this.userMessage = userMessage;
    this.details = details;
  }
}

function getResourcesPath() {
  return process.resourcesPath || path.resolve(__dirname, '..');
}

function getStartupLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'backend-startup.log');
}

function redactLogValue(value) {
  return String(value ?? '')
    .replace(/(GEMINI_API_KEY|OPENAI_API_KEY|Authorization|Bearer|x-goog-api-key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(?:AIza|sk-)[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]');
}

function appendStartupLog(event, details = {}) {
  try {
    const logPath = getStartupLogPath();
    mkdirSync(path.dirname(logPath), { recursive: true });
    const safeDetails = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [key, redactLogValue(value)])
    );
    appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...safeDetails })}\n`, 'utf8');
  } catch (error) {
    console.error(`Could not write backend startup log: ${error.message}`);
  }
}

function getBackendError(code, details = {}) {
  const messages = {
    JAVA_NOT_FOUND: '내장 Java 실행 파일을 찾을 수 없습니다. resources/jre/bin/java.exe 포함 여부를 확인하세요.',
    JAR_NOT_FOUND: '백엔드 jar 파일을 찾을 수 없습니다. resources/backend 폴더를 확인하세요.',
    PORT_IN_USE: `${getBackendPort()} 포트가 이미 다른 프로그램에서 사용 중입니다.`,
    HEALTH_TIMEOUT: '백엔드 서버가 시작되었지만 /api/health 응답을 받지 못했습니다.',
    PROCESS_EXITED: '백엔드 프로세스가 시작 직후 종료되었습니다. 로그 파일을 확인하세요.',
    UNKNOWN: '백엔드 서버 시작 중 알 수 없는 오류가 발생했습니다. 로그 파일을 확인하세요.'
  };
  return new BackendStartupError(code, messages[code] || messages.UNKNOWN, details);
}

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
  return process.env.DOC_PILOT_BACKEND_MODE === 'legacy';
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

function getBackendJarPath() {
  const configuredJar = process.env.DOC_PILOT_BACKEND_JAR;
  if (configuredJar) {
    const resolvedJar = path.resolve(configuredJar);
    if (existsSync(resolvedJar)) return resolvedJar;
    throw getBackendError('JAR_NOT_FOUND', { configuredJar: resolvedJar });
  }

  const targetDirectories = [
    path.join(getResourcesPath(), 'backend'),
    path.resolve(__dirname, '../../target'),
    path.resolve(process.cwd(), '../target')
  ];

  appendStartupLog('backend_jar_search', {
    appIsPackaged: app.isPackaged,
    resourcesPath: getResourcesPath(),
    candidates: targetDirectories.join('|')
  });

  for (const directory of targetDirectories) {
    if (!existsSync(directory)) continue;

    const jarNames = readdirSync(directory)
      .filter((name) => name.endsWith('.jar') && !name.startsWith('original-'))
      .sort((left, right) => {
        if (left === 'backend.jar') return -1;
        if (right === 'backend.jar') return 1;
        return left.localeCompare(right);
      });

    if (jarNames.length > 0) {
      const selectedJar = path.join(directory, jarNames[0]);
      appendStartupLog('backend_jar_selected', { backendJar: selectedJar });
      return selectedJar;
    }
  }

  throw getBackendError('JAR_NOT_FOUND', { candidates: targetDirectories.join('|') });
}

function resolveJavaExecutable() {
  const configuredJava = process.env.DOC_PILOT_JAVA_PATH;
  if (configuredJava) {
    if (!existsSync(configuredJava)) {
      throw getBackendError('JAVA_NOT_FOUND', { configuredJava });
    }
    appendStartupLog('java_selected', { source: 'DOC_PILOT_JAVA_PATH', javaPath: configuredJava });
    return configuredJava;
  }

  const bundledJavaName = process.platform === 'win32' ? 'java.exe' : 'java';
  const bundledJava = path.join(getResourcesPath(), 'jre', 'bin', bundledJavaName);
  if (existsSync(bundledJava)) {
    appendStartupLog('java_selected', { source: 'bundled-jre', javaPath: bundledJava });
    return bundledJava;
  }

  // Development fallback. Packaged apps must contain the bundled JRE.
  if (app.isPackaged) {
    throw getBackendError('JAVA_NOT_FOUND', { expectedPath: bundledJava });
  }

  const systemJava = process.platform === 'win32' ? 'java.exe' : 'java';
  appendStartupLog('java_selected', { source: 'system-java-development-fallback', javaPath: systemJava });
  return systemJava;
}

function probeBackend(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: backendHost, port, path: '/api/health', timeout: 1_000 },
      (response) => {
        response.resume();
        resolve({
          status: response.statusCode >= 200 && response.statusCode < 300 ? 'healthy' : 'occupied',
          statusCode: response.statusCode
        });
      }
    );
    request.on('error', (error) => resolve({
      status: ['ECONNREFUSED', 'ENOTFOUND'].includes(error.code) ? 'unavailable' : 'occupied',
      errorCode: error.code
    }));
    request.on('timeout', () => {
      request.destroy();
      resolve({ status: 'occupied', errorCode: 'ETIMEDOUT' });
    });
  });
}

async function waitForBackend(port, timeoutMs = healthTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backendProcessError) {
      if (backendProcessError.code === 'ENOENT') throw getBackendError('JAVA_NOT_FOUND');
      throw getBackendError('UNKNOWN', { spawnError: backendProcessError.message });
    }
    if (backendProcessExit) {
      throw getBackendError('PROCESS_EXITED', {
        exitCode: backendProcessExit.code,
        signal: backendProcessExit.signal,
        stderr: backendOutput
      });
    }
    const probe = await probeBackend(port);
    if (probe.status === 'healthy') return true;
    if (probe.status === 'occupied') throw getBackendError('PORT_IN_USE', { statusCode: probe.statusCode });
    await new Promise((resolve) => setTimeout(resolve, healthRetryMs));
  }
  throw getBackendError('HEALTH_TIMEOUT', { stderr: backendOutput });
}

function startBackend(port) {
  const jarPath = getBackendJarPath();
  const javaExecutable = resolveJavaExecutable();
  const localSettings = readLocalSettings();
  const backendEnv = { ...process.env };
  if (!backendEnv.GEMINI_API_KEY && localSettings.geminiApiKey) {
    backendEnv.GEMINI_API_KEY = localSettings.geminiApiKey;
  }
  if (!backendEnv.GEMINI_MODEL && localSettings.geminiModel) {
    backendEnv.GEMINI_MODEL = localSettings.geminiModel;
  }
  backendProcessError = null;
  backendProcessExit = null;
  backendOutput = '';
  appendStartupLog('backend_spawn', {
    javaPath: javaExecutable,
    backendJar: jarPath,
    port,
    appIsPackaged: app.isPackaged,
    resourcesPath: getResourcesPath()
  });
  console.log('Starting DocPilot backend process');

  const child = spawn(javaExecutable, ['-jar', jarPath, `--server.port=${port}`], {
    cwd: path.dirname(jarPath),
    env: backendEnv,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const captureBackendOutput = (stream, level) => {
    stream.on('data', (data) => {
      const safeOutput = redactLogValue(data.toString());
      const remaining = Math.max(0, 4_000 - backendOutput.length);
      const limitedOutput = safeOutput.slice(0, remaining);
      if (!limitedOutput) return;
      backendOutput += limitedOutput;
      appendStartupLog(`backend_${level}`, { output: limitedOutput.slice(0, 1_000) });
    });
  };
  captureBackendOutput(child.stdout, 'stdout');
  captureBackendOutput(child.stderr, 'stderr');
  child.once('error', (error) => {
    backendProcessError = error;
    appendStartupLog('backend_spawn_error', { code: error.code, message: error.message });
  });
  child.once('exit', (code, signal) => {
    backendProcessExit = { code, signal };
    appendStartupLog('backend_exit', { code, signal, stderr: backendOutput });
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
  appendStartupLog('backend_startup_begin', {
    port,
    appIsPackaged: app.isPackaged,
    resourcesPath: getResourcesPath()
  });
  const initialProbe = await probeBackend(port);
  if (initialProbe.status === 'healthy') {
    appendStartupLog('backend_reused', { port, statusCode: initialProbe.statusCode });
    console.log(`Reusing the existing backend on port ${port}`);
    return;
  }
  if (initialProbe.status === 'occupied') {
    appendStartupLog('backend_port_in_use', { port, statusCode: initialProbe.statusCode });
    throw getBackendError('PORT_IN_USE', { statusCode: initialProbe.statusCode });
  }

  try {
    startBackend(port);
  } catch (error) {
    appendStartupLog('backend_prepare_failed', {
      code: error.code || 'UNKNOWN',
      message: error.userMessage || error.message,
      details: error.details
    });
    throw error;
  }
  try {
    await waitForBackend(port);
    appendStartupLog('backend_health_ok', { port });
  } catch (error) {
    appendStartupLog('backend_startup_failed', {
      code: error.code,
      message: error.userMessage || error.message,
      details: error.details
    });
    stopBackendProcess();
    throw error;
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
    const message = error.userMessage || getBackendError('UNKNOWN').userMessage;
    appendStartupLog('application_start_failed', { code: error.code || 'UNKNOWN', message });
    dialog.showErrorBox('DocPilot 백엔드 오류', `${message}\n\n로그 파일:\n${getStartupLogPath()}`);
    app.quit();
  }
}

app.whenReady().then(() => {
  registerSettingsIpc();
  registerAiIpc();
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
