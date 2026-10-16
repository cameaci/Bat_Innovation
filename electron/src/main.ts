import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BackendRuntime, invalid, isExternalDataDirectory, isPreviewRequest, isSaveMedia, isUUID, MAX_PREVIEW_BYTES } from './backend';
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

function handle(channel: string, argumentCount: number, action: (args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    trusted(event);
    return args.length === argumentCount ? action(args) : invalid('Unexpected application arguments.');
  });
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
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response('Built UI missing. Run npm run build.', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const previewBlob = details.resourceType === 'media' && /^blob:app:\/\/bat\/[0-9a-f-]+$/.test(details.url);
    callback({ cancel: !details.url.startsWith('app://bat/') && !previewBlob });
  });
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1000, height: 760, minWidth: 640, minHeight: 500,
    title: 'Bat Innovation - original media inspection',
    webPreferences: { preload: join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== UI_URL) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame || event.url !== UI_URL) event.preventDefault(); });
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('closed', () => { window = undefined; });
  handle('bat:health', 0, () => backend.health());
  handle('bat:list-sessions', 0, () => backend.listSessions());
  handle('bat:create-session', 1, ([input]) => backend.createSession(input as NewSession));
  handle('bat:get-media', 1, ([id]) => isUUID(id) ? backend.getMedia(id) : invalid('Select a valid session ID.'));
  handle('bat:upgrade-media', 0, () => backend.upgradeMedia());
  handle('bat:import-status', 1, ([id]) => isUUID(id) ? backend.importStatus(id) : invalid('Select a valid import ID.'));
  handle('bat:cancel-import', 1, ([id]) => isUUID(id) ? backend.cancelImport(id) : invalid('Select a valid import ID.'));
  handle('bat:save-media', 2, ([id, input]) => isUUID(id) && isSaveMedia(input) ? backend.saveMedia(id, input) : invalid('Use only selected segment IDs, continuity evidence and an optional UTC clock anchor.'));
  handle('bat:start-preview', 1, ([input]) => isPreviewRequest(input) ? backend.startPreview(input) : invalid('Select a segment ID and an integer source PTS only.'));
  handle('bat:preview-status', 1, ([id]) => isUUID(id) ? backend.previewStatus(id) : invalid('Select a valid preview ID.'));
  handle('bat:cancel-preview', 1, ([id]) => isUUID(id) ? backend.cancelPreview(id) : invalid('Select a valid preview ID.'));
  handle('bat:preview-content', 1, async ([id]) => {
    if (!isUUID(id)) return invalid('Select a valid preview ID.');
    const result = await backend.previewContent(id);
    return result.ok && result.value.bytes.byteLength > MAX_PREVIEW_BYTES ? invalid('Preview content exceeds its byte limit.') : result;
  });
  handle('bat:choose-media', 1, async ([id]) => {
    if (!isUUID(id)) return invalid('Select a valid session ID.');
    const media = await backend.getMedia(id);
    if (!media.ok) return media;
    if (media.value.schema_version !== 2) return { ok: false, error: { code: 'schema_upgrade_required', message: 'Use Upgrade media storage before choosing original videos.' } };
    const owner = window;
    if (!owner || owner.isDestroyed()) return invalid('The application window is closed.');
    const selected = await dialog.showOpenDialog(owner, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video originals', extensions: ['mts', 'mp4'] }],
    }).catch(() => null);
    if (!selected) return { ok: false, error: { code: 'picker_failed', message: 'The native file picker could not open. Check desktop permissions and reopen the app.' } };
    if (selected.canceled || selected.filePaths.length === 0) return { ok: true, value: null };
    // Raw native selections remain in this trusted closure and the authenticated local backend.
    return backend.importSelectedMedia(id, selected.filePaths);
  });
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
