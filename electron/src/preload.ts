import { contextBridge, ipcRenderer } from 'electron';
import type { BatAPI, NewSession, SaveMedia } from './contracts';

const api: BatAPI = {
  health: (...args: []) => ipcRenderer.invoke('bat:health', ...args),
  listSessions: (...args: []) => ipcRenderer.invoke('bat:list-sessions', ...args),
  createSession: (...args: [NewSession]) => ipcRenderer.invoke('bat:create-session', ...args),
  getMedia: (...args: [string]) => ipcRenderer.invoke('bat:get-media', ...args),
  upgradeMedia: (...args: []) => ipcRenderer.invoke('bat:upgrade-media', ...args),
  chooseMedia: (...args: [string]) => ipcRenderer.invoke('bat:choose-media', ...args),
  importStatus: (...args: [string]) => ipcRenderer.invoke('bat:import-status', ...args),
  cancelImport: (...args: [string]) => ipcRenderer.invoke('bat:cancel-import', ...args),
  saveMedia: (...args: [string, SaveMedia]) => ipcRenderer.invoke('bat:save-media', ...args),
};
contextBridge.exposeInMainWorld('batAPI', api);
