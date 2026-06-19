'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, protocol, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const { readLibrary } = require('./lib/podcasts');
const { listDrives } = require('./lib/drives');
const { exportEpisodes } = require('./lib/exporter');
const { scan } = require('./lib/scanner');

let mainWindow = null;

// Custom scheme used by the in-app audio preview to stream local files with
// HTTP range support (so seeking works and large files don't load fully).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lappods-media',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
};

function registerMediaProtocol() {
  protocol.handle('lappods-media', (request) => {
    let filePath;
    try {
      filePath = new URL(request.url).searchParams.get('p');
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!filePath) return new Response('bad request', { status: 400 });

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (!stat.isFile()) return new Response('not found', { status: 404 });

    const total = stat.size;
    const type = AUDIO_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = request.headers.get('Range');

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end || start >= total) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
      },
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  registerMediaProtocol();

  // Show the branded icon in the dock when running unpackaged (`npm start`).
  // Packaged builds get their icon from the bundled .icns automatically.
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    const dockIcon = path.join(__dirname, '..', 'build', 'icon.png');
    try {
      app.dock.setIcon(dockIcon);
    } catch {}
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---------------------------------------------------------------

ipcMain.handle('library:read', async () => {
  return readLibrary();
});

ipcMain.handle('drives:list', async () => {
  return listDrives();
});

ipcMain.handle('drives:choose', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a destination folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('scanner:scan', async (event, options) => {
  const onProgress = (p) => event.sender.send('scanner:progress', p);
  return scan(options || {}, onProgress);
});

ipcMain.handle('export:run', async (event, { items, options }) => {
  const onProgress = (p) => {
    event.sender.send('export:progress', p);
  };
  return exportEpisodes(items, { ...options, onProgress });
});

ipcMain.handle('shell:reveal', async (event, targetPath) => {
  if (targetPath) shell.showItemInFolder(targetPath);
});

// Native right-click menu for a file row.
ipcMain.handle('menu:file', async (event, filePath) => {
  if (!filePath) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show in Finder',
      click: () => shell.showItemInFolder(filePath),
    },
    {
      label: 'Open with Default App',
      click: () => shell.openPath(filePath),
    },
  ]);
  menu.popup({ window: win });
});
