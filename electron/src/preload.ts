import { contextBridge, ipcRenderer } from 'electron';
import type { BatAPI, NewSession, PreviewRequest, SaveMedia, SummaryRequest } from './contracts';

const api: BatAPI = {
  upgradeSummaries: (...args: []) => ipcRenderer.invoke('bat:upgrade-summaries', ...args),
  listSummaryRuns: (...args: [string]) => ipcRenderer.invoke('bat:list-summary-runs', ...args),
  startSummaries: (...args: [SummaryRequest]) => ipcRenderer.invoke('bat:start-summaries', ...args),
  summaryRun: (...args: [string]) => ipcRenderer.invoke('bat:summary-run', ...args),
  cancelSummaries: (...args: [string]) => ipcRenderer.invoke('bat:cancel-summaries', ...args),
  summaryImage: (...args: [string]) => ipcRenderer.invoke('bat:summary-image', ...args),
  health: (...args: []) => ipcRenderer.invoke('bat:health', ...args),
  listSessions: (...args: []) => ipcRenderer.invoke('bat:list-sessions', ...args),
  createSession: (...args: [NewSession]) => ipcRenderer.invoke('bat:create-session', ...args),
  getMedia: (...args: [string]) => ipcRenderer.invoke('bat:get-media', ...args),
  upgradeMedia: (...args: []) => ipcRenderer.invoke('bat:upgrade-media', ...args),
  chooseMedia: (...args: [string]) => ipcRenderer.invoke('bat:choose-media', ...args),
  importStatus: (...args: [string]) => ipcRenderer.invoke('bat:import-status', ...args),
  cancelImport: (...args: [string]) => ipcRenderer.invoke('bat:cancel-import', ...args),
  saveMedia: (...args: [string, SaveMedia]) => ipcRenderer.invoke('bat:save-media', ...args),
  startPreview: (...args: [PreviewRequest]) => ipcRenderer.invoke('bat:start-preview', ...args),
  previewStatus: (...args: [string]) => ipcRenderer.invoke('bat:preview-status', ...args),
  cancelPreview: (...args: [string]) => ipcRenderer.invoke('bat:cancel-preview', ...args),
  previewContent: (...args: [string]) => ipcRenderer.invoke('bat:preview-content', ...args),
};
contextBridge.exposeInMainWorld('batAPI', api);
