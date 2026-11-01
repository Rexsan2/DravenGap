// desktop-app/window-helpers.js
// Small pure helpers for the main window (main.js), kept apart so the tests can check them without starting the app:
//   clampToDisplay(bounds, workAreas, primary)  the saved position only while it is still on a connected screen (the mini window's
//                                               rule): otherwise no x/y (Electron centres the window) and a size that fits the
//                                               primary screen's work area
//   maximizeWhenShown(win, isMaximized)         maximize now, or when the window is first shown (a "Start with Windows" start is
//                                               hidden in the tray, and maximize() would show it)
//   isOwnPage(url, files)                       will-navigate: true only for the app's own page file(s), hash and query ignored
const path = require('path');
const { fileURLToPath } = require('url');

// the window's top-left corner (the first 80 x 40 px of its title bar) is on this work area, give or take 20 px
const onArea = (b, a) => b.x >= a.x - 20 && b.y >= a.y - 20 && b.x + 80 <= a.x + a.width && b.y + 40 <= a.y + a.height;

function clampToDisplay(bounds, workAreas, primary) {
    const out = { ...(bounds || {}) };
    const areas = (workAreas || []).filter(a => a && a.width > 0 && a.height > 0);
    if (!areas.length) return out;                                                     // no screen information: as saved
    if (Number.isFinite(out.x) && Number.isFinite(out.y) && areas.some(a => onArea(out, a))) return out;   // still on a screen
    delete out.x; delete out.y;
    const wa = primary && primary.width > 0 && primary.height > 0 ? primary : areas[0];
    if (Number.isFinite(out.width)) out.width = Math.min(out.width, wa.width);
    if (Number.isFinite(out.height)) out.height = Math.min(out.height, wa.height);
    return out;
}

function maximizeWhenShown(win, isMaximized) {
    if (!isMaximized || !win) return;
    if (win.isVisible()) win.maximize();
    else win.once('show', () => { if (!win.isDestroyed()) win.maximize(); });
}

function isOwnPage(url, files) {
    let file;
    try {
        const u = new URL(String(url));
        if (u.protocol !== 'file:') return false;
        u.hash = ''; u.search = '';
        file = fileURLToPath(u);
    } catch (e) { return false; }
    const norm = p => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
    return (files || []).some(f => norm(f) === norm(file));
}

module.exports = { clampToDisplay, maximizeWhenShown, isOwnPage };
