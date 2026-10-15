import { contextBridge, ipcRenderer } from 'electron';
import type { BatAPI, NewSession } from './contracts';

const api: BatAPI = {
  health: () => ipcRenderer.invoke('bat:health'),
  listSessions: () => ipcRenderer.invoke('bat:list-sessions'),
  createSession: (input: NewSession) => ipcRenderer.invoke('bat:create-session', input),
};
contextBridge.exposeInMainWorld('batAPI', api);
