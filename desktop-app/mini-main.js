// desktop-app/mini-main.js
// The compact champ-select window (A5): a small frameless, always-on-top window that shows the top picks for your slot (or
// the ARAM Mayhem ranking) next to the League client. The main window computes the rows (mini-feed.js) and this module only
// relays them; the mini window has its own minimal preload (mini-preload.js) and no access to anything else.
//   mini:open / mini:close / mini:toggle ()  -> { ok, open }
//   mini:state  ()          -> { ok, open }
//   mini:update (payload)   -> { ok }   latest rows from the main window, forwarded to the mini window as 'mini:data'
// From the mini window (its own channels, not the feature bridge): 'mini-w:ready' (send the last rows), 'mini-w:close',
// 'mini-w:focus-main', 'mini-w:pick' {id} (bring the main window up and tell it which row was clicked).
// Pushes to the main window: 'mini:state' { open }, 'mini:pick' { id, mode }.
const fs = require('fs');
const path = require('path');

const DEFAULT = { width: 300, height: 330 };

function register(deps) {
    const { ipcMain, BrowserWindow, appDir, userDataPath, getMainWindow, sendToWindow } = deps;
    const getScreen = () => { try { return typeof deps.screen === 'function' ? deps.screen() : deps.screen; } catch (e) { return null; } }; // only usable once the app is ready
    const boundsFile = path.join(userDataPath, 'mini-window.json');
    let win = null, last = null;

    const readBounds = () => { try { return JSON.parse(fs.readFileSync(boundsFile, 'utf8')); } catch (e) { return null; } };
    const saveBounds = () => { try { if (win && !win.isDestroyed()) fs.writeFileSync(boundsFile, JSON.stringify(win.getBounds())); } catch (e) { /* best effort */ } };
    // the saved spot, if it is still on a screen; otherwise the top-right corner of the primary screen
    function initialBounds() {
        const b = readBounds(), screen = getScreen();
        const areas = screen ? screen.getAllDisplays().map(d => d.workArea) : [];
        const fits = b && areas.some(a => b.x >= a.x - 20 && b.y >= a.y - 20 && b.x + 80 <= a.x + a.width && b.y + 40 <= a.y + a.height);
        if (fits) return { x: b.x, y: b.y, width: Math.max(220, b.width || DEFAULT.width), height: Math.max(150, b.height || DEFAULT.height) };
        const wa = screen ? screen.getPrimaryDisplay().workArea : { x: 0, y: 0, width: 1280, height: 800 };
        return { x: wa.x + wa.width - DEFAULT.width - 24, y: wa.y + 80, ...DEFAULT };
    }
    const state = () => ({ ok: true, open: !!(win && !win.isDestroyed()) });
    const announce = () => sendToWindow('mini:state', { open: state().open });

    function open() {
        if (win && !win.isDestroyed()) { if (!deps.hidden) win.showInactive(); return state(); }
        win = new BrowserWindow({
            ...initialBounds(), minWidth: 220, minHeight: 150, frame: false, alwaysOnTop: true, resizable: true, maximizable: false, fullscreenable: false,
            show: false, title: 'DravenGap mini', backgroundColor: '#121212', icon: path.join(appDir, 'assets/dravengap.png'),
            webPreferences: { preload: path.join(appDir, 'mini-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
        });
        win.setAlwaysOnTop(true, 'floating');
        win.setMenu(null);
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', e => e.preventDefault());
        win.once('ready-to-show', () => {   // never steals focus from the client (tests: hidden); on top again once visible (Windows)
            if (win && !win.isDestroyed() && !deps.hidden) { win.showInactive(); win.setAlwaysOnTop(true, 'floating'); }
        });
        let t = null;
        const later = () => { clearTimeout(t); t = setTimeout(saveBounds, 400); };
        win.on('move', later); win.on('resize', later);
        win.on('close', saveBounds);
        win.on('closed', () => { win = null; announce(); });
        win.loadFile(path.join(appDir, 'mini.html'));
        announce();
        return state();
    }
    function close() { if (win && !win.isDestroyed()) win.close(); return { ok: true, open: false }; }

    ipcMain.handle('mini:open', () => open());
    ipcMain.handle('mini:close', () => close());
    ipcMain.handle('mini:toggle', () => (state().open ? close() : open()));
    ipcMain.handle('mini:state', () => state());
    ipcMain.handle('mini:update', (e, payload) => {
        if (!payload || typeof payload !== 'object') return { ok: false };
        last = payload;
        if (win && !win.isDestroyed()) win.webContents.send('mini:data', payload);
        return { ok: true };
    });
    // from the mini window
    const fromMini = e => !!(win && !win.isDestroyed() && e.sender === win.webContents);
    ipcMain.on('mini-w:ready', e => { if (fromMini(e) && last) e.sender.send('mini:data', last); });
    ipcMain.on('mini-w:close', e => { if (fromMini(e)) close(); });
    const focusMain = () => { const m = getMainWindow && getMainWindow(); if (m && !m.isDestroyed()) { if (m.isMinimized()) m.restore(); m.focus(); } };
    ipcMain.on('mini-w:focus-main', e => { if (fromMini(e)) focusMain(); });
    ipcMain.on('mini-w:pick', (e, p) => {
        if (!fromMini(e) || !p || typeof p.id !== 'string' || p.id.length > 40) return;
        focusMain();
        sendToWindow('mini:pick', { id: p.id, mode: p.mode === 'aram' ? 'aram' : 'sr' });
    });
    return { open, close, isOpen: () => state().open, window: () => win };
}

module.exports = { register };
