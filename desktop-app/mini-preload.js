// desktop-app/mini-preload.js
// Preload of the mini window (mini-main.js): it can only receive rows and ask to close, focus the main window or pick a row.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mini', {
    onData: cb => ipcRenderer.on('mini:data', (e, payload) => cb(payload)),
    ready: () => ipcRenderer.send('mini-w:ready'),
    close: () => ipcRenderer.send('mini-w:close'),
    focusMain: () => ipcRenderer.send('mini-w:focus-main'),
    pick: (id, mode) => ipcRenderer.send('mini-w:pick', { id: String(id), mode: String(mode || '') })
});
