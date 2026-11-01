// Shell fixes, renderer side (fixer SH): draft shortcuts after a checkbox click (C-F11), the patch-day card (C-F9), "Copy as image"
// without the toasts (C-F17), a Windows notification click (C-F5), a dropped file does nothing (C-F7), the region of a Riot ID
// typed without one: Ctrl+K, Multi-search, Settings > Account (B1-F12), and the saved game mode vs Follow my game at start (C-F14).
const H = require('../lib/renderer-harness');
const R = H.results();

(async () => {
    try {
        // ---------------------------------------------------------------- C-F14: started during a ranked champion select
        // Saved game mode ARAM Mayhem, the client is in champion select (queue 420): Follow my game keeps the draft, the start-up
        // restore of the saved mode must not move to ARAM.
        let h = await H.boot({ settings: { timePeriod: 'patch', rank: 'platinum_plus', gameMode: 'aram-mayhem' }, ipc: {
            'profile:me': () => ({ ok: true, me: null, lcu: true, phase: 'ChampSelect' })
        } });
        h.send('profile:phase', { prev: 'Lobby', next: 'ChampSelect', queueId: 420 });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50`, 30000);
        await h.sleep(800);
        R.ok('C-F14 started in a ranked champion select with ARAM saved: stays on the draft', (await h.ev(`DD.currentView()`)) === 'draft', await h.ev(`DD.currentView()`));
        await h.close();

        // ---------------------------------------------------------------- everything else: one boot
        const mode = { owner: { ok: true, owner: { gameName: 'Me', tagLine: 'NA1', platform: 'NA1', puuid: null }, source: 'client' }, me: { ok: false } };
        const caught = {};
        h = await H.boot({ ipc: {
            'profile:owner': () => mode.owner,
            'profile:me': () => mode.me,
            'mini:show-main': () => ({ ok: true }),
            'patch:notes': () => ({ ok: true, patch: '16.19', url: '', champions: { Ahri: { kind: 'buff', changes: [{ attr: 'Q damage', before: '40', after: '50', dir: 1 }] } } }),
            // the toast layer at the moment the window is captured
            'copy-region': async e => { caught.vis = await e.sender.executeJavaScript(`getComputedStyle(document.querySelector('.dg-toasts')).visibility`); return { ok: true, width: 10, height: 10 }; }
        } });
        await h.waitFor(`document.querySelectorAll('.champion-tile').length > 50 && window.DD.notify && window.DD.patchDay`, 30000);
        await h.sleep(500);

        // ---- C-F11: a focused checkbox is not typing
        const spy = `(() => { window.__sug = 0; const b = document.querySelector("[data-side='left'][data-role='JUNGLE'] .suggest-btn"); if (!b.__spy) { b.__spy = 1; b.addEventListener('click', () => { window.__sug++; }); } return 1; })()`;
        const press = (sel, code, key) => h.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true })); return document.activeElement === el; })()`);
        await h.ev(spy);
        const focused = await press('#my-pool-toggle', 'Digit2', '2');
        R.ok('C-F11 "2" works right after ticking My pool (focused checkbox)', focused && (await h.ev(`window.__sug`)) === 1, { focused, sug: await h.ev(`window.__sug`) });
        await h.ev(spy);
        await h.ev(`(() => { const i = document.createElement('input'); i.type = 'text'; i.id = '__txt'; document.body.appendChild(i); return 1; })()`);
        await press('#__txt', 'Digit2', '2');
        R.ok('C-F11 typing "2" in a text box is still not a shortcut', (await h.ev(`window.__sug`)) === 0);
        await h.ev(`document.getElementById('__txt').remove(); document.activeElement && document.activeElement.blur(); 1`);

        // ---- C-F9: the patch-day card
        await h.ev(`DD.myPool = () => ['Ahri']; DD.showView('draft'); 1`);
        await h.waitFor(`window.DDPatchNotes && !!DDPatchNotes.all()`, 8000);
        let shown = await h.ev(`DD.patchDay.show()`);
        await h.waitFor(`!!document.querySelector('#patch-day-modal .pd-row img')`, 8000);
        await h.ev(spy);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', bubbles: true, cancelable: true })); 1`);
        R.ok('C-F9 draft shortcuts do not fire under the card', shown && (await h.ev(`window.__sug`)) === 0, { shown, sug: await h.ev(`window.__sug`) });
        await h.ev(`document.querySelector('#patch-day-modal .pd-row img').click(); 1`);
        await h.sleep(300);
        let pd = await h.ev(`({ view: DD.currentView(), card: document.getElementById('patch-day-modal').style.display })`);
        R.ok('C-F9 a click on a champion picture closes the card and opens the champion page', pd.view === 'champion' && pd.card === 'none', pd);
        await h.ev(`DD.showView('draft'); DD.patchDay.show()`);
        await h.waitFor(`document.getElementById('patch-day-modal').style.display === 'flex'`, 5000);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
        R.ok('C-F9 Esc closes the card', (await h.ev(`document.getElementById('patch-day-modal').style.display`)) === 'none');

        // ---- C-F17: "Copy as image" hides the toasts while capturing
        await h.ev(`DD.toast('Copied it as an image: paste it in Discord or anywhere.'); 1`);
        const cp = await h.ev(`(async () => { const el = document.createElement('div'); el.style.cssText = 'position:fixed;left:10px;top:10px;width:200px;height:100px'; document.body.appendChild(el);
            const r = await DD.copyAsImage(el, 'it'); el.remove(); return { ok: r.ok, after: document.querySelector('.dg-toasts').style.visibility }; })()`);
        R.ok('C-F17 the toast layer is hidden at capture time and visible again afterwards', cp.ok && caught.vis === 'hidden' && cp.after === '', { cp, caught });
        await h.ev(`document.querySelectorAll('.dg-toast').forEach(t => t.remove()); 1`);

        // ---- C-F5: a click on a Windows notification shows the window and does what the toast's button does
        await h.ev(`window.__n = []; window.Notification = function (title, o) { this.title = title; this.body = o && o.body; window.__n.push(this); }; window.Notification.permission = 'granted';
            DD.notify.state.windows = true; DD.notify.opts.winOnlyWhenUnfocused = false; 1`);
        await h.ev(`DD.showView('draft'); 1`);
        h.send('profile:update', { kind: 'matches', owner: true, puuid: 'p1', group: 'all', added: 1, ids: ['EUW1_555'] });
        await h.waitFor(`window.__n.length === 1`, 5000);
        const before = h.calls.filter(c => c[0] === 'mini:show-main').length;
        await h.ev(`window.__n[0].onclick(); 1`);
        await h.sleep(400);
        const nc = { view: await h.ev(`DD.currentView()`), show: h.calls.filter(c => c[0] === 'mini:show-main').length - before };
        R.ok('C-F5 notification click: the main window is shown (mini:show-main) and your profile opens', nc.show === 1 && nc.view === 'profile', nc);
        await h.ev(`DD.notify.state.windows = false; DD.showView('draft'); 1`);

        // ---- C-F7: a dropped file does nothing; text dragged into a box is left alone
        const dr = await h.ev(`(() => {
            const fire = (type, dt) => { const e = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; };
            const files = new DataTransfer(); files.items.add(new File(['x'], 'shot.png', { type: 'image/png' }));
            const text = new DataTransfer(); text.setData('text/plain', 'Ahri');
            return { fileOver: fire('dragover', files), fileDrop: fire('drop', files), textOver: fire('dragover', text), textDrop: fire('drop', text) }; })()`);
        R.ok('C-F7 a file dragged over / dropped on the window is refused, text drags are not touched', dr.fileOver && dr.fileDrop && !dr.textOver && !dr.textDrop, dr);

        // ---- B1-F12: the region of a Riot ID typed without one
        await h.ev(`DD.openPalette(); (() => { const i = document.querySelector('.dg-pal-in'); i.value = 'Friend#NA1'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
        const lookup = () => h.calls.filter(c => c[0] === 'profile:lookup' && c[1][0] && c[1][0].gameName === 'Friend').map(c => c[1][0].platform);
        for (let i = 0; i < 60 && !lookup().length; i++) await h.sleep(100);
        R.ok('B1-F12 Ctrl+K "Friend#NA1" looks up on the client\'s region (NA1), not EUW1', lookup()[0] === 'NA1', { lookup: lookup(), saved: h.settings() });
        await h.ev(`DD.showView('scout'); 1`);
        const ms = await h.waitFor(`(document.getElementById('ms-platform') || {}).value === 'NA1'`, 5000);
        R.ok('B1-F12 Multi-search: the Region box shows the client\'s region before any search', ms, await h.ev(`(document.getElementById('ms-platform') || {}).value`));
        await h.ev(`DD.showView('draft'); document.getElementById('settings-btn').click(); 1`);
        const st = await h.waitFor(`document.getElementById('account-region-select').value === 'NA1'`, 5000);
        R.ok('B1-F12 Settings > Account: no saved account, the Region shows the client\'s region', st, await h.ev(`document.getElementById('account-region-select').value`));
        await h.ev(`document.getElementById('settings-close-btn').click(); DD.patchSettings({ profileAccount: { gameName: 'Saved', tagLine: 'KR1', platform: 'KR' } })`);
        await h.ev(`document.getElementById('settings-btn').click(); 1`);
        await h.sleep(500);
        R.ok('B1-F12 Settings > Account: a saved account keeps its own region', (await h.ev(`document.getElementById('account-region-select').value`)) === 'KR');
        await h.ev(`document.getElementById('settings-close-btn').click(); 1`);
        // the order: client (profile:owner, then profile:me), then the saved account, then EUW1
        mode.owner = { ok: false }; mode.me = { ok: true, me: { gameName: 'Me', tagLine: 'KR9', platform: 'KR' }, lcu: true, phase: 'None' };
        const order = { me: await h.ev(`DD.defaultPlatform()`) };
        mode.me = { ok: false };
        await h.ev(`DDProfile.state.owner = null; DD.patchSettings({ profileAccount: { gameName: 'Saved', tagLine: 'BR1', platform: 'BR1' } })`);
        order.saved = await h.ev(`DD.defaultPlatform()`);
        await h.ev(`DD.patchSettings({ profileAccount: null })`);
        order.none = await h.ev(`DD.defaultPlatform()`);
        R.ok('B1-F12 fallbacks: profile:me, then Settings > Default account, then EUW1', order.me === 'KR' && order.saved === 'BR1' && order.none === 'EUW1', order);

        R.ok('no uncaught errors', !h.logs.some(l => /Uncaught|TypeError|ReferenceError/.test(l)), h.logs.filter(l => /Uncaught|Error/.test(l)).slice(-5));
    } catch (e) { R.ok('exception', false, e.stack); }
    R.finish();
})();
