/**
 * Electron main entry. Thin shell: creates one secure window, wires IPC, and
 * makes the app reachable through the OS firewall prompt on first run.
 *
 * All the interesting work lives in src/main/{signaling,net,crypto,election,app}.
 */

import { join } from 'node:path';
import { app, BrowserWindow, session as electronSession } from 'electron';
import log from 'electron-log/main.js';
import { registerIpc, shutdownSession } from './app/ipc.js';
import { registerCaptureHandler } from './app/capture.js';

log.initialize();

let window: BrowserWindow | null = null;

function createWindow(): void {
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: '#14161a',
    title: 'erros-share',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // Lock down the renderer: allow only screen/window capture, deny everything
  // else (geolocation, notifications, remote media devices, ...).
  const allowed = new Set(['media', 'display-capture']);
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(allowed.has(permission));
  });
  electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    allowed.has(permission),
  );

  registerCaptureHandler();
  registerIpc(() => window);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  event.preventDefault();
  void shutdownSession().finally(() => {
    app.exit(0);
  });
});
