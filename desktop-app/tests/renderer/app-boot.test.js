// Boots the REAL main.js: appData and Downloads point at a scratch folder (main.js pins userData to <appData>/draftdiff, so
// %APPDATA%\draftdiff is never touched), every window main.js creates is forced hidden, and R2 / Data Dragon go to a stub on
// 127.0.0.1 (anything else is cancelled). Checks that the app starts and that the IPC modules main.js wires up answer.
const Module = require('module');
const fs = require('fs'), path = require('path'), http = require('http');
const electron = require('electron');
const { app, session } = electron;
const { APP, scratch, fixture } = require('../lib/common');

const root = scratch('boot');
app.setPath('appData', root);
app.setPath('downloads', path.join(root, 'downloads'));

// main.js gets a BrowserWindow that never shows (and never maximizes / focuses). Relative files load from desktop-app, as
// they do when the app runs (the app path here is this test's folder).
const RealBW = electron.BrowserWindow;
const windows = [];
class HiddenWindow extends RealBW {
    constructor(o = {}) { super({ ...o, show: false }); windows.push(this); }
    show() {} showInactive() {} maximize() {} focus() {}
    loadFile(f, o) { return super.loadFile(path.isAbsolute(f) ? f : path.join(APP, f), o); }
}
const alive = () => windows.filter(w => !w.isDestroyed());
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

app.whenReady().then(async () => {
    try {
        const stats = fixture('data/champion_stats_patch_platplus.json');
        const champJson = fixture('data/ddragon_champion.json', null);
        const meta = JSON.stringify({ last_updated_utc: new Date().toISOString(), patch: '16.19.1', total_games_by_dataset: { patch_platinum_plus: 120000, '30_platinum_plus': 900000 } });
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
        require(APP + 'main.js');
        let w = null;
        for (let i = 0; i < 100 && !w; i++) { await new Promise(r => setTimeout(r, 100)); w = alive()[0] || null; }
        ok('main.js opened its window (hidden)', !!w && !w.isVisible());
        const logs = [];
        w.webContents.on('console-message', (e, ...a) => { const m = e && e.message != null ? e.message : a[1]; logs.push(String(m)); });
        await new Promise(r => (w.webContents.isLoading() ? w.webContents.once('did-finish-load', r) : r()));
        const ev = c => w.webContents.executeJavaScript(c);
        let ready = false;
        for (let i = 0; i < 100 && !ready; i++) { await new Promise(r => setTimeout(r, 150)); ready = await ev(`document.querySelectorAll('.champion-tile').length > 50`).catch(() => false); }
        ok('the draft loads (champion grid)', ready);
        ok('userData is the scratch draftdiff folder', fs.existsSync(path.join(root, 'draftdiff')), fs.readdirSync(root));
        const r = await ev(`(async () => {
            const f = window.electronAPI.feature, out = {};
            out.diag = await f.invoke('diag:info'); out.mini = await f.invoke('mini:state'); out.prof = await f.invoke('profile:diag'); out.lcu = await f.invoke('lcu:status');
            out.aram = await f.invoke('aram:cache-info'); out.settings = await window.electronAPI.getSettings();
            out.open = await f.invoke('mini:open'); await new Promise(r => setTimeout(r, 800)); out.state = await f.invoke('mini:state'); out.close = await f.invoke('mini:close');
            out.blocked = await f.invoke('nope:x').then(() => 'allowed', e => 'blocked');
            return out; })()`);
        ok('diag:info answers with the userData stores', r.diag.ok && r.diag.stores.length === 8 && r.diag.app.electron === process.versions.electron, r.diag.app);
        ok('profile:diag answers (no key in the scratch folder)', r.prof.ok && r.prof.riot.keySet === false, r.prof.riot);
        ok('lcu:status and aram:cache-info answer', !!r.lcu && r.aram.ok);
        ok('the mini window opens and closes', r.mini.open === false && r.open.open === true && r.state.open === true && r.close.open === false, { open: r.open, state: r.state });
        ok('unknown channel prefixes stay blocked by the preload', r.blocked === 'blocked');
        await new Promise(res => setTimeout(res, 300));
        ok('only the main window is left', alive().length === 1 && windows.length === 2, { alive: alive().length, created: windows.length });
        ok('no uncaught errors', !logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), logs.filter(l => /Uncaught|Error/.test(l)).slice(-5));
    } catch (e) { ok('exception', false, e.stack); }
    finish();
});
