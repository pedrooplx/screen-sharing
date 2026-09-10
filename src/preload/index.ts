/**
 * The only bridge between renderer and main. Exposes a small typed surface on
 * `window.erros`; the renderer has no other access to Node or the network.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  type ErrosApi,
  IPC,
  type SessionSnapshot,
} from '../shared/ipc.js';

const api: ErrosApi = {
  hostRoom: (req) => ipcRenderer.invoke(IPC.hostRoom, req),
  joinRoom: (req) => ipcRenderer.invoke(IPC.joinRoom, req),
  leaveRoom: () => ipcRenderer.invoke(IPC.leaveRoom),
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  listSources: () => ipcRenderer.invoke(IPC.listSources),
  setCaptureSource: (id) => ipcRenderer.invoke(IPC.setSource, id),
  onUpdate: (cb: (snapshot: SessionSnapshot) => void) => {
    const handler = (_e: unknown, snapshot: SessionSnapshot) => cb(snapshot);
    ipcRenderer.on(IPC.onUpdate, handler);
    return () => ipcRenderer.removeListener(IPC.onUpdate, handler);
  },
};

contextBridge.exposeInMainWorld('erros', api);
