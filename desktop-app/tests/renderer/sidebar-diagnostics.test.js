// Sidebar navigation (E1) and Settings > Diagnostics (E4) in the real window.
const fs = require('fs'), path = require('path');
const { ipcMain } = require('electron');
const H = require('../lib/renderer-harness');
const { APP, scratch } = require('../lib/common');
const R = H.results();

(async () => {
    try {
        let phase = 'None';
        const live = [];
        const h = await H.boot({ settings: { timePeriod: 'patch', rank: 'platinum_plus', gameMode: 'aram-mayhem' }, ipc: {
            'profile:me': () => ({ ok: true, me: null, lcu: true, phase }),
            'profile:diag': () => ({ ok: true, riot: { keySet: true, windows: [{ limit: 19, ms: 1000, used: 3 }, { limit: 95, ms: 120000, used: 40 }], pausedUntil: 0, waiting: 0, requests: 41, rateLimited: 1 },
                opgg: { blockedUntil: Date.now() + 1800e3, error: 'op.gg refused the request (HTTP 403)', actionFailedUntil: 0, playersBackingOff: 0 }, lcu: { up: true, phase: 'Lobby' } }),
            'profile:cache-clear': (e, a) => ({ ok: true, removed: a && a.what === 'opgg-backoff' ? 1 : 7 }),
            'aram:cache-info': () => ({ ok: true, data: { files: [{ file: 'tier.json.gz', bytes: 20480, at: Date.now() - 3600e3 }] } }),
            'aram:cache-clear': () => ({ ok: true, removed: 1 })
        } });
        // the real diagnostics module on a scratch userData; the report goes to a scratch folder
        const ud = scratch('diagui'), out = scratch('diagui-out');
        fs.mkdirSync(path.join(ud, 'profile-cache', 'matches'), { recursive: true });
        fs.writeFileSync(path.join(ud, 'profile-cache', 'matches', 'EUW1_1.json.gz'), Buffer.alloc(4096, 1));
        require(APP + 'diagnostics-main').register({ ipcMain, userDataPath: ud, getLogs: () => ['line 1', 'RGAPI-12345678-aaaa-bbbb-cccc-1234567890ab'], coachless: { rateLimitStatus: () => ({ blockedUntil: 0 }), isRunning: () => false },
            appInfo: () => ({ version: 'test' }), exportDir: () => out });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(400);
        R.ok('saved game mode (ARAM) restored and highlighted', (await h.ev(`DD.currentView() + '|' + document.querySelector('.sb-item.active').dataset.view`)) === 'aram|aram');
        const nav = await h.ev(`(async () => { const out = {}; const click = v => document.querySelector('.sb-item[data-view="' + v + '"]').click();
            for (const v of ['builds', 'champion', 'draft', 'dodgeball']) { click(v); await new Promise(r => setTimeout(r, 120)); out[v] = DD.currentView() + '|' + document.querySelector('.sb-item.active').dataset.view; }
            click('live'); await new Promise(r => setTimeout(r, 300)); out.live = DD.currentView() + '|' + (window.DDProfile && DDProfile.state.tab) + '|' + document.querySelector('.sb-item.active').dataset.view;
            click('profile'); await new Promise(r => setTimeout(r, 300)); out.profile = DD.currentView() + '|' + DDProfile.state.tab + '|' + document.querySelector('.sb-item.active').dataset.view;
            click('draft'); await new Promise(r => setTimeout(r, 120)); return out; })()`);
        R.ok('every sidebar item opens its view and is highlighted', nav.builds === 'builds|builds' && nav.champion === 'champion|champion' && nav.draft === 'draft|draft' && nav.dodgeball === 'dodgeball|dodgeball'
            && nav.live === 'profile|live|live' && nav.profile === 'profile|summary|profile', nav);
        R.ok('choosing Draft saved the game mode', h.settings().gameMode === 'sr', h.settings());
        // in-game dot from the phase push
        h.send('profile:phase', { prev: 'ChampSelect', next: 'InProgress', queueId: 420 });
        await h.sleep(150);
        R.ok('Live game shows a red dot while in game', await h.ev(`document.querySelector('[data-view="live"]').classList.contains('live-on') && getComputedStyle(document.querySelector('.sb-dot')).display === 'block'`));
        h.send('profile:live', { active: false, phase: 'EndOfGame' }); await h.sleep(150);
        R.ok('dot goes away after the game', !(await h.ev(`document.querySelector('[data-view="live"]').classList.contains('live-on')`)));
        // collapse is saved (a 1280 px window with no saved choice starts collapsed)
        const was = await h.ev(`document.body.classList.contains('sb-collapsed')`);
        await h.ev(`document.querySelector('[data-act="collapse"]').click(); 1`); await h.sleep(200);
        const now = await h.ev(`[document.body.classList.contains('sb-collapsed'), getComputedStyle(document.querySelector('.sb-label')).display]`);
        R.ok('starts collapsed on a small window; the toggle flips it and is saved', was === true && now[0] === false && now[1] !== 'none' && h.settings().sidebarCollapsed === false, { was, now, saved: h.settings().sidebarCollapsed });
        R.ok('Settings and How to Use still open from the sidebar', await h.ev(`(async () => { document.getElementById('how-to-use-btn').click(); const a = document.getElementById('how-to-use-modal').style.display === 'flex';
            document.getElementById('how-to-use-close-btn').click(); document.getElementById('settings-btn').click(); await new Promise(r => setTimeout(r, 50)); return a && document.getElementById('settings-modal').style.display === 'flex'; })()`));

        // diagnostics panel
        await h.ev(`document.getElementById('diag-open-btn').click(); 1`);
        const ok = await h.waitFor(`/Riot API/.test(document.getElementById('diag-panel').textContent)`, 8000);
        const text = await h.ev(`document.getElementById('diag-panel').textContent`);
        R.ok('diagnostics panel lists stores, limits and back-off', ok && /Profile: downloaded matches/.test(text) && /4 KB/.test(text) && /3\/19 per 1 s · 40\/95 per 2 min/.test(text)
            && /backing off until/.test(text) && /ARAM Mayhem cache \(1\)/.test(text) && /Draft data: patch archive/.test(text) && /connected/.test(text), text.slice(0, 600));
        const cleared = await h.ev(`(async () => { window.confirm = () => true; document.querySelector('#diag-panel [data-what="aram"]').click();
            for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); const m = document.querySelector('#diag-panel .diag-msg'); if (m && /Cleared/.test(m.textContent)) return m.textContent; } return document.getElementById('diag-panel').textContent.slice(-200); })()`);
        R.ok('a Clear button clears through its module', /Cleared \(1 entry\)/.test(cleared), cleared);
        R.ok('the clear went to aram:cache-clear', h.calls.some(c => c[0] === 'aram:cache-clear'));
        const saved = await h.ev(`(async () => { document.querySelector('#diag-panel [data-diag="export"]').click();
            for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); const m = document.querySelector('#diag-panel .diag-msg'); if (m && /Saved:/.test(m.textContent)) return m.textContent; } return 'timeout'; })()`);
        const files = fs.readdirSync(out);
        const report = files.length ? fs.readFileSync(path.join(out, files[0]), 'utf8') : '';
        R.ok('report saved with the window summary and no key', /Saved:/.test(saved) && files.length === 1 && /draft\.selected: Current Patch/.test(report) && /line 1/.test(report) && !/12345678-aaaa/.test(report), saved + ' | ' + report.slice(0, 300));
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
