// Mini window (A5): the real mini-main.js opens a (hidden) always-on-top window; the main window feeds it the top picks for your
// lane from a fake champion select (assigned position = middle), switches to ARAM rows in the ARAM view, a row click comes
// back to the main window, and the auto-open setting follows the client's phase.
const fs = require('fs'), path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const H = require('../lib/renderer-harness');
const { APP } = require('../lib/common');
const R = H.results();

const session = { localPlayerCellId: 0, actions: [[]], theirTeam: [{ cellId: 5, championId: 238, championPickIntent: 0, assignedPosition: '' }],
    myTeam: [{ cellId: 0, championId: 0, championPickIntent: 0, assignedPosition: 'middle' }, { cellId: 1, championId: 157, championPickIntent: 0, assignedPosition: 'top' }] };

(async () => {
    try {
        let mini = null;
        const h = await H.boot({ ipc: { 'get-champ-select': () => session } });
        const made = [];
        class SpyWindow extends BrowserWindow { constructor(o) { super(o); made.push(o); } }   // records the options mini-main uses
        mini = require(APP + 'mini-main').register({ ipcMain, BrowserWindow: SpyWindow, screen: () => require('electron').screen, appDir: APP, userDataPath: h.userData,
            getMainWindow: () => h.w, sendToWindow: (c, p) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(c, p); }, hidden: true });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(1500);   // Live Tracking places the picks and learns your lane
        const r = await h.ev(`DD.mini.open()`);
        R.ok('opens from DD.mini', r && r.open === true, r);
        R.ok('sidebar button shows it is open', await h.ev(`document.querySelector('[data-act="mini"]').classList.contains('active')`));
        const mw = mini.window();
        const o = made[0] || {};
        R.ok('created always on top, frameless, sandboxed, own preload, never shown in tests', mw && o.alwaysOnTop === true && o.frame === false && o.webPreferences.sandbox === true && /mini-preload\.js$/.test(o.webPreferences.preload) && !mw.isVisible(), { alwaysOnTop: o.alwaysOnTop, frame: o.frame });
        const ev = code => mw.webContents.executeJavaScript(code);
        let ok = false;
        for (let i = 0; i < 60 && !ok; i++) { await h.sleep(150); try { ok = await ev(`document.querySelectorAll('#list .row').length >= 3`); } catch (e) { /* loading */ } }
        const sr = await ev(`({ title: document.getElementById('title').textContent, sub: document.getElementById('sub').textContent, rows: [...document.querySelectorAll('#list .row')].map(r => r.dataset.id), bar: !!document.querySelector('#list .bar2 i'), head: document.getElementById('head').textContent })`);
        R.ok('shows the top picks for your lane (Mid) with Exp WR bars and PP', ok && /Mid \(your lane\)/.test(sr.title) && sr.rows.length >= 3 && sr.rows.length <= 6 && sr.bar && /Exp WR/.test(sr.head) && /PP/.test(sr.head), sr);
        R.ok('picked champions are not offered', !sr.rows.includes('Yasuo') && !sr.rows.includes('Zed'), sr.rows);
        R.ok('your lane comes from the client (Yasuo is the assigned top laner, not your pick)', /vs Zed/.test(sr.sub) && !/picked/.test(sr.sub), sr.sub);
        R.ok('the mini window uses its own narrow bridge', await ev(`typeof window.electronAPI === 'undefined' && typeof window.mini.pick === 'function'`));
        // the rows match what the draft would recommend for Mid
        const top = await h.ev(`DD.miniDraftData().then(d => d.rows.map(r => r.id))`);
        R.ok('same order as DD.miniDraftData', JSON.stringify(top) === JSON.stringify(sr.rows), { top, rows: sr.rows });
        // a click on a row comes back to the draft with that champion's why panel open
        await ev(`document.querySelector('#list .row').click(); 1`);
        await h.sleep(900);
        const back = await h.ev(`({ view: DD.currentView(), target: (document.querySelector('.role-slot.selected') || {dataset:{}}).dataset.role, why: !!document.querySelector('#recommendation-list li[data-champion-name="${sr.rows[0]}"] .why-panel') })`);
        R.ok('row click selects your lane in the draft and opens its why panel', back.view === 'draft' && back.target === 'MIDDLE' && back.why, back);
        // ARAM view -> ARAM rows
        await h.ev(`DD.showView('aram'); 1`);
        ok = false;
        for (let i = 0; i < 40 && !ok; i++) { await h.sleep(150); ok = await ev(`document.body.classList.contains('aram')`); }
        R.ok('switches to ARAM rows in the ARAM view', ok && /ARAM Mayhem/.test(await ev(`document.getElementById('title').textContent`)));
        await h.ev(`DD.showView('draft'); 1`);
        // closing from the mini window
        await ev(`document.getElementById('close').click(); 1`);
        await h.sleep(400);
        R.ok('closes from its own × and the main window knows', !mini.window() && (await h.ev(`DD.mini.isOpen()`)) === false);
        R.ok('position is remembered', fs.existsSync(path.join(h.userData, 'mini-window.json')));
        // automation
        await h.ev(`(() => { const t = document.getElementById('mini-auto-toggle'); t.checked = true; t.dispatchEvent(new Event('change')); return 1; })()`);
        await h.sleep(200);
        R.ok('auto-open setting saved', h.settings().miniAuto === true, h.settings());
        h.send('profile:phase', { prev: 'Lobby', next: 'ChampSelect', queueId: 420 }); await h.sleep(600);
        const openedAuto = !!mini.window();
        h.send('profile:phase', { prev: 'ChampSelect', next: 'InProgress', queueId: 420 }); await h.sleep(600);
        R.ok('opens in champion select and closes when the game starts', openedAuto && !mini.window(), { openedAuto });
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
