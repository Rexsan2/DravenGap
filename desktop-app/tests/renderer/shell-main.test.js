// Shell fixes in the REAL main.js (fixer SH), booted as in app-boot.test.js: appData points at a scratch folder (main.js pins userData
// to <appData>/draftdiff), every window is forced hidden, the network goes to a stub on 127.0.0.1 or is cancelled. Started like
// "Start with Windows" (--hidden) with a saved window that was maximized on a monitor that is gone:
//   C-F6  the main window keeps its timers in the tray (backgroundThrottling: false)
//   C-F8  the saved off-screen position is dropped
//   C-F10 not maximized while hidden, maximized when first shown; closing a never-shown window does not save its hidden state
//   C-F7  will-navigate refuses any file:// page but the app's own index.html
//   C-F5 / C-F16  mini:show-main brings the main window up through the tray's show()
const Module = require('module');
const fs = require('fs'), path = require('path'), http = require('http'), { pathToFileURL } = require('url');
const electron = require('electron');
const { app, session } = electron;
const { APP, scratch, fixture } = require('../lib/common');

const root = scratch('shellmain');
app.setPath('appData', root);
app.setPath('downloads', path.join(root, 'downloads'));
const ud = path.join(root, 'draftdiff');
fs.mkdirSync(ud, { recursive: true });
const savedState = { x: -20000, y: -20000, width: 1100, height: 700, isMaximized: true };
fs.writeFileSync(path.join(ud, 'window-state.json'), JSON.stringify(savedState));
// tray mode off: closing really closes (no hide, no "still running" Windows notification during the test)
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ trayMode: false, onboardingDone: true, timePeriod: 'patch', rank: 'platinum_plus' }));
process.argv.push('--hidden');   // tray-main: started by "Start with Windows"

const RealBW = electron.BrowserWindow;
const windows = [], opts = [], calls = [];
class HiddenWindow extends RealBW {
    constructor(o = {}) { super({ ...o, show: false }); windows.push(this); opts.push(o); }
    show() { calls.push('show'); } showInactive() {} maximize() { calls.push('maximize'); } focus() { calls.push('focus'); }
    loadFile(f, o) { return super.loadFile(path.isAbsolute(f) ? f : path.join(APP, f), o); }
}
const origLoad = Module._load;
Module._load = function (request, parent) {
    const m = origLoad.apply(this, arguments);
    if (request === 'electron' && parent && path.dirname(parent.filename) + path.sep === APP) return new Proxy(m, { get: (t, k) => (k === 'BrowserWindow' ? HiddenWindow : t[k]) });
    return m;
};

const rows = [];
const ok = (name, cond, extra) => rows.push([cond ? 'PASS' : 'FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)]);
const finish = () => { for (const r of rows) console.log(r.join(' | ')); const f = rows.filter(r => r[0] === 'FAIL').length; console.log('SUMMARY', rows.length - f, 'pass', f, 'fail'); app.exit(f ? 1 : 0); };
setTimeout(() => { ok('finished in time', false); finish(); }, 90000);
process.on('unhandledRejection', e => ok('unhandled rejection', false, String(e && e.stack || e)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    try {
        const stats = fixture('data/champion_stats_patch_platplus.json');
        const champJson = fixture('data/ddragon_champion.json', null);
        const meta = JSON.stringify({ last_updated_utc: new Date().toISOString(), patch: '16.19.1', total_games_by_dataset: { patch_platinum_plus: 120000 } });
        const srv = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x'), send = (c, b) => { res.writeHead(c, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(b); };
            if (u.pathname === '/r2/metadata.json') return send(200, meta);
            if (/champion_stats\.json$/.test(u.pathname)) return send(200, stats);
            if (/matchup_winrates\.json$/.test(u.pathname)) return send(200, '{}');
            if (u.pathname === '/dd/api/versions.json') return send(200, '["16.19.1"]');
            if (/champion\.json$/.test(u.pathname)) return send(200, champJson);
            send(404, '{}');
        });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        const port = srv.address().port;
        session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (d, cb) => {
            const u = new URL(d.url);
            if (u.hostname === '127.0.0.1') return cb({});
            if (/\.r2\.dev$/.test(u.hostname)) return cb({ redirectURL: `http://127.0.0.1:${port}/r2${u.pathname}` });
            if (u.hostname === 'ddragon.leagueoflegends.com') return cb({ redirectURL: `http://127.0.0.1:${port}/dd${u.pathname}` });
            cb({ cancel: true });
        });
        process.env.DG_NO_TRAY = '1';
        require(APP + 'main.js');
        let w = null;
        for (let i = 0; i < 100 && !w; i++) { await sleep(100); w = windows.find(x => !x.isDestroyed()) || null; }
        ok('main.js opened its window', !!w);
        const o = opts[0] || {};
        ok('C-F6 the main window is created with backgroundThrottling: false', o.webPreferences && o.webPreferences.backgroundThrottling === false, o.webPreferences);
        ok('C-F10 started with --hidden: created hidden', o.show === false, { show: o.show });
        ok('C-F8 the saved position on a monitor that is gone is dropped (centred instead)', o.x === undefined && o.y === undefined && o.width > 0 && o.height > 0, { x: o.x, y: o.y, width: o.width, height: o.height });
        ok('C-F10 not maximized while hidden in the tray (maximize() would show it)', !calls.includes('maximize'), calls);
        await new Promise(r => (w.webContents.isLoading() ? w.webContents.once('did-finish-load', r) : r()));

        // C-F7: will-navigate
        const nav = url => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; w.webContents.emit('will-navigate', ev, url); return ev.prevented; };
        const own = pathToFileURL(path.join(APP, 'index.html')).href;
        ok('C-F7 a dropped local file (file://) is refused', nav('file:///C:/Users/someone/Pictures/shot.png') === true && nav(pathToFileURL(path.join(root, 'page.html')).href) === true);
        ok('C-F7 the app\'s own page is allowed', nav(own) === false && nav(own + '#x') === false);

        // C-F10: closing a window that was never shown keeps the saved state
        const stateFile = path.join(ud, 'window-state.json');
        w.emit('close', { preventDefault() {} });
        await sleep(100);
        ok('C-F10 closing before it was ever shown does not overwrite the saved state', JSON.stringify(JSON.parse(fs.readFileSync(stateFile, 'utf8'))) === JSON.stringify(savedState), fs.readFileSync(stateFile, 'utf8'));
        w.emit('show');
        ok('C-F10 maximized the first time it is shown (from the tray)', calls.filter(c => c === 'maximize').length === 1, calls);
        w.emit('close', { preventDefault() {} });
        await sleep(100);
        const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        ok('C-F10 once shown, closing saves the window state again', after.x !== savedState.x && typeof after.isMaximized === 'boolean', after);

        // C-F5 / C-F16: mini:show-main goes through tray-main's show()
        calls.length = 0;
        const r = await w.webContents.executeJavaScript(`window.electronAPI.feature.invoke('mini:show-main')`);
        ok('C-F5/C-F16 mini:show-main shows and focuses the main window (tray show())', r && r.ok && calls.includes('show') && calls.includes('focus'), { r, calls });
    } catch (e) { ok('exception', false, e.stack); }
    finish();
});
