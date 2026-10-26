import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BackendRuntime, invalid, isExternalDataDirectory, isPreviewRequest, isSummaryRequest, isReviewChange, isQAChange, isReviewCursor, isSaveMedia, isUUID, isModality, isPTS, isGateChange, isCountReviewInput, isCountQAInput, isCandidateDecision, isHeatmapMode, isAudioMode, isAudioAnchor, isAudioDerive, MAX_PREVIEW_BYTES, MAX_SUMMARY_BYTES } from './backend';
import { ExportSaver } from './export_saver';
import type { NewSession } from './contracts';

const UI_URL = 'app://bat/index.html';
/** The UI document, ignoring only the in-page route fragment (#/...) used by the renderer's hash router. */
const isUI = (url: string) => url === UI_URL || url.startsWith(`${UI_URL}#`);
const repoRoot = resolve(__dirname, '../..');
// A packaged build keeps the frozen backend and the built UI beside the executable, never in the checkout.
const installRoot = app.isPackaged ? dirname(process.execPath) : repoRoot;
const uiRoot = app.isPackaged ? join(process.resourcesPath, 'frontend') : join(repoRoot, 'frontend/dist');
const packagedBackend = join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'bat-backend.exe' : 'bat-backend');
const backend = new BackendRuntime();
let exportSaver: ExportSaver | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let draftDirty = false;
let discardApproved = false;

function confirmDiscard(force = false): boolean {
  if (!draftDirty && !force) return true;
  const options = {
    type: 'warning' as const,
    buttons: ['Keep editing', 'Discard draft'],
    defaultId: 0, cancelId: 0, noLink: true,
    title: 'Unsaved manual review',
    message: 'Discard the unsaved review draft?',
    detail: 'Changes have not been confirmed in this window. Keep editing to check and save them. Discarding a draft does not undo any action already recorded in the audit history.',
  };
  const response = window && !window.isDestroyed() ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options);
  if (response !== 1) return false;
  draftDirty = false;
  discardApproved = true;
  return true;
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Playback copies only: streamed with byte ranges so the player can seek (Phase 2 W1).
  { scheme: 'bat-media', privileges: { standard: true, secure: true, stream: true } },
]);

/** Packaged data stays on the local machine (not the roaming profile): reviews, derived images and Chromium state. */
function localData(): string | undefined {
  const local = process.env.LOCALAPPDATA;
  return app.isPackaged && process.platform === 'win32' && local && isAbsolute(local) ? join(local, 'Bat Innovation') : undefined;
}

// Trusted process configuration only. No renderer operation accepts a path.
const configuredData = process.env.BAT_APP_DATA_DIR;
let configError: string | undefined;
const packagedHome = configuredData === undefined ? localData() : undefined;
if (packagedHome !== undefined) {
  try {
    mkdirSync(join(packagedHome, 'shell'), { recursive: true });
    app.setPath('userData', join(packagedHome, 'shell'));
  } catch { configError = 'The application data directory is not writable.'; }
}
if (configuredData !== undefined) {
  if (!isExternalDataDirectory(installRoot, configuredData)) {
    configError = 'BAT_APP_DATA_DIR must be an absolute directory outside the installation or repository.';
  } else {
    try {
      const shellData = join(configuredData, 'shell');
      mkdirSync(shellData, { recursive: true });
      app.setPath('userData', shellData);
    } catch { configError = 'The application data directory is not writable.'; }
  }
}

