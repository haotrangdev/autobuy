'use strict';

// ══════════════════════════════════════════════════════════════════
//  electron/preload.js – Context bridge (renderer ↔ main)
// ══════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose một API nhỏ, an toàn cho renderer (ui-web.js HTML page).
 * Renderer KHÔNG thể truy cập Node.js trực tiếp.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Gửi native notification Windows/macOS/Linux.
   * @param {string} title
   * @param {string} body
   */
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
});