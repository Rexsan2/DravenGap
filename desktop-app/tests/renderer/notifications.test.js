// In-app notifications (notifications.js): your profile updated (+ LP, either order, one toast), no duplicates, quiet during
// champion select (held until it ends), champion-select-start (not twice with "Follow my game"), new patch data, Coachless
// done, and the two Settings > Automation options (toasts on by default, Windows notifications off by default).
const H = require('../lib/renderer-harness');
const R = H.results();

const LP = (at, delta, win = true) => ({ kind: 'lp', entry: { at, q: 'RANKED_SOLO_5x5', win, before: { tier: 'GOLD', rank: 'II', lp: 24 }, after: { tier: 'GOLD', rank: 'II', lp: 24 + delta }, delta } });
const MATCHES = (id, extra = {}) => ({ kind: 'matches', owner: true, puuid: 'p1', group: 'all', added: 1, ids: [id], ...extra });

(async () => {
    try {
        const h = await H.boot({ ipc: { 'profile:me': () => ({ ok: true, me: { gameName: 'TestOwner', tagLine: 'META', platform: 'EUW1' }, lcu: true, phase: 'None' }) } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50 && window.DD.notify`, 30000);
        const toasts = () => h.ev(`[...document.querySelectorAll('.dg-toast')].map(t => t.querySelector('span').textContent)`);
        const clear = () => h.ev(`document.querySelectorAll('.dg-toast').forEach(t => t.remove()); 1`);
        const natives = () => h.ev(`window.__n.length`);
        // a stand-in for the HTML5 Notification API (the hidden test window has no Windows toast)
        await h.ev(`window.__n = []; window.Notification = function (title, o) { window.__n.push([title, o && o.body]); }; window.Notification.permission = 'granted'; DD.notify.opts.lpGraceMs = 400; 1`);

        // ---- settings defaults
        const d = await h.ev(`({ toast: document.getElementById('notify-toast-toggle').checked, win: document.getElementById('notify-win-toggle').checked, st: DD.notify.state.toasts, sw: DD.notify.state.windows })`);
        R.ok('Notifications on by default, Windows notifications off by default', d.toast && !d.win && d.st && !d.sw && !('notifyWindows' in h.settings()), { d, saved: h.settings() });

        // ---- LP first, then the profile update: one toast with the LP
        h.send('profile:update', LP(1001, 21));
        await h.sleep(150);
        R.ok('LP alone waits a moment for the profile update (no toast yet)', (await toasts()).length === 0);
        h.send('profile:update', MATCHES('EUW1_100'));
        await h.waitFor(`document.querySelectorAll('.dg-toast').length === 1`, 5000);
        let t = await toasts();
        R.ok('profile updated + LP: one toast with "+21 LP" and "1 new game"', t.length === 1 && /Your profile updated: 1 new game/.test(t[0]) && /\+21 LP/.test(t[0]) && /win/.test(t[0]) && /Gold II 45 LP/.test(t[0]), t);
        h.send('profile:update', LP(1001, 21)); h.send('profile:update', MATCHES('EUW1_100'));
        await h.sleep(900);
        R.ok('the same events again: no second toast', (await toasts()).length === 1, await toasts());
        R.ok('Windows notifications stay off by default', (await natives()) === 0);

        // ---- profile update first, then the LP: added to the same toast
        await clear();
        h.send('profile:update', MATCHES('EUW1_101'));
        await h.waitFor(`document.querySelectorAll('.dg-toast').length === 1`, 5000);
        t = await toasts();
        R.ok('profile update alone: one toast without LP', t.length === 1 && /1 new game/.test(t[0]) && !/LP/.test(t[0]), t);
        h.send('profile:update', LP(1002, -18, false));
        await h.waitFor(`/-18 LP/.test(document.querySelector('.dg-toast span').textContent)`, 5000);
        await h.sleep(700);
        t = await toasts();
        R.ok('LP arriving second is added to that toast (still one toast, no LP-only toast)', t.length === 1 && /-18 LP/.test(t[0]) && /loss/.test(t[0]), t);

        // ---- LP with no profile update (no Riot key): says it alone; somebody else's refresh is ignored
        await clear();
        h.send('profile:update', LP(1003, 15));
        await h.waitFor(`document.querySelectorAll('.dg-toast').length === 1`, 5000);
        t = await toasts();
        R.ok('LP without a profile update: "Ranked game: +15 LP"', t.length === 1 && /^Ranked game: .*\+15 LP/.test(t[0]), t);
        await clear();
        h.send('profile:update', { kind: 'matches', puuid: 'someone-else', added: 3, ids: ['EUW1_900'] });
        h.send('profile:update', { kind: 'profile', puuid: 'p1', profile: {} });
        await h.sleep(500);
        R.ok("other players' refreshes and plain profile updates do not notify", (await toasts()).length === 0);

        // ---- champion select: start toast; everything else waits
        await clear();
        await h.ev(`DD.showView('profile'); 1`);
        h.send('profile:phase', { prev: 'Lobby', next: 'ChampSelect', queueId: 420 });
        await h.waitFor(`document.querySelectorAll('.dg-toast').length >= 1`, 5000);
        await h.sleep(300);
        t = await toasts();
        R.ok('champion select start while on another view: one toast (Follow my game and notifications do not both say it)', t.length === 1 && /^Champion select/.test(t[0]), t);
        await clear();
        h.send('profile:phase', { prev: 'ChampSelect', next: 'Lobby', queueId: 420 });
        await h.sleep(300);
        await clear();
        await h.ev(`DD.showView('draft'); 1`);
        h.send('profile:phase', { prev: 'Lobby', next: 'ChampSelect', queueId: 420 });
        await h.waitFor(`document.querySelectorAll('.dg-toast').length >= 1`, 5000);
        t = await toasts();
        R.ok('champion select start on the draft: "Champion select started: Ranked Solo/Duo."', t.length === 1 && /Champion select started: Ranked Solo\/Duo/.test(t[0]), t);
        await clear();
        h.send('profile:update', LP(1004, 20)); h.send('profile:update', MATCHES('EUW1_102'));
        await h.sleep(800);
        R.ok('quiet during champion select: nothing else pops up', (await toasts()).length === 0 && (await h.ev(`DD.notify.state.held.length`)) === 1, { toasts: await toasts() });
        h.send('profile:phase', { prev: 'ChampSelect', next: 'GameStart', queueId: 420 });
        await h.waitFor(`document.querySelectorAll('.dg-toast').length >= 1`, 5000);
        t = await toasts();
        await h.sleep(500);
        t = await toasts();
        R.ok('after champion select the held profile update shows once, with the LP in it (no separate LP toast)', t.filter(x => /Your profile updated/.test(x)).length === 1 && t.filter(x => /\+20 LP/.test(x)).length === 1 && !t.some(x => /^Ranked game/.test(x)), t);

        // ---- new patch data, scrape refresh, Coachless
        await clear();
        await h.ev(`localStorage.removeItem('dg-notify-patch'); DD.notify.dataReady({ patch: '16.19' }); 1`);
        R.ok('first start only remembers the patch (no toast)', (await toasts()).length === 0);
        await h.ev(`DD.notify.dataReady({ patch: '16.20' }); DD.notify.dataReady({ patch: '16.20' }); 1`);
        t = await toasts();
        R.ok('a new patch: one "Patch 16.20 data is ready." toast, none for the same patch again', t.length === 1 && /Patch 16\.20 data is ready/.test(t[0]), t);
        await clear();
        await h.ev(`DD.notify.dataReady({ kind: 'scrape', saved: 2 }); DD.notify.dataReady({ kind: 'scrape', saved: 0 }); 1`);
        t = await toasts();
        R.ok('an automatic re-download that saved data: one toast', t.length === 1 && /2 saved/.test(t[0]), t);
        await clear();
        await h.ev(`DD.notify.coachless({ champion: 'Ahri', role: 'MIDDLE', visible: true }); 1`);
        R.ok('Coachless done while its Builds page is open: no toast (the page repaints)', (await toasts()).length === 0);
        await h.ev(`DD.notify.coachless({ champion: 'Ahri', role: 'MIDDLE', visible: false }); DD.notify.coachless({ champion: 'Ahri', role: 'MIDDLE', visible: false }); 1`);
        t = await toasts();
        R.ok('Coachless done for the champion you opened: one toast with an Open button', t.length === 1 && /Coachless data for Ahri Mid is ready/.test(t[0]) && (await h.ev(`!!document.querySelector('.dg-toast button')`)), t);

        // ---- Windows notifications (the setting turns them on; only while the window is in the background)
        await clear();
        await h.ev(`const w = document.getElementById('notify-win-toggle'); w.checked = true; w.dispatchEvent(new Event('change')); 1`);
        await h.sleep(300);
        R.ok('the setting is saved and turns Windows notifications on', h.settings().notifyWindows === true && (await h.ev(`DD.notify.state.windows`)) === true, h.settings());
        await h.ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.hasFocus = () => true; 1`);
        h.send('profile:update', MATCHES('EUW1_103'));
        await h.waitFor(`document.querySelectorAll('.dg-toast').length === 1`, 5000);
        R.ok('window in front: the toast only, no Windows notification', (await natives()) === 0);
        await h.ev(`document.hasFocus = () => false; 1`);
        h.send('profile:update', MATCHES('EUW1_104'));
        await h.waitFor(`window.__n.length === 1`, 5000);
        const n = await h.ev(`window.__n`);
        R.ok('window in the background: one Windows notification with the same text', n.length === 1 && n[0][0] === 'DravenGap' && /Your profile updated/.test(n[0][1]), n);

        // ---- turning notifications off silences everything
        await clear();
        await h.ev(`const t = document.getElementById('notify-toast-toggle'); t.checked = false; t.dispatchEvent(new Event('change')); 1`);
        await h.sleep(200);
        h.send('profile:update', MATCHES('EUW1_105'));
        await h.ev(`DD.notify.coachless({ champion: 'Zed', role: 'MIDDLE', visible: false }); 1`);
        await h.sleep(600);
        R.ok('Notifications off: no toast, no Windows notification, Windows checkbox disabled; setting saved', (await toasts()).length === 0 && (await natives()) === 1
            && (await h.ev(`document.getElementById('notify-win-toggle').disabled`)) === true && h.settings().notifyToasts === false, { saved: h.settings() });
        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Error/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
