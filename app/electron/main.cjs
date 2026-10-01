const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const os = require('os');

// Embedded server (bundled with sql.js). Exposes startServer({dataDir, port}).
const { startServer } = require(path.join(__dirname, '..', 'server-dist', 'server.cjs'));

let server = null;
let mainWin = null;

// Allow microphone, camera and screen-capture access for WebRTC voice/video.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone' || permission === 'display-capture');
  });

  // Required in newer Electron for getDisplayMedia (esp. with system audio):
  // handle the request and grant the chosen video source + system audio.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    try {
      const { desktopCapturer } = require('electron');
      desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 200, height: 120 } })
        .then((sources) => {
          // default: prefer the first screen
          const chooser = () => new Promise((resolve) => {
            const screen = sources.find((s) => s.id.startsWith('screen'));
            resolve(screen || sources[0]);
          });
          chooser().then((selected) => {
            if (!selected) { callback({}); return; }
            callback({ video: selected, audio: 'loopback' });
          });
        })
        .catch(() => callback({}));
    } catch (e) {
      callback({});
    }
  });
});

// List desktop sources (screens + app windows) for the custom picker.
ipcMain.handle('sources:list', async () => {
  const { desktopCapturer } = require('electron');
  const { nativeImage } = require('electron');
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL(),
    }));
  } catch (e) {
    return [];
  }
});

ipcMain.handle('open:external', async (event, url) => {
  try {
    const { shell } = require('electron');
    await shell.openExternal(String(url));
    return true;
  } catch (e) { return false; }
});

ipcMain.on('server:url', (event) => {
  // In server mode the embedded server exists; otherwise return '' and let the
  // client use its saved network address (⚙ settings) or localhost default.
  event.returnValue = server ? `ws://localhost:${server.port}/ws` : '';
});

ipcMain.handle('lan:ips', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push({ name, address: net.address });
    }
  }
  return ips;
});

// Resolve stable data dir
function dataDir() {
  return path.join(app.getPath('userData'), 'app-data');
}

// Server mode: this instance hosts the shared server (set MULTITOOL_SERVER_MODE=1).
const IS_SERVER = process.env.MULTITOOL_SERVER_MODE === '1';
const SERVER_PORT = Number(process.env.MULTITOOL_SERVER_PORT || 3000);

async function boot() {
  if (IS_SERVER) {
    server = await startServer({ dataDir: dataDir(), port: SERVER_PORT });
    console.log(`[main] shared server on port ${SERVER_PORT}`);
  }
  createWindow();
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 801,
    minHeight: 493,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    title: 'MultiVoice',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWin.loadURL(devUrl);
  } else {
    mainWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // capture renderer errors for debugging
  mainWin.webContents.on('console-message', (e, level, message, line, sourceId) => {
    try {
      require('fs').appendFileSync(path.join(app.getPath('userData'), 'renderer.log'),
        `[${level}] ${sourceId}:${line} ${message}\n`);
    } catch {}
  });
  mainWin.webContents.on('render-process-gone', (e, details) => {
    try {
      require('fs').appendFileSync(path.join(app.getPath('userData'), 'renderer.log'),
        `[gone] ${details.reason}\n`);
    } catch {}
  });

  mainWin.on('closed', () => { mainWin = null; });
}

app.whenReady().then(() => {
  boot().catch((err) => {
    console.error('boot failed:', err);
    createWindow(); // still open window so user sees something
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) { try { server.close(); } catch {} }
  if (process.platform !== 'darwin') app.quit();
});