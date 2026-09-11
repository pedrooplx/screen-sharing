/**
 * Electron main entry. Thin shell: creates one secure window, wires IPC, and
 * makes the app reachable through the OS firewall prompt on first run.
 *
 * All the interesting work lives in src/main/{signaling,net,crypto,election,app}.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session as electronSession } from 'electron';
import log from 'electron-log/main.js';
import { registerIpc, shutdownSession } from './app/ipc.js';
import { registerCaptureHandler } from './app/capture.js';

// `import.meta.dirname` (not just `import.meta.url`) is a Node-specific
// addition that bundler CJS interop does not reliably shim, and the packaged
// build only executes as CJS - this crashed the packaged app with no error
// anywhere (Electron just silently never ran main/index.cjs) while the exact
// same build ran fine unpacked. dirname(fileURLToPath(...)) only relies on
// import.meta.url, which Rollup's CJS output does shim correctly - see
// electron.vite.config.ts.
const here = dirname(fileURLToPath(import.meta.url));

log.initialize();
process.on('uncaughtException', (err) => log.error('uncaughtException (main)', err));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection (main)', reason));

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
    // no `icon:` here: the packaged .exe already carries build/icon.ico as a
    // PE resource (electron-builder.yml `win.icon`), which Windows uses for
    // the taskbar/title bar automatically. Setting a runtime icon path would
    // need build/ inside the asar, which it deliberately isn't (build-time
    // only input, not a runtime asset).
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
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
  window.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error('renderer failed to load', { code, desc, url });
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(here, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // Lock down the renderer: allow only screen/window capture and fullscreen
  // (StreamsPanel's "maximize" button - Element.requestFullscreen() is gated
  // by this same permission, not just BrowserWindow's own fullscreenable;
  // without it the call just rejects silently, which looked like the button
  // "did nothing"), deny everything else (geolocation, notifications, remote
  // media devices, ...).
  const allowed = new Set(['media', 'display-capture', 'fullscreen']);
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
}).catch((err) => log.error('app.whenReady() rejected', err));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  event.preventDefault();
  void shutdownSession().finally(() => {
    app.exit(0);
  });
});
