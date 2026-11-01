// Shell fixes, main-process side (fixer SH): the main window's saved bounds are clamped to a connected screen (C-F8), a hidden
// "Start with Windows" start maximizes when first shown (C-F10), will-navigate only allows the app's own page (C-F7), and the
// mini window's "open DravenGap" / mini:show-main bring the main window back through the tray's show() (C-F16, C-F5).
const path = require('path'), { EventEmitter } = require('events'), { pathToFileURL } = require('url');
const { APP, scratch } = require('../lib/common');
const W = require(APP + 'window-helpers');

let n = 0;
const check = (name, cond, extra) => { n++; if (!cond) { console.log('FAIL |', name, extra === undefined ? '' : JSON.stringify(extra)); process.exitCode = 1; } else console.log('PASS |', name); };

// ---- C-F8 clampToDisplay
const primary = { x: 0, y: 0, width: 1920, height: 1040 }, second = { x: 1920, y: 0, width: 2560, height: 1400 };
let b = W.clampToDisplay({ x: 2100, y: 100, width: 1600, height: 900, isMaximized: false }, [primary, second], primary);
check('a window on a second monitor that is still connected keeps its spot and size', b.x === 2100 && b.y === 100 && b.width === 1600 && b.height === 900 && b.isMaximized === false, b);
b = W.clampToDisplay({ x: 2100, y: 100, width: 2400, height: 1300, isMaximized: false }, [primary], primary);
check('the second monitor unplugged: no x/y (centred on the primary) and a size that fits it', !('x' in b) && !('y' in b) && b.width === 1920 && b.height === 1040, b);
b = W.clampToDisplay({ x: -20000, y: -20000, width: 1280, height: 800 }, [primary], primary);
check('far off-screen: x/y dropped, size kept when it fits', !('x' in b) && !('y' in b) && b.width === 1280 && b.height === 800, b);
b = W.clampToDisplay({ x: -8, y: -8, width: 1936, height: 1056 }, [primary], primary);
check('a few pixels outside (the frame of a snapped window) still counts as on screen', b.x === -8 && b.y === -8 && b.width === 1936, b);
b = W.clampToDisplay({ x: 1900, y: 500, width: 800, height: 600 }, [primary], primary);
check('only the right edge of the window on screen (title bar out of reach): moved', !('x' in b), b);
b = W.clampToDisplay({ x: 50, y: 60, width: 1280, height: 800 }, [], null);
check('no screen information: as saved', b.x === 50 && b.y === 60, b);
b = W.clampToDisplay({ width: 1280, height: 800, isMaximized: true }, [{ x: 0, y: 0, width: 1366, height: 728 }], { x: 0, y: 0, width: 1366, height: 728 });
check('first launch on a small screen: the default size fits it', b.width === 1280 && b.height === 728 && b.isMaximized === true, b);

// ---- C-F10 maximizeWhenShown
function fakeWin(visible) {
    const w = new EventEmitter(); w.max = 0; w.vis = visible;
    w.isVisible = () => w.vis; w.isDestroyed = () => false; w.maximize = () => { w.max++; };
    return w;
}
let w = fakeWin(true); W.maximizeWhenShown(w, true);
check('visible window: maximized at once', w.max === 1);
w = fakeWin(false); W.maximizeWhenShown(w, true);
const before = w.max; w.vis = true; w.emit('show'); w.emit('show');
check('hidden start (tray): not maximized while hidden (that would show it), maximized when first shown, once', before === 0 && w.max === 1, { before, after: w.max });
w = fakeWin(false); W.maximizeWhenShown(w, false); w.emit('show');
check('saved un-maximized: never maximized', w.max === 0);

// ---- C-F7 isOwnPage
const index = path.join(APP, 'index.html'), href = pathToFileURL(index).href;
check('the app page is allowed (also with a hash or query)', W.isOwnPage(href, [index]) && W.isOwnPage(href + '#profile', [index]) && W.isOwnPage(href + '?x=1', [index]));
check('another local file (a dropped picture, replay, html page) is refused', !W.isOwnPage(pathToFileURL(path.join(APP, 'mini.html')).href, [index]) && !W.isOwnPage('file:///C:/Users/x/Pictures/shot.png', [index]) && !W.isOwnPage(pathToFileURL(path.join(scratch('nav'), 'evil.html')).href, [index]));
check('web pages and junk are refused', !W.isOwnPage('https://example.com/', [index]) && !W.isOwnPage('not a url', [index]) && !W.isOwnPage('', [index]));
if (process.platform === 'win32') {
    const lower = href.replace(/^file:\/\/\/([A-Za-z]):/, (m, d) => 'file:///' + d.toLowerCase() + ':').toLowerCase();
    check('drive letter / case differences on Windows still match', W.isOwnPage(lower, [index]), lower);
}

// ---- C-F16 / C-F5 mini-main: the main window comes back through the tray's show()
function registerMini(extra) {
    const ipc = { handlers: {}, listeners: {}, handle(c, f) { this.handlers[c] = f; }, on(c, f) { this.listeners[c] = f; } };
    class FakeBW extends EventEmitter {
        constructor() { super(); this.webContents = { send() {}, setWindowOpenHandler() {}, on() {} }; }
        setAlwaysOnTop() {} setMenu() {} loadFile() {} isDestroyed() { return false; } showInactive() {} getBounds() { return { x: 0, y: 0, width: 300, height: 330 }; } close() {}
    }
    const mini = require(APP + 'mini-main').register({ ipcMain: ipc, BrowserWindow: FakeBW, screen: null, appDir: APP, userDataPath: scratch('mini'), sendToWindow() {}, hidden: true, ...extra });
    mini.open();
    return { ipc, mini, sender: mini.window().webContents };
}
let shown = 0;
let M = registerMini({ getMainWindow: () => null, showMain: () => { shown++; } });
M.ipc.listeners['mini-w:focus-main']({ sender: M.sender });
check('mini window "open DravenGap" uses the tray show() path', shown === 1, { shown });
M.ipc.listeners['mini-w:pick']({ sender: M.sender }, { id: 'Ahri', mode: 'sr' });
check('a row click brings the main window up the same way', shown === 2, { shown });
M.ipc.listeners['mini-w:focus-main']({ sender: { other: true } });
check('focus-main from another window is ignored', shown === 2);
(async () => {
    const r = await M.ipc.handlers['mini:show-main']({});
    check('mini:show-main (Windows notification click) shows the main window', r && r.ok && shown === 3, { r, shown });
    // without a tray (showMain not given): a hidden main window is shown, then focused
    const calls = [];
    const main = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => false, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
    M = registerMini({ getMainWindow: () => main, hidden: false });
    M.ipc.listeners['mini-w:focus-main']({ sender: M.sender });
    check('no tray: a hidden main window is shown before it is focused', calls.join(',') === 'show,focus', calls);
    calls.length = 0;
    M = registerMini({ getMainWindow: () => main, hidden: true });
    M.ipc.listeners['mini-w:focus-main']({ sender: M.sender });
    check('tests (hidden): never shown, only focused', calls.join(',') === 'focus', calls);
    console.log(process.exitCode ? 'SOME FAILED' : `ALL OK (${n})`);
})().catch(e => { console.log('FAIL |', e && e.stack); process.exit(1); });