function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isUI(event.senderFrame.url)) {
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
  if (app.isPackaged && !existsSync(packagedBackend)) {
    dialog.showErrorBox('Installation incomplete', 'The Bat Innovation backend is missing. Reinstall the application.');
    app.quit();
    return;
  }
  const dataDir = configuredData ?? join(localData() ?? app.getPath('userData'), 'data');
  exportSaver = new ExportSaver(backend, installRoot, dataDir);
  await exportSaver.recover();
  // Same fixed origin for development and eventual packaging. Serve only built UI assets.
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const asset = /^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(url.pathname);
    if (request.method !== 'GET' || url.host !== 'bat' || url.search || (url.pathname !== '/index.html' && !asset)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const content = readFileSync(join(uiRoot, url.pathname));
      return new Response(content, { headers: {
        'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src blob: bat-media:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response('Built UI missing. Run npm run build.', { status: 404 }); }
  });
  // bat-media://proxy/<id> serves one ready playback copy by ID; the renderer never names a path.
  protocol.handle('bat-media', (request) => {
    const url = new URL(request.url);
    const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
    if (request.method !== 'GET' || url.host !== 'proxy' || url.search || match === null) return new Response('Not found', { status: 404 });
    return backend.playbackVideo(match[1], request.headers.get('Range'));
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const previewBlob = ['media', 'image'].includes(details.resourceType) && /^blob:app:\/\/bat\/[0-9a-f-]+$/.test(details.url);
    const playback = details.resourceType === 'media' && /^bat-media:\/\/proxy\/[0-9a-f-]{36}$/.test(details.url);
    callback({ cancel: !details.url.startsWith('app://bat/') && !previewBlob && !playback });
  });
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1000, height: 760, minWidth: 640, minHeight: 500,
    title: 'Bat Innovation - source motion evidence',
    webPreferences: { preload: join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!isUI(url)) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame || !isUI(event.url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('close', event => { if (!confirmDiscard()) event.preventDefault(); });
  window.webContents.on('will-prevent-unload', event => {
    // Renderer beforeunload is a second guard if its dirty IPC is still queued.
    // Electron preventDefault here permits the explicitly approved unload.
    if (discardApproved || confirmDiscard(true)) {
      discardApproved = false;
      event.preventDefault();
    }
  });
  window.on('closed', () => { window = undefined; draftDirty = false; discardApproved = false; });
  handle('bat:start-export', 1, ([id]) => isUUID(id) && !draftDirty ? backend.startExport(id) : invalid('Save or discard unsaved drafts before export.'));
  handle('bat:export-status', 1, ([id]) => isUUID(id) ? backend.exportStatus(id) : invalid());
  handle('bat:cancel-export', 1, ([id]) => isUUID(id) ? backend.cancelExport(id) : invalid());
  handle('bat:save-export-bundle', 1, ([id]) => {
    if (!isUUID(id) || draftDirty || !exportSaver) return invalid('Save or discard unsaved drafts before export.');
    return exportSaver.save(id, async () => {
      const owner = window;
      if (!owner || owner.isDestroyed()) return null;
      const selected = await dialog.showOpenDialog(owner, { title: 'Save PROVISIONAL CSV bundle in a new folder', properties: ['openDirectory', 'createDirectory'] });
      return owner.isDestroyed() || selected.canceled || selected.filePaths.length !== 1 ? null : selected.filePaths[0];
    });
  });
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
  handle('bat:set-draft-dirty', 1, ([dirty]) => {
    if (typeof dirty !== 'boolean') return invalid('Use a boolean draft state.');
    draftDirty = dirty;
    if (dirty) discardApproved = false;
    return { ok: true, value: { dirty } };
  });
  handle('bat:upgrade-qa', 0, () => backend.upgradeQA());
  handle('bat:get-window-qa', 1, ([id]) => isUUID(id) ? backend.getWindowQA(id) : invalid());
  handle('bat:save-qa', 2, ([id, input]) => isUUID(id) && isQAChange(input) ? backend.saveQA(id, input) : invalid());
  handle('bat:qa-history', 2, ([id, cursor]) => isUUID(id) && isReviewCursor(cursor) ? backend.qaHistory(id, cursor) : invalid());
  handle('bat:upgrade-reviews', 0, () => backend.upgradeReviews());
  handle('bat:get-window-review', 1, ([id]) => isUUID(id) ? backend.getWindowReview(id) : invalid('Select a valid window ID.'));
  handle('bat:save-review', 2, ([id, input]) => isUUID(id) && isReviewChange(input) ? backend.saveReview(id, input) : invalid('Use only attributed manual review fields and a current revision.'));
  handle('bat:review-history', 2, ([id, cursor]) => isUUID(id) && isReviewCursor(cursor) ? backend.reviewHistory(id, cursor) : invalid('Select a valid window ID and history revision.'));
  handle('bat:upgrade-summaries', 0, () => backend.upgradeSummaries());
  handle('bat:list-summary-runs', 1, ([id]) => isUUID(id) ? backend.listSummaryRuns(id) : invalid('Select a valid session ID.'));
  handle('bat:start-summaries', 1, ([input]) => isSummaryRequest(input) ? backend.startSummaries(input) : invalid('Select a session ID and an integer window duration from 1 to 120 seconds.'));
  handle('bat:summary-run', 1, ([id]) => isUUID(id) ? backend.summaryRun(id) : invalid('Select a valid run ID.'));
  handle('bat:cancel-summaries', 1, ([id]) => isUUID(id) ? backend.cancelSummaries(id) : invalid('Select a valid run ID.'));
  handle('bat:summary-image', 1, async ([id]) => {
    if (!isUUID(id)) return invalid('Select a valid window ID.');
    const result = await backend.summaryImage(id);
    return result.ok && result.value.bytes.byteLength > MAX_SUMMARY_BYTES ? invalid('Summary image exceeds its byte limit.') : result;
  });
  handle('bat:upgrade-storage', 0, () => backend.upgradeStorage());
  handle('bat:list-gates', 1, ([id]) => isUUID(id) ? backend.listGates(id) : invalid('Select a valid survey ID.'));
  handle('bat:save-gate', 3, ([session, gate, change]) => isUUID(session) && (gate === null || isUUID(gate)) && isGateChange(change)
    ? backend.saveGate(session, gate, change) : invalid('Use a valid gate: name, kind, 2 to 32 points, labels, direction and hysteresis.'));
  handle('bat:get-counts', 2, ([run, gate]) => isUUID(run) && isUUID(gate) ? backend.getCounts(run, gate) : invalid());
  handle('bat:save-count-review', 3, ([run, gate, input]) => isUUID(run) && isUUID(gate) && isCountReviewInput(input) ? backend.saveCountReview(run, gate, input) : invalid('Use a valid count review action.'));
  handle('bat:save-count-qa', 3, ([run, gate, input]) => isUUID(run) && isUUID(gate) && isCountQAInput(input) ? backend.saveCountQA(run, gate, input) : invalid('Use a valid count QA action.'));
  handle('bat:list-audio', 1, ([id]) => isUUID(id) ? backend.listAudio(id) : invalid());
  handle('bat:set-audio-anchor', 2, ([id, input]) => isUUID(id) && isAudioAnchor(input) ? backend.setAudioAnchor(id, input) : invalid('Use a video frame and an audio sample inside both recordings.'));
  handle('bat:derive-audio', 2, ([id, input]) => isUUID(id) && isAudioDerive(input) ? backend.deriveAudio(id, input) : invalid('Use a 1 to 12 s span and a 10 to 150 kHz tuning.'));
  handle('bat:audio-content', 2, async ([id, kind]) => isUUID(id) && (kind === 'spectrogram' || kind === 'heterodyne') ? backend.audioContent(id, kind) : invalid());
  handle('bat:choose-audio', 3, async ([id, mode, channel]) => {
    if (!isUUID(id) || !isAudioMode(mode) || typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0 || channel > 7) return invalid('Choose a survey, a source mode and a channel.');
    const owner = window;
    if (!owner || owner.isDestroyed()) return invalid('The application window is closed.');
    const selected = await dialog.showOpenDialog(owner, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Full-spectrum WAV', extensions: ['wav'] }] }).catch(() => null);
    if (!selected) return { ok: false, error: { code: 'picker_failed', message: 'The native file picker could not open. Check desktop permissions and reopen the app.' } };
    if (selected.canceled || selected.filePaths.length === 0) return { ok: true, value: null };
    return backend.addSelectedAudio(id, selected.filePaths, mode, channel);
  });
  handle('bat:get-heatmap', 3, ([run, segment, mode]) => isUUID(run) && isUUID(segment) && isHeatmapMode(mode) ? backend.getHeatmap(run, segment, mode) : invalid());
  handle('bat:list-candidates', 1, ([id]) => isUUID(id) ? backend.listCandidates(id) : invalid());
  handle('bat:decide-candidate', 3, ([run, track, input]) => isUUID(run) && isUUID(track) && isCandidateDecision(input) ? backend.decideCandidate(run, track, input) : invalid('Use a valid candidate decision.'));
  handle('bat:start-playback', 1, ([id]) => isUUID(id) ? backend.startPlayback(id) : invalid('Select a valid survey.'));
  handle('bat:playback-status', 1, ([id]) => isUUID(id) ? backend.playbackStatus(id) : invalid('Select a valid survey.'));
  handle('bat:cancel-playback', 1, ([id]) => isUUID(id) ? backend.cancelPlayback(id) : invalid('Select a valid survey.'));
  handle('bat:playback-frames', 1, ([id]) => isUUID(id) ? backend.playbackFrames(id) : invalid('Select a valid playback copy.'));
  handle('bat:start-tracking', 1, ([id]) => isUUID(id) ? backend.startTracking(id) : invalid('Select a valid summary run ID.'));
  handle('bat:tracking-run', 1, ([id]) => isUUID(id) ? backend.trackingRun(id) : invalid('Select a valid tracking run ID.'));
  handle('bat:list-tracking', 1, ([id]) => isUUID(id) ? backend.listTracking(id) : invalid('Select a valid summary run ID.'));
  handle('bat:cancel-tracking', 1, ([id]) => isUUID(id) ? backend.cancelTracking(id) : invalid('Select a valid tracking run ID.'));
  handle('bat:get-tracks', 4, ([run, segment, start, end]) => isUUID(run) && isUUID(segment) && isPTS(start) && (end === null || isPTS(end))
    ? backend.getTracks(run, segment, start, end) : invalid('Use a tracking run, segment and integer source PTS range.'));
  handle('bat:choose-media', 2, async ([id, modality]) => {
    if (!isUUID(id)) return invalid('Select a valid session ID.');
    if (!isModality(modality)) return invalid('Choose active IR or rendered thermal.');
    const media = await backend.getMedia(id);
    if (!media.ok) return media;
    if (media.value.schema_version < 2) return { ok: false, error: { code: 'schema_upgrade_required', message: 'Use Upgrade media storage before choosing original videos.' } };
    const owner = window;
    if (!owner || owner.isDestroyed()) return invalid('The application window is closed.');
    const selected = await dialog.showOpenDialog(owner, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video originals', extensions: ['mts', 'mp4'] }],
    }).catch(() => null);
    if (!selected) return { ok: false, error: { code: 'picker_failed', message: 'The native file picker could not open. Check desktop permissions and reopen the app.' } };
    if (selected.canceled || selected.filePaths.length === 0) return { ok: true, value: null };
    // Raw native selections remain in this trusted closure and the authenticated local backend.
    return backend.importSelectedMedia(id, selected.filePaths, modality);
  });
  void backend.start({
    repoRoot: installRoot, dataDir, ...(app.isPackaged ? { packaged: packagedBackend } : { python: process.env.BAT_PYTHON ?? 'python' }),
    port: process.env.BAT_API_PORT === undefined ? undefined : Number(process.env.BAT_API_PORT),
  });
  await window.loadURL(UI_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(open).catch(() => {
    dialog.showErrorBox('Startup failed', 'Bat Innovation could not load. Check that the local data directory is writable, then restart. A development checkout needs npm run build first.');
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  // Close/unload confirmation must finish before backend shutdown. If the
  // renderer blocks closing, its draft and the running backend stay available.
  if (window && !window.isDestroyed()) { window.close(); return; }
  quitting = true;
  void (async () => { await exportSaver?.close(); await backend.stop(); app.quit(); })();
});
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
