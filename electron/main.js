'use strict';

// ══════════════════════════════════════════════════════════════════
//  electron/main.js – Window + Tray (gọi từ index.js khi mode electron)
// ══════════════════════════════════════════════════════════════════

const {
  app, BrowserWindow, Tray, Menu,
  shell, ipcMain, nativeImage, Notification,
} = require('electron');
const path = require('path');

let win  = null;
let tray = null;

// app.isQuitting được init rõ ràng để tránh undefined
app.isQuitting = false;

function getIconPath() {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return path.join(__dirname, 'assets', file);
}

// ── Window ────────────────────────────────────────────────────────

/**
 * @param {number} port - Web UI port (truyền từ index.js, không dùng global)
 */
function createWindow(port) {
  win = new BrowserWindow({
    width:           1280,
    height:          800,
    minWidth:        800,
    minHeight:       600,
    title:           'AutoBuy Dashboard',
    icon:            getIconPath(),
    backgroundColor: '#0a0a0f',
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://localhost:${port}`);
  win.once('ready-to-show', () => win.show());

  // Minimize to tray thay vì đóng hẳn
  win.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Mở link ngoài bằng browser mặc định
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Tray ──────────────────────────────────────────────────────────

/**
 * @param {number} port - Web UI port
 */
function createTray(port) {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('AutoBuy');

  const menu = Menu.buildFromTemplate([
    { label: 'Mở Dashboard',      click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Mở trong Browser',  click: () => shell.openExternal(`http://localhost:${port}`) },
    { type: 'separator' },
    { label: 'Thoát',             click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => { win.show(); win.focus(); });
}

// ── App lifecycle ─────────────────────────────────────────────────

/**
 * @param {number} port - Web UI port
 */
function setupAppLifecycle(port) {
  ipcMain.on('notify', (_event, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body, icon: getIconPath() }).show();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    else win?.show();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { app.isQuitting = true; });
}

module.exports = { createWindow, createTray, setupAppLifecycle };