import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BackendRuntime, isExternalDataDirectory } from './backend';
import type { NewSession } from './contracts';

const UI_URL = 'app://bat/index.html';
const repoRoot = resolve(__dirname, '../..');
const backend = new BackendRuntime();
let window: BrowserWindow | undefined;
let quitting = false;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// Trusted process configuration only. No renderer operation accepts a path.
const configuredData = process.env.BAT_APP_DATA_DIR;
let configError: string | undefined;
if (configuredData !== undefined) {
  if (!isExternalDataDirectory(repoRoot, configuredData)) {
    configError = 'BAT_APP_DATA_DIR must be an absolute directory outside the repository.';
  } else {
    try {
      const shellData = join(configuredData, 'shell');
      mkdirSync(shellData, { recursive: true });
      app.setPath('userData', shellData);
    } catch { configError = 'The application data directory is not writable.'; }
  }
}

function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== UI_URL) {
    throw new Error('IPC is restricted to the application main frame.');
  }
}

async function open(): Promise<void> {
  if (configError) {
    dialog.showErrorBox('Invalid application configuration', configError);
    app.quit();
    return;
  }
  if (app.isPackaged) {
    dialog.showErrorBox('Development shell only', 'A packaged Python runtime is not configured. Windows installer work belongs to Slice 5.');
    app.quit();
    return;
  }
  const dataDir = configuredData ?? join(app.getPath('userData'), 'data');
  // Same fixed origin for development and eventual packaging. Serve only built UI assets.
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const asset = /^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(url.pathname);
    if (request.method !== 'GET' || url.host !== 'bat' || url.search || (url.pathname !== '/index.html' && !asset)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const content = readFileSync(join(repoRoot, 'frontend/dist', url.pathname));
      return new Response(content, { headers: {
        'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response('Built UI missing. Run npm run build.', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('app://bat/') });
  });
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1000, height: 760, minWidth: 640, minHeight: 500,
    title: 'Bat Innovation - foundation',
    webPreferences: { preload: join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== UI_URL) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame || event.url !== UI_URL) event.preventDefault(); });
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => { window = undefined; });
  ipcMain.handle('bat:health', (event) => { trusted(event); return backend.health(); });
  ipcMain.handle('bat:list-sessions', (event) => { trusted(event); return backend.listSessions(); });
  ipcMain.handle('bat:create-session', (event, input: NewSession) => { trusted(event); return backend.createSession(input); });
  void backend.start({
    repoRoot, dataDir, python: process.env.BAT_PYTHON ?? 'python',
    port: process.env.BAT_API_PORT === undefined ? undefined : Number(process.env.BAT_API_PORT),
  });
  await window.loadURL(UI_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(open).catch(() => {
    dialog.showErrorBox('Startup failed', 'The development shell could not load. Run npm run build and check the local data directory.');
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void backend.stop().then(() => app.quit());
});
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
