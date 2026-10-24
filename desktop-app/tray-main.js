// DravenGap in the background: a tray icon, closing the window hides it to the tray (so automatic rune import, the post-game
// refresh, notifications and the mini window keep working), one instance only (starting it again shows the window), and
// "Start with Windows" (opens hidden in the tray). Settings (settings.json): trayMode (default on), startWithWindows (default off).
const { Tray, Menu, nativeImage, Notification } = require('electron');
const fs = require('fs');

function register({ app, getMainWindow, createWindow, settingsFilePath, iconPath, openMini }) {
    let tray = null, quitting = false, hintShown = false;
    const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')) || {}; } catch (e) { return {}; } };
    const trayMode = () => readSettings().trayMode !== false;
    const startedHidden = process.argv.includes('--hidden');

    function show() {
        let w = getMainWindow();
        if (!w) { createWindow(); w = getMainWindow(); }
        if (!w) return;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
    }
    function quit() { quitting = true; app.quit(); }

    function applyLogin(settings) {
        // only the installed app registers itself (a dev run would register electron.exe)
        if (!app.isPackaged) return;
        try { app.setLoginItemSettings({ openAtLogin: !!settings.startWithWindows, args: ['--hidden'] }); } catch (e) { /* not supported */ }
    }
    function menu() {
        const s = readSettings();
        return Menu.buildFromTemplate([
            { label: 'Open DravenGap', click: show },
            { label: 'Mini window', click: () => openMini && openMini() },
            { type: 'separator' },
            { label: 'Keep running in the tray when closed', type: 'checkbox', checked: s.trayMode !== false, click: i => save({ trayMode: i.checked }) },
            { label: 'Start with Windows', type: 'checkbox', checked: !!s.startWithWindows, enabled: app.isPackaged, click: i => save({ startWithWindows: i.checked }) },
            { type: 'separator' },
            { label: 'Quit DravenGap', click: quit }
        ]);
    }
    function save(patch) {
        const next = { ...readSettings(), ...patch };
        try { fs.writeFileSync(settingsFilePath, JSON.stringify(next, null, 2)); } catch (e) { return; }
        settingsChanged(next);   // the Settings checkboxes read the file again when the window is next focused
    }
    function ensureTray() {
        if (tray || process.env.DG_NO_TRAY) return;   // tests: no icon in the taskbar
        let img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
        tray = new Tray(img);
        tray.setToolTip('DravenGap');
        tray.on('click', show);
        tray.on('double-click', show);
        tray.setContextMenu(menu());
    }
    // called by main.js whenever settings.json is saved
    function settingsChanged(settings) {
        applyLogin(settings);
        if (tray) tray.setContextMenu(menu());
    }

    // one instance: a second start shows the running one
    if (!app.requestSingleInstanceLock()) { app.quit(); return { single: false }; }
    app.on('second-instance', show);
    app.on('before-quit', () => { quitting = true; });

    // the main window: closing hides it while tray mode is on
    function attach(win) {
        ensureTray();
        win.on('close', e => {
            if (quitting || !trayMode()) return;
            e.preventDefault();
            win.hide();
            if (!hintShown && Notification.isSupported()) {
                hintShown = true;
                new Notification({ title: 'DravenGap is still running', body: 'It keeps importing runes and following your games from the tray. Right-click the tray icon to quit.', silent: true }).show();
            }
        });
    }
    app.whenReady().then(() => { ensureTray(); applyLogin(readSettings()); });

    return { single: true, attach, settingsChanged, startedHidden, isQuitting: () => quitting, show };
}

module.exports = { register };
