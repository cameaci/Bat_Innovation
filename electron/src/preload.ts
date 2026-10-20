import { contextBridge, ipcRenderer } from 'electron';
import type { BatAPI, NewSession, PreviewRequest, SaveMedia, SummaryRequest, ReviewChange, QAChange } from './contracts';

const api: BatAPI = {
  upgradeQA: (...args: []) => ipcRenderer.invoke('bat:upgrade-qa', ...args),
  getWindowQA: (...args: [string]) => ipcRenderer.invoke('bat:get-window-qa', ...args),
  saveQA: (...args: [string, QAChange]) => ipcRenderer.invoke('bat:save-qa', ...args),
  qaHistory: (...args: [string, number]) => ipcRenderer.invoke('bat:qa-history', ...args),
  upgradeReviews: (...args: []) => ipcRenderer.invoke('bat:upgrade-reviews', ...args),
  getWindowReview: (...args: [string]) => ipcRenderer.invoke('bat:get-window-review', ...args),
  saveReview: (...args: [string, ReviewChange]) => ipcRenderer.invoke('bat:save-review', ...args),
  reviewHistory: (...args: [string, number]) => ipcRenderer.invoke('bat:review-history', ...args),
  setDraftDirty: (...args: [boolean]) => ipcRenderer.invoke('bat:set-draft-dirty', ...args),
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
